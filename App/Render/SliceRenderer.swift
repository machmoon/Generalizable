// SliceRenderer.swift
// Metal reslice of a CaseBundle along a plane (PRD A1/A4; design spec section 2).
//
// Pieces:
//   - SlicePlaneFrame: origin + in-plane axes + square half-extent. SliceView builds one from a
//     CutPlane; OverviewView (E3) can build a mid-sagittal one and reuse the same shader.
//   - SliceGeometry: the same aspect-fit mm <-> point mapping the shader uses, for SwiftUI overlays.
//   - SliceTextureCache: one upload per CaseBundle (weak keys), shared by every view of that case.
//   - SliceMetalView: MTKView in a UIViewRepresentable, paused + enableSetNeedsDisplay, redraws
//     only when its parameters change.
//
// Prior art (source read): Kitware/vtk-js Sources/Rendering/OpenGL/ImageResliceMapper/index.js
// (per-fragment world->texture transform, bounds test, labelmap outline) — see Slice.metal.
// VTK's reslice "ResliceAxes" idea (origin + two in-plane direction columns) is what
// SlicePlaneFrame encodes.

import Foundation
import simd
import Metal
import MetalKit
import SwiftUI
import UIKit

// MARK: - Plane frame

struct SlicePlaneFrame: Equatable {
    /// Plane point shown at the view centre (u = 0, v = 0), mm RAS.
    var originMM: SIMD3<Float>
    /// In-plane +u (screen right) and +v (screen up), unit length.
    var uAxis: SIMD3<Float>
    var vAxis: SIMD3<Float>
    var normal: SIMD3<Float>
    /// Half of the square extent mapped onto the view's SHORTER side (aspect-fit), mm.
    var halfExtentMM: Float

    /// The cut plane, centred on its origin (pivot + offset along the normal).
    /// halfExtent = half the volume diagonal: it depends only on the bundle, so the zoom never
    /// "breathes" while the hinge changes tilt or the pivot moves, and any cross-section through
    /// the volume centre fits.
    init(cut: CutPlane, bundle: CaseBundle) {
        originMM = cut.originMM
        uAxis = cut.uAxis
        vAxis = cut.vAxis
        normal = cut.normal
        halfExtentMM = Self.defaultHalfExtent(for: bundle)
    }

    init(originMM: SIMD3<Float>, uAxis: SIMD3<Float>, vAxis: SIMD3<Float>, halfExtentMM: Float) {
        self.originMM = originMM
        self.uAxis = uAxis
        self.vAxis = vAxis
        self.normal = simd_normalize(simd_cross(uAxis, vAxis))
        self.halfExtentMM = halfExtentMM
    }

    static func defaultHalfExtent(for bundle: CaseBundle) -> Float {
        max(simd_length(bundle.extentMM) * 0.5, 1)
    }
}

// MARK: - Geometry shared with overlays

/// Aspect-fit mapping between plane mm and view points. Matches the shader exactly:
/// the shorter view side spans 2 * halfExtentMM, the centre is (u, v) = (0, 0), +v is up.
struct SliceGeometry {
    let frame: SlicePlaneFrame
    let size: CGSize

    var mmPerPoint: Float {
        let short = Float(max(min(size.width, size.height), 1))
        return 2 * frame.halfExtentMM / short
    }

    /// In-plane (u, v) mm and signed distance d from the plane for a world point.
    func planeCoords(ofMM p: SIMD3<Float>) -> (u: Float, v: Float, d: Float) {
        let r = p - frame.originMM
        return (simd_dot(r, frame.uAxis), simd_dot(r, frame.vAxis), simd_dot(r, frame.normal))
    }

    func point(u: Float, v: Float) -> CGPoint {
        let s = mmPerPoint
        return CGPoint(x: size.width / 2 + CGFloat(u / s), y: size.height / 2 - CGFloat(v / s))
    }

    /// Projection of a world point into the view (ignores distance from the plane).
    func screenPoint(forMM p: SIMD3<Float>) -> CGPoint {
        let c = planeCoords(ofMM: p)
        return point(u: c.u, v: c.v)
    }

    func points(fromMM mm: Float) -> CGFloat { CGFloat(mm / mmPerPoint) }
}

// MARK: - Uniforms (layout mirrors SliceUniforms in Slice.metal: 8 x float4 = 128 bytes)

