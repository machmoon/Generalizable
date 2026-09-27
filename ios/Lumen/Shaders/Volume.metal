// Lumen GPU volume raycaster (DVR + MIP), one full-screen triangle, ray per pixel.
//
// Prior art (read before writing):
// - NiiVue, github.com/niivue/niivue, packages/niivue/src/shader-srcs.ts (kRenderFunc /
//   kRenderTail): step = one voxel along the ray ("sliceSize"), opacity correction
//   stepSize/sliceSize, jittered ray start, a fast first pass at 1.9x step to skip empty
//   space then back up one fast step, clip planes turned into a [tNear, tFar] sample range
//   (`clipSampleRange`), early termination at alpha 0.95, front-to-back compositing, and
//   8-bit volume textures scaled from cal_min/cal_max.
// - Transfer function shaped after 3D Slicer's "CT-AAA" preset (github.com/Slicer/Slicer,
//   Modules/Loadable/VolumeRendering/Resources/presets.xml), built on the CPU in
//   VolumeRenderer.swift, plus a faint soft-tissue ramp so the body reads as translucent.
// - Plane colours: axial red, sagittal yellow, coronal green (BodyMaps / Cornerstone3D,
//   same as SliceView).
//
// World space is millimetres, canonical RAS axes (+x Right, +y Anterior, +z Superior),
// centred on the volume centre. Texture coord = p / extent + 0.5.
#include <metal_stdlib>
using namespace metal;

constant float kVolHUMin = -1000.0;
constant float kVolHURange = 2500.0;

struct VolumeUniforms {
    float4 eye;        // xyz
    float4 right;      // xyz, w = tan(fov/2) * aspect
    float4 up;         // xyz, w = tan(fov/2)
    float4 forward;    // xyz, w = tangent per pixel (for constant-width lines)
    float4 halfExtent; // xyz mm, w = step mm
    float4 dims;       // xyz voxels, w = reference step mm for opacity
    float4 spacing;    // xyz mm, w = mode (0 DVR, 1 MIP)
    float4 clip;       // xyz unit normal (mm space), w = plane offset d: keep dot(n,p)+d <= 0
    float4 cursorMM;   // xyz
    float4 window;     // x lo (normalised), y hi, z label tint on, w show planes
    float4 misc;       // x clip on, y unused, z selected organ, w organ alpha
    uint4 organMask;   // bits 0..63 of visible organ ids
};

struct VolumeVOut {
    float4 position [[position]];
    float2 ndc;
};

vertex VolumeVOut volumeVertex(uint vid [[vertex_id]]) {
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    VolumeVOut o;
    o.ndc = p * 2.0 - 1.0;
    o.position = float4(o.ndc, 0.0, 1.0);
    return o;
}

/// r16Sint HU -> r8Unorm over [kVolHUMin, kVolHUMin + kVolHURange] (NiiVue-style 8-bit).
kernel void volumeCTToUnorm8(texture3d<short, access::read> src [[texture(0)]],
                             texture3d<float, access::write> dst [[texture(1)]],
                             uint3 gid [[thread_position_in_grid]]) {
    if (gid.x >= dst.get_width() || gid.y >= dst.get_height() || gid.z >= dst.get_depth()) return;
    float hu = float(src.read(gid).r);
    dst.write(float4(saturate((hu - kVolHUMin) / kVolHURange)), gid);
}

static inline float volHash(float2 p) {
    return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
}

static inline bool volOrganVisible(uint lab, uint4 m) {
    if (lab == 0 || lab > 63) return false;
    return lab < 32 ? ((m.x >> lab) & 1u) != 0 : ((m.y >> (lab - 32)) & 1u) != 0;
}

static inline uint volLabelAt(texture3d<uint> labels, float3 tc, float3 dims) {
    uint3 c = uint3(clamp(tc * dims, float3(0.0), dims - 1.0));
    return labels.read(c).r;
}

