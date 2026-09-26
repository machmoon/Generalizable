// Slice.metal
// Oblique reslice of the case volume along the cut plane (PRD A1, A4; design spec section 2).
//
// Prior art followed (source read, not docs):
//   Kitware/vtk-js Sources/Rendering/OpenGL/ImageResliceMapper/index.js
//     - world -> texture-coordinate transform per fragment, then an
//       `any(greaterThan(tc, 1)) || any(lessThan(tc, 0))` bounds test that paints a background
//       colour and returns (the "tcoordFSImpl" block).
//     - labelmap outline: step to in-plane neighbours along two tangent vectors and mark the
//       fragment as border when a neighbour is out of bounds or carries a different label
//       (the "pixelOnBorder" loop).
//   Slicer Libs/MRML/Core/vtkMRMLSegmentationDisplayNode.h (fill + outline look; design spec
//     cites L384-386). We use fill 0.65 over a 0.35-dimmed CT per the design spec.
// Deviation from vtk.js: vtk.js steps outline neighbours by one TEXEL; we step by one screen
// PIXEL so the outline is exactly 1 px at any zoom (design spec: "1 px outline").
//
// Keep SliceUniforms in sync with SliceRenderer.swift (eight float4, 128 bytes).
// SliceRenderer.swift embeds a copy of this file as a runtime-compile fallback; keep it in sync.

#include <metal_stdlib>
using namespace metal;

struct SliceUniforms {
    float4 origin;     // xyz: plane origin (mm, RAS)
    float4 uAxis;      // xyz: in-plane +u (screen right)
    float4 vAxis;      // xyz: in-plane +v (screen up)
    float4 volOrigin;  // xyz: meta.origin_mm
    float4 spacing;    // xyz: meta.spacing_mm
    float4 dims;       // xyz: meta.dims
    float4 window;     // x,y: active [level, width]; z,w: soft [level, width] for layers mode
    float4 params;     // x: half width mm, y: half height mm, z: mm per pixel, w: mode (0 layers, 1 ct)
};

struct SliceVOut {
    float4 position [[position]];
    float2 ndc;
};

// Full-screen triangle from vertex_id; no vertex buffer.
vertex SliceVOut sliceVertex(uint vid [[vertex_id]]) {
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    SliceVOut o;
    o.ndc = p * 2.0 - 1.0;
    o.position = float4(o.ndc, 0.0, 1.0);
    return o;
}

static inline float3 sliceMM(constant SliceUniforms& U, float2 uv) {
    return U.origin.xyz + uv.x * U.uAxis.xyz + uv.y * U.vAxis.xyz;
}

// Same math as CaseBundle.textureCoord(forMM:): ((p - origin) / spacing + 0.5) / dims.
static inline float3 sliceTC(constant SliceUniforms& U, float3 mm) {
    return ((mm - U.volOrigin.xyz) / U.spacing.xyz + 0.5) / U.dims.xyz;
}

static inline bool sliceInside(float3 tc) {
    return !(any(tc > float3(1.0)) || any(tc < float3(0.0)));
}

// Nearest label via texture.read (never a filtering sampler). floor(tc * dims) == round(voxel).
static inline uint sliceLabel(texture3d<uint, access::read> labels, constant SliceUniforms& U, float3 tc) {
    int3 dimsI = int3(U.dims.xyz);
    int3 idx = clamp(int3(floor(tc * U.dims.xyz)), int3(0), dimsI - 1);
    return labels.read(uint3(idx)).r;
}

// Label as seen in layers mode: hidden (peeled) labels read as background 0.
static inline uint sliceVisibleLabel(texture3d<uint, access::read> labels, constant SliceUniforms& U,
                                     constant float4* table, float3 tc) {
    uint l = sliceLabel(labels, U, tc);
    return table[l & 255u].a > 0.5 ? l : 0u;
}

static inline float sliceWindow(float hu, float level, float width) {
    float w = max(width, 1.0);
    return clamp((hu - (level - 0.5 * w)) / w, 0.0, 1.0);
}

fragment float4 sliceFragment(SliceVOut in [[stage_in]],
                              constant SliceUniforms& U [[buffer(0)]],
                              constant float4* table [[buffer(1)]],
                              texture3d<float, access::sample> ct [[texture(0)]],
                              texture3d<uint, access::read> labels [[texture(1)]]) {
    constexpr sampler linearSampler(coord::normalized, filter::linear, address::clamp_to_edge);

    const float3 outsideColor = float3(28.0, 28.0, 30.0) / 255.0;   // #1C1C1E
    const float2 uv = in.ndc * U.params.xy;
    const float px = U.params.z;
    const float2 offs[4] = { float2(px, 0), float2(-px, 0), float2(0, px), float2(0, -px) };

    const float3 tc = sliceTC(U, sliceMM(U, uv));

    if (!sliceInside(tc)) {
        // volumeEdge: #FFFFFF at 12%, 1 px, drawn on the outside pixel next to the volume.
        bool edge = false;
        for (int i = 0; i < 4; i++) {
            if (sliceInside(sliceTC(U, sliceMM(U, uv + offs[i])))) { edge = true; }
        }
        return float4(edge ? mix(outsideColor, float3(1.0), 0.12) : outsideColor, 1.0);
    }

    const float hu = ct.sample(linearSampler, tc).r * 32767.0;

    if (U.params.w > 0.5) {
        // CT mode: windowed grey, no tint.
        float g = sliceWindow(hu, U.window.x, U.window.y);
        return float4(g, g, g, 1.0);
    }

    // Layers mode.
    const float3 base = float3(sliceWindow(hu, U.window.z, U.window.w) * 0.35);
    const uint l = sliceVisibleLabel(labels, U, table, tc);
    if (l == 0u) {
        return float4(base, 1.0);
    }

    float3 c = table[l].rgb;
    if (dot(c, float3(0.2126, 0.7152, 0.0722)) < 0.18) {
        c = mix(c, float3(1.0), 0.30);
    }

    bool border = false;
    for (int i = 0; i < 4; i++) {
        float3 ntc = sliceTC(U, sliceMM(U, uv + offs[i]));
        if (!sliceInside(ntc) || sliceVisibleLabel(labels, U, table, ntc) != l) { border = true; }
    }
    if (border) {
        return float4(mix(c, float3(1.0), 0.15), 1.0);
    }
    return float4(mix(base, c, 0.65), 1.0);
}