struct SliceUniforms {
    var origin: SIMD4<Float>
    var uAxis: SIMD4<Float>
    var vAxis: SIMD4<Float>
    var volOrigin: SIMD4<Float>
    var spacing: SIMD4<Float>
    var dims: SIMD4<Float>
    var window: SIMD4<Float>
    var params: SIMD4<Float>
}

// MARK: - Shared Metal state

final class SliceMetal {
    static let shared = SliceMetal()

    let device: MTLDevice?
    let queue: MTLCommandQueue?
    let pipeline: MTLRenderPipelineState?
    let colorPixelFormat: MTLPixelFormat = .bgra8Unorm
    /// Why the pipeline is nil, for the on-screen fallback text.
    private(set) var failure: String?

    private init() {
        guard let device = MTLCreateSystemDefaultDevice() else {
            self.device = nil; queue = nil; pipeline = nil
            failure = "No Metal device"
            return
        }
        self.device = device
        queue = device.makeCommandQueue()

        var lib: MTLLibrary?
        // 1. The compiled Slice.metal in the app's default library.
        if let def = device.makeDefaultLibrary(), def.makeFunction(name: "sliceFragment") != nil {
            lib = def
        } else {
            // 2. Fallback: compile the embedded copy at runtime. Needed if the build machine's
            //    Xcode lacks the Metal Toolchain component and Slice.metal is removed from the target.
            do {
                lib = try device.makeLibrary(source: sliceShaderSource, options: nil)
            } catch {
                failure = "Shader compile failed: \(error)"
            }
        }

        var state: MTLRenderPipelineState?
        if let lib, let vf = lib.makeFunction(name: "sliceVertex"), let ff = lib.makeFunction(name: "sliceFragment") {
            let desc = MTLRenderPipelineDescriptor()
            desc.label = "Slice"
            desc.vertexFunction = vf
            desc.fragmentFunction = ff
            desc.colorAttachments[0].pixelFormat = colorPixelFormat
            do {
                state = try device.makeRenderPipelineState(descriptor: desc)
            } catch {
                failure = "Pipeline failed: \(error)"
            }
        } else if failure == nil {
            failure = "Slice shader functions missing"
        }
        pipeline = state
    }
}

// MARK: - Texture cache (one upload per bundle)

final class SliceTextureCache {
    static let shared = SliceTextureCache()

    final class Entry {
        let ct: MTLTexture
        let labels: MTLTexture
        init(ct: MTLTexture, labels: MTLTexture) { self.ct = ct; self.labels = labels }
    }

    /// Weak keys: when a CaseBundle is released its textures go with it.
    private let table = NSMapTable<CaseBundle, Entry>.weakToStrongObjects()
    private let lock = NSLock()

    func textures(for bundle: CaseBundle, device: MTLDevice) throws -> Entry {
        lock.lock(); defer { lock.unlock() }
        if let hit = table.object(forKey: bundle) { return hit }
        // CaseBundle builds CT as .r16Snorm and labels as .r8Uint (App/Core, A4).
        let t = try bundle.makeTextures(device: device)
        t.ct.label = "\(bundle.name) ct r16Snorm"
        t.labels.label = "\(bundle.name) labels r8Uint"
        let e = Entry(ct: t.ct, labels: t.labels)
        table.setObject(e, forKey: bundle)
        return e
    }
}

// MARK: - Render parameters

struct SliceRenderParams: Equatable {
    var frame: SlicePlaneFrame
    /// 0 = layers, 1 = ct
    var modeIsCT: Bool
    var visibleLayerIDs: Set<Int>
    /// Active [level, width] (CT mode).
    var window: SIMD2<Float>
    /// Soft-tissue [level, width] for the dimmed base in layers mode.
    var softWindow: SIMD2<Float>
}

// MARK: - Renderer (MTKViewDelegate)

final class SliceRenderer: NSObject, MTKViewDelegate {
    let bundle: CaseBundle
    private let metal = SliceMetal.shared
    private var textures: SliceTextureCache.Entry?
    private var tableBuffer: MTLBuffer?
    private var tableKey: Set<Int>?
    private(set) var loadError: String?

    var params: SliceRenderParams? {
        didSet { if params != oldValue { needsDraw = true } }
    }
    private(set) var needsDraw = true

    init(bundle: CaseBundle) {
        self.bundle = bundle
        super.init()
        if let device = metal.device {
            do {
                textures = try SliceTextureCache.shared.textures(for: bundle, device: device)
            } catch {
                loadError = "\(error)"
            }
        }
    }