fragment float4 volumeFragment(VolumeVOut in [[stage_in]],
                               constant VolumeUniforms &U [[buffer(0)]],
                               texture3d<float> ct [[texture(0)]],
                               texture3d<uint> labels [[texture(1)]],
                               texture1d<float> organLUT [[texture(2)]],
                               texture1d<float> tf [[texture(3)]]) {
    constexpr sampler lin(filter::linear, address::clamp_to_edge);
    float3 bg = mix(float3(0.01, 0.012, 0.018), float3(0.07, 0.08, 0.10), in.ndc.y * 0.5 + 0.5);

    float3 eye = U.eye.xyz;
    float3 dir = normalize(U.forward.xyz + in.ndc.x * U.right.w * U.right.xyz + in.ndc.y * U.up.w * U.up.xyz);
    float3 h = U.halfExtent.xyz;
    float3 dims = U.dims.xyz;

    // Ray / box slabs.
    float3 sd = select(dir, float3(1e-7), abs(dir) < 1e-7);
    float3 inv = 1.0 / sd;
    float3 t0 = (-h - eye) * inv, t1 = (h - eye) * inv;
    float3 tmin = min(t0, t1), tmax = max(t0, t1);
    float tNear = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
    float tFar = min(min(tmax.x, tmax.y), tmax.z);
    if (tFar <= tNear) return float4(bg, 1.0);

    // Clip plane -> sample range (NiiVue clipSampleRange).
    bool cutFace = false;
    if (U.misc.x > 0.5) {
        float3 n = U.clip.xyz;
        float s0 = dot(n, eye) + U.clip.w;
        float dn = dot(n, dir);
        if (abs(dn) < 1e-6) {
            if (s0 > 0.0) return float4(bg, 1.0);
        } else {
            float th = -s0 / dn;
            if (dn > 0.0) tFar = min(tFar, th);
            else if (th > tNear) { tNear = th; cutFace = true; }
        }
        if (tFar <= tNear) return float4(bg, 1.0);
    }

    // MPR plane outlines + crosshair lines, as (t, rgba) events along the ray.
    float lt[3] = {1e30, 1e30, 1e30};
    float4 lc[3] = {float4(0), float4(0), float4(0)};
    int nl = 0;
    if (U.window.w > 0.5) {
        const float3 pc[3] = {float3(1.0, 0.85, 0.1), float3(0.2, 0.85, 0.3), float3(1.0, 0.23, 0.19)};
        for (int k = 0; k < 3; k++) {
            if (abs(dir[k]) < 1e-6) continue;
            float th = (U.cursorMM[k] - eye[k]) / dir[k];
            if (th < tNear || th > tFar) continue;
            float3 p = eye + dir * th;
            float w = max(U.forward.w * th * 1.3, 0.3);
            float a = 0.0;
            for (int j = 0; j < 3; j++) {
                if (j == k) continue;
                if (abs(p[j]) > h[j] - w) a = max(a, 0.7);                 // plane outline
                else if (abs(p[j] - U.cursorMM[j]) < w * 0.7) a = max(a, 0.35); // crosshair
            }
            if (a > 0.0) { lt[nl] = th; lc[nl] = float4(pc[k], a); nl++; }
        }
        // sort 3
        for (int i = 0; i < 2; i++) for (int j = 0; j < 2 - i; j++) if (lt[j] > lt[j + 1]) {
            float tt = lt[j]; lt[j] = lt[j + 1]; lt[j + 1] = tt;
            float4 cc = lc[j]; lc[j] = lc[j + 1]; lc[j + 1] = cc;
        }
    }

    float step = U.halfExtent.w;
    float3 inv2h = 0.5 / h;
    float jitter = volHash(in.position.xy);
    bool tint = U.window.z > 0.5;
    uint selected = uint(U.misc.z);

    // ---------------- MIP ----------------
    if (U.spacing.w > 0.5) {
        float best = 0.0, bestT = tNear;
        for (float t = tNear + jitter * step; t < tFar; t += step) {
            float v = ct.sample(lin, (eye + dir * t) * inv2h + 0.5).r;
            if (v > best) { best = v; bestT = t; }
        }
        float g = saturate((best - U.window.x) / max(U.window.y - U.window.x, 1e-5));
        float3 col = float3(g);
        if (tint) {
            uint lab = volLabelAt(labels, (eye + dir * bestT) * inv2h + 0.5, dims);
            if (volOrganVisible(lab, U.organMask)) {
                float3 oc = organLUT.read(lab).rgb;
                col = mix(col, oc * max(g, 0.35), lab == selected ? 0.7 : 0.45);
            }
        }
        for (int i = 0; i < nl; i++) col = mix(col, lc[i].rgb, lc[i].a * 0.6);
        return float4(col, 1.0);
    }

    // ---------------- DVR ----------------
    float organAlpha = U.misc.w;
    float ref = U.dims.w;
    float t = tNear;
    // Fast pass over empty space (NiiVue: 1.9x step, then back up one fast step).
    float fast = step * 1.9;
    for (; t < tFar; t += fast) {
        float3 tc = (eye + dir * t) * inv2h + 0.5;
        float v = ct.sample(lin, tc).r;
        if (tf.sample(lin, v).a > 0.0005) break;
        if (tint && volOrganVisible(volLabelAt(labels, tc, dims), U.organMask)) break;
    }
    t = max(tNear, t - fast) + jitter * step;

    float4 acc = float4(0.0);
    float3 L = -dir;
    float3 dt = 1.0 / dims;
    int li = 0;
    for (; t < tFar; t += step) {
        while (li < nl && lt[li] <= t) {
            float a = lc[li].a;
            acc.rgb += (1.0 - acc.a) * a * lc[li].rgb;
            acc.a += (1.0 - acc.a) * a;
            li++;
        }
        float3 tc = (eye + dir * t) * inv2h + 0.5;
        float v = ct.sample(lin, tc).r;
        float4 c = tf.sample(lin, v);
        uint organ = 0;
        if (tint) {
            uint lab = volLabelAt(labels, tc, dims);
            if (volOrganVisible(lab, U.organMask)) {
                organ = lab;
                float3 oc = organLUT.read(lab).rgb;
                c.rgb = mix(c.rgb, oc, 0.8);
                c.a = max(c.a, organAlpha * (lab == selected ? 2.5 : 1.0));
            }
        }
        if (c.a < 0.0005) continue;
        float a = 1.0 - pow(1.0 - min(c.a, 0.999), step / ref);
        float3 col = c.rgb;
        if (c.a > 0.02) {
            float3 N = float3(0, 0, 1);
            float shade = 0.0;
            if (cutFace && t - tNear < 1.5 * step) {
                N = U.clip.xyz; shade = 1.0;
            } else if (organ != 0) {
                // Normal from the binary organ mask (the CT has little contrast at organ borders).
                float3 o = 1.5 * dt;
                float gx = float(volLabelAt(labels, tc + float3(o.x, 0, 0), dims) == organ) - float(volLabelAt(labels, tc - float3(o.x, 0, 0), dims) == organ);
                float gy = float(volLabelAt(labels, tc + float3(0, o.y, 0), dims) == organ) - float(volLabelAt(labels, tc - float3(0, o.y, 0), dims) == organ);
                float gz = float(volLabelAt(labels, tc + float3(0, 0, o.z), dims) == organ) - float(volLabelAt(labels, tc - float3(0, 0, o.z), dims) == organ);
                float3 g = float3(gx, gy, gz) / U.spacing.xyz;
                float gm = length(g);
                if (gm > 1e-4) { N = g / gm; shade = 1.0; }
                else {
                    // interior of the organ: fall back to the CT gradient
                    float3 g2 = float3(ct.sample(lin, tc + float3(dt.x, 0, 0)).r - ct.sample(lin, tc - float3(dt.x, 0, 0)).r,
                                       ct.sample(lin, tc + float3(0, dt.y, 0)).r - ct.sample(lin, tc - float3(0, dt.y, 0)).r,
                                       ct.sample(lin, tc + float3(0, 0, dt.z)).r - ct.sample(lin, tc - float3(0, 0, dt.z)).r) / (2.0 * U.spacing.xyz);
                    float gm2 = length(g2);
                    N = g2 / max(gm2, 1e-6); shade = smoothstep(0.01, 0.05, gm2);
                }
            } else {
                float3 g = float3(ct.sample(lin, tc + float3(dt.x, 0, 0)).r - ct.sample(lin, tc - float3(dt.x, 0, 0)).r,
                                  ct.sample(lin, tc + float3(0, dt.y, 0)).r - ct.sample(lin, tc - float3(0, dt.y, 0)).r,
                                  ct.sample(lin, tc + float3(0, 0, dt.z)).r - ct.sample(lin, tc - float3(0, 0, dt.z)).r) / (2.0 * U.spacing.xyz);
                float gm = length(g);
                N = g / max(gm, 1e-6);
                shade = smoothstep(0.01, 0.05, gm);
            }
            float ndl = abs(dot(N, L));           // headlight, two-sided
            float spec = pow(ndl, 40.0) * 0.35;
            float3 lit = col * (0.3 + 0.8 * ndl) + spec;
            col = mix(col * 0.85, lit, shade);
        }
        acc.rgb += (1.0 - acc.a) * a * col;
        acc.a += (1.0 - acc.a) * a;
        if (acc.a > 0.95) break;
    }
    for (; li < nl; li++) {
        float a = lc[li].a;
        acc.rgb += (1.0 - acc.a) * a * lc[li].rgb;
        acc.a += (1.0 - acc.a) * a;
    }
    return float4(acc.rgb + (1.0 - acc.a) * bg, 1.0);
}
