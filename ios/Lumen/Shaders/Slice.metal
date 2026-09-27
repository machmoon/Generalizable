// Slice.metal — MPR slice rendering for Lumen.
//
// Prior art: NiiVue (github.com/niivue/niivue), packages/niivue/src/shader-srcs.ts:
//   - `vertSliceMMShader`: the quad carries in-plane texture coords and the slice index is a
//     uniform; `axCorSag` picks which volume axis the slice is along. We do the same with
//     `plane` + `slice`, except our vertex positions come from SliceViewport.voxelToView on the
//     CPU so overlays line up exactly.
//   - `kFragSliceHead` main(): background sample, then overlay colour blended on top, and the
//     `overlayOutlineWidth` outline test that looks at the in-plane face neighbours only
//     (`axCorSag != 2` → R/L, `!= 1` → A/P, `!= 0` → S/I). We use that neighbour pattern for
//     the label outline. Windowing (low/high → 0..1) replaces NiiVue's colormap lookup since
//     our CT texture holds raw HU (r16Sint), which can't be filtered, so we bilinear by hand.
#include <metal_stdlib>
using namespace metal;

struct SliceUniforms {
    float winLow;
    float winHigh;
    float labelOpacity;
    float outline;          // 0 = fill only, 1 = fill + outline
    int   plane;            // 0 axial, 1 coronal, 2 sagittal (Swift Plane order)
    int   slice;
    int   selected;         // organ raw value, 0 = none
    int   hasLabels;
    uint  mask[8];          // 256-bit visible-organ mask
};

struct SliceVertex {
    float2 position;        // NDC
    float2 uv;              // in-plane voxel coords (u axis, v axis)
};

struct VOut {
    float4 position [[position]];
    float2 uv;
};

vertex VOut sliceVertex(uint vid [[vertex_id]], constant SliceVertex *verts [[buffer(0)]]) {
    VOut o;
    o.position = float4(verts[vid].position, 0, 1);
    o.uv = verts[vid].uv;
    return o;
}

// (u, v, slice) → canonical voxel (x, y, z)
static inline int3 toVoxel(int plane, int u, int v, int s) {
    if (plane == 0) return int3(u, v, s);      // axial:    u=x, v=y, n=z
    if (plane == 1) return int3(u, s, v);      // coronal:  u=x, v=z, n=y
    return int3(s, u, v);                      // sagittal: u=y, v=z, n=x
}

static inline float huAt(texture3d<short, access::read> ct, int plane, int2 uv, int s, int3 dims) {
    int3 p = clamp(toVoxel(plane, uv.x, uv.y, s), int3(0), dims - 1);
    return float(ct.read(uint3(p)).r);
}

static inline uint labelAt(texture3d<uint, access::read> lab, int plane, int2 uv, int s, int3 dims) {
    int3 p = toVoxel(plane, uv.x, uv.y, s);
    if (any(p < int3(0)) || any(p >= dims)) return 0;
    return lab.read(uint3(p)).r;
}

static inline bool visible(constant SliceUniforms &U, uint l) {
    return l != 0 && ((U.mask[l >> 5] >> (l & 31)) & 1u) != 0;
}

fragment float4 sliceFragment(VOut in [[stage_in]],
                              constant SliceUniforms &U [[buffer(0)]],
                              texture3d<short, access::read> ct [[texture(0)]],
                              texture3d<uint, access::read> labels [[texture(1)]],
                              texture1d<float, access::read> lut [[texture(2)]]) {
    int3 dims = int3(ct.get_width(), ct.get_height(), ct.get_depth());
    int s = U.slice;

    // Manual bilinear in-plane (integer texture → no hardware filtering).
    float2 f = in.uv - 0.5;
    int2 i0 = int2(floor(f));
    float2 t = f - float2(i0);
    float h00 = huAt(ct, U.plane, i0, s, dims);
    float h10 = huAt(ct, U.plane, i0 + int2(1, 0), s, dims);
    float h01 = huAt(ct, U.plane, i0 + int2(0, 1), s, dims);
    float h11 = huAt(ct, U.plane, i0 + int2(1, 1), s, dims);
    float hu = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
    float g = saturate((hu - U.winLow) / max(U.winHigh - U.winLow, 1e-3));
    float3 color = float3(g);

    if (U.hasLabels != 0) {
        int2 c = int2(floor(in.uv));
        uint l = labelAt(labels, U.plane, c, s, dims);
        if (visible(U, l)) {
            float3 oc = lut.read(l).rgb;
            bool sel = (U.selected != 0) && (uint(U.selected) == l);
            bool dim = (U.selected != 0) && !sel;
            float a = U.labelOpacity * (sel ? 1.6 : (dim ? 0.5 : 1.0));
            // Outline: NiiVue-style in-plane face-neighbour test.
            bool edge = false;
            if (U.outline > 0.5 || sel) {
                edge = labelAt(labels, U.plane, c + int2(1, 0), s, dims) != l
                    || labelAt(labels, U.plane, c - int2(1, 0), s, dims) != l
                    || labelAt(labels, U.plane, c + int2(0, 1), s, dims) != l
                    || labelAt(labels, U.plane, c - int2(0, 1), s, dims) != l;
            }
            if (edge) a = sel ? 1.0 : max(a, 0.85);
            color = mix(color, sel && edge ? float3(1.0) * 0.3 + oc * 0.7 : oc, saturate(a));
        }
    }
    return float4(color, 1);
}