    var failure: String? { metal.failure ?? loadError }

    /// 256-entry table: rgb = layers.json colour, a = 1 when visible. Label 0 stays hidden.
    private func colorTable(visible: Set<Int>) -> MTLBuffer? {
        if let tableBuffer, tableKey == visible { return tableBuffer }
        var entries = [SIMD4<Float>](repeating: .zero, count: 256)
        for layer in bundle.layers where (1...255).contains(layer.id) {
            let c = layer.rgba
            entries[layer.id] = SIMD4<Float>(c.x, c.y, c.z, visible.contains(layer.id) ? 1 : 0)
        }
        let buf = entries.withUnsafeBytes { raw in
            metal.device?.makeBuffer(bytes: raw.baseAddress!, length: raw.count, options: .storageModeShared)
        }
        buf?.label = "Slice layer table"
        tableBuffer = buf
        tableKey = visible
        return buf
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        view.setNeedsDisplay()
    }

    func draw(in view: MTKView) {
        needsDraw = false
        guard let queue = metal.queue, let pipeline = metal.pipeline,
              let passDesc = view.currentRenderPassDescriptor,
              let cmd = queue.makeCommandBuffer() else { return }
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: passDesc) else { return }
        enc.label = "Slice"

        if let p = params, let textures, let table = colorTable(visible: p.visibleLayerIDs) {
            let ds = view.drawableSize
            let w = Float(max(ds.width, 1)), h = Float(max(ds.height, 1))
            let half = p.frame.halfExtentMM
            let halfW = w <= h ? half : half * w / h
            let halfH = w <= h ? half * h / w : half
            let mmPerPixel = 2 * halfW / w

            let m = bundle.meta
            func v3(_ a: [Double]) -> SIMD4<Float> {
                SIMD4<Float>(Float(a[0]), Float(a[1]), Float(a[2]), 0)
            }
            func v3i(_ a: [Int]) -> SIMD4<Float> {
                SIMD4<Float>(Float(a[0]), Float(a[1]), Float(a[2]), 0)
            }
            var u = SliceUniforms(
                origin: SIMD4<Float>(p.frame.originMM, 0),
                uAxis: SIMD4<Float>(p.frame.uAxis, 0),
                vAxis: SIMD4<Float>(p.frame.vAxis, 0),
                volOrigin: v3(m.originMM),
                spacing: v3(m.spacingMM),
                dims: v3i(m.dims),
                window: SIMD4<Float>(p.window.x, p.window.y, p.softWindow.x, p.softWindow.y),
                params: SIMD4<Float>(halfW, halfH, mmPerPixel, p.modeIsCT ? 1 : 0))

            enc.setRenderPipelineState(pipeline)
            enc.setFragmentBytes(&u, length: MemoryLayout<SliceUniforms>.stride, index: 0)
            enc.setFragmentBuffer(table, offset: 0, index: 1)
            enc.setFragmentTexture(textures.ct, index: 0)
            enc.setFragmentTexture(textures.labels, index: 1)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        enc.endEncoding()
        if let drawable = view.currentDrawable { cmd.present(drawable) }
        cmd.commit()
    }
}

// MARK: - SwiftUI wrapper

/// The raw Metal slice. SliceView adds the ring, chrome and demo label on top; OverviewView can
/// use this directly with its own mid-sagittal SlicePlaneFrame.
struct SliceMetalView: UIViewRepresentable {
    let bundle: CaseBundle
    let params: SliceRenderParams

    func makeCoordinator() -> SliceRenderer { SliceRenderer(bundle: bundle) }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: SliceMetal.shared.device)
        view.colorPixelFormat = SliceMetal.shared.colorPixelFormat
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        view.framebufferOnly = true
        view.isPaused = true
        view.enableSetNeedsDisplay = true
        view.autoResizeDrawable = true
        view.isOpaque = true
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        view.delegate = context.coordinator
        context.coordinator.params = params
        return view
    }

    func updateUIView(_ view: MTKView, context: Context) {
        let r = context.coordinator
        r.params = params
        if r.needsDraw { view.setNeedsDisplay() }
    }
}

// MARK: - Embedded shader (runtime-compile fallback; verbatim copy of Slice.metal)

let sliceShaderSource: String = #"""
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
"""#
