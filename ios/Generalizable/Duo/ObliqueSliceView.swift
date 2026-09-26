// The lid's cross-section (Layer Lens design, artifact PzfR7pyW3vmAhbzrGqz47A `render()`):
// the lid shows the plane through the bottom slice's cut line (through state.cursor), tilted
// t = 180° − hinge about the patient's left–right axis. t = 0 → the same axial slice as the
// bottom screen; t = 90° → front view (coronal). In-plane up = (0, cos t, sin t), so anterior
// rotates to superior as the lid opens toward you.
// Reslice model: vtkImageReslice (VTK, Imaging/Core/vtkImageReslice.h: ResliceAxes = origin +
// in-plane direction cosines) and NiiVue's mm-space slice shader
// (niivue/niivue packages/niivue/src/shader-srcs.ts, vertSliceMMShader). Shader: Shaders/Oblique.metal.
import SwiftUI
import MetalKit
import simd

struct ObliqueSliceView: View {
    @Bindable var state: ViewerState
    /// Lid tilt from the bottom slice, degrees (0 = axial, 90 = coronal).
    var tilt: Double
    /// Hinge angle for the caption.
    var hinge: Double
    var findings: [CaseFinding] = []

    private var tiltDegrees: Int { Int(tilt.rounded()) }
    private var hingeDegrees: Int { Int(hinge.rounded()) }
    /// Plain-language caption: what this pane is and why it looks the way it does, one line,
    /// no jargon (no "axial/coronal/tilt°" — the fold angle is the number that matters here).
    private var caption: String {
        tiltDegrees < 2 ? "Cross-section · flat (matches the other half)"
                        : "Cross-section · follows the fold (\(hingeDegrees)°)"
    }

    /// Screen-up rotates from anterior (axial, t = 0) to superior (coronal, t = 90°).
    private var topBottom: (String, String) { tilt < 45 ? ("A", "P") : ("S", "I") }

    var body: some View {
        ZStack {
            ObliqueMetalView(params: ObliqueParams(state: state, tilt: Float(tilt)), loaded: state.loaded)
            GeometryReader { geo in callouts(in: geo.size) }.allowsHitTesting(false)
            GeometryReader { geo in scaleBar(in: geo.size) }.allowsHitTesting(false)
        }
        .background(Color.black)
        // Clinical-viewer corners: identity top-left, plane top-right, scale bottom-left,
        // disclaimer bottom-right; orientation letters on the edges.
        .overlay(alignment: .topLeading) {
            CornerLabel(title: state.loaded.info.title.uppercased(),
                        detail: "\(state.window.name) · W \(Int(state.window.width)) L \(Int(state.window.center))")
        }
        .overlay(alignment: .topTrailing) {
            CornerLabel(title: tiltDegrees < 2 ? "AXIAL" : "OBLIQUE \(tiltDegrees)°",
                        detail: findings.isEmpty ? "Pivot · cursor" : "Pivot · finding centre", trailing: true)
        }
        .overlay(alignment: .bottomTrailing) {
            Text("Research · not for diagnosis").font(.system(size: 10, design: .monospaced))
                .foregroundStyle(FoldStyle.dim).padding(12)
        }
        .overlay(alignment: .leading) { edge("R") }
        .overlay(alignment: .trailing) { edge("L") }
        .overlay(alignment: .top) { edge(topBottom.0).padding(.top, 16) }
        .overlay(alignment: .bottom) { edge(topBottom.1).padding(.bottom, 16) }
        .accessibilityLabel(caption)
    }

    /// Same plane basis and field of view as ObliqueRenderer.draw.
    private func ptsPerMM(_ size: CGSize) -> CGFloat {
        let half = 0.5 * simd_reduce_max(state.geometry.extentMM) * 1.2
        return CGFloat(min(size.width, size.height) / 2) / CGFloat(half)
    }

    /// 50 mm bar plus the resolution in mm per screen point.
    @ViewBuilder private func scaleBar(in size: CGSize) -> some View {
        let k = ptsPerMM(size)
        VStack(alignment: .leading, spacing: 3) {
            Text("50 mm").font(.system(size: 9, design: .monospaced)).foregroundStyle(FoldStyle.dim)
            Path { p in
                p.move(to: CGPoint(x: 0, y: 3)); p.addLine(to: CGPoint(x: 50 * k, y: 3))
                p.move(to: .zero); p.addLine(to: CGPoint(x: 0, y: 6))
                p.move(to: CGPoint(x: 50 * k, y: 0)); p.addLine(to: CGPoint(x: 50 * k, y: 6))
            }
            .stroke(.white.opacity(0.7), lineWidth: 1)
            .frame(width: 50 * k, height: 6)
            Text(String(format: "%.2f mm/pt", 1 / k)).font(.system(size: 9, design: .monospaced)).foregroundStyle(FoldStyle.dim)
        }
        .padding(12)
        .frame(width: size.width, height: size.height, alignment: .bottomLeading)
    }

    /// Where each finding's sphere meets the tilted plane: an amber callout chip
    /// ("Subdural hemorrhage · 51 mm") on a leader line, like the design. The finding's own
    /// outline comes from the label overlay in the shader.
    @ViewBuilder private func callouts(in size: CGSize) -> some View {
        let g = state.geometry
        let t = Float(tilt * .pi / 180)
        let right = SIMD3<Float>(-1, 0, 0), up = SIMD3<Float>(0, cos(t), sin(t)), n = SIMD3<Float>(0, -sin(t), cos(t))
        let k = ptsPerMM(size)
        ForEach(Array(findings.enumerated()), id: \.element.id) { _, f in
            if let v = f.voxel(in: g) {
                let q = (v - ObliqueParams.planeCenter(state: state, tilt: Float(tilt))) * g.spacing
                let r = Float(f.radiusMM ?? 10), d = simd_dot((v - state.cursor) * g.spacing, n)
                if abs(d) < r {
                    let c = CGPoint(x: size.width / 2 + CGFloat(simd_dot(q, right)) * k,
                                    y: size.height / 2 - CGFloat(simd_dot(q, up)) * k)
                    let rad = CGFloat((r * r - d * d).squareRoot()) * k
                    FindingCallout(center: c, radius: rad, text: "\(f.title) · \(Int((2 * (f.radiusMM ?? 10)).rounded())) mm",
                                   container: size)
                }
            }
        }
    }

    private func edge(_ s: String) -> some View {
        Text(s).font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white.opacity(0.6)).padding(10)
    }
}

/// Amber callout: a leader line from the finding's edge (up and to the side with more room)
/// to a dark chip with an amber border. Stays inside the pane.
private struct FindingCallout: View {
    var center: CGPoint
    var radius: CGFloat
    var text: String
    var container: CGSize

    var body: some View {
        let toRight = center.x < container.width * 0.6
        let edge = CGPoint(x: center.x + (toRight ? 0.7 : -0.7) * radius, y: center.y - 0.7 * radius)
        let chipW: CGFloat = min(CGFloat(text.count) * 7.2 + 20, container.width * 0.6)
        let chipX = min(max(edge.x + (toRight ? 22 + chipW / 2 : -22 - chipW / 2), chipW / 2 + 8), container.width - chipW / 2 - 8)
        let chipY = max(edge.y - 26, 40)
        ZStack {
            Path { p in p.move(to: edge); p.addLine(to: CGPoint(x: chipX + (toRight ? -chipW / 2 : chipW / 2), y: chipY)) }
                .stroke(FoldStyle.amber, lineWidth: 1.2)
            Text(text).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.7)
                .padding(.horizontal, 9).frame(width: chipW, height: 24)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.78)))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(FoldStyle.amber, lineWidth: 1.2))
                .position(x: chipX, y: chipY)
        }
    }
}

struct ObliqueParams: Equatable {
    var cursor: SIMD3<Float>
    /// View centre: the volume's centre projected onto the plane (the plane still passes through
    /// the cursor/pivot). Centring on the pivot itself pushed the anatomy off-screen.
    var center: SIMD3<Float>
    var tilt: Float
    var winLow: Float, winHigh: Float
    var labelOpacity: Float
    var showLabels: Bool
    var mask: [UInt32]
    var selected: UInt8
    var showAI: Bool
    var aiOpacity: Float

    @MainActor init(state: ViewerState, tilt: Float) {
        cursor = state.cursor
        center = Self.planeCenter(state: state, tilt: tilt)
        self.tilt = tilt
        winLow = state.window.low; winHigh = state.window.high
        labelOpacity = state.labelOpacity
        showLabels = state.showLabels
        var m = [UInt32](repeating: 0, count: 8)
        for o in state.visibleOrgans { let v = Int(o.rawValue); m[v >> 5] |= 1 << UInt32(v & 31) }
        mask = m
        selected = state.selectedOrgan?.rawValue ?? 0
        showAI = state.showAI
        aiOpacity = state.aiOpacity
    }

    @MainActor static func planeCenter(state: ViewerState, tilt: Float) -> SIMD3<Float> {
        let g = state.geometry, t = tilt * .pi / 180
        let n = SIMD3<Float>(0, -sin(t), cos(t))
        let mid = (SIMD3<Float>(Float(g.dims.x), Float(g.dims.y), Float(g.dims.z)) - 1) / 2
        var d = (mid - state.cursor) * g.spacing
        d -= simd_dot(d, n) * n
        return state.cursor + d / g.spacing
    }
}

private struct ObliqueMetalView: UIViewRepresentable {
    var params: ObliqueParams
    let loaded: LoadedCase

    func makeCoordinator() -> ObliqueRenderer { ObliqueRenderer(loaded: loaded) }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: VolumeTextures.device)
        v.colorPixelFormat = .bgra8Unorm
        v.framebufferOnly = true
        v.enableSetNeedsDisplay = true
        v.isPaused = true
        v.clearColor = MTLClearColorMake(0, 0, 0, 1)
        v.delegate = context.coordinator
        context.coordinator.params = params
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        if context.coordinator.params != params {
            context.coordinator.params = params
            v.setNeedsDisplay()
        }
    }
}

private struct ObliqueUniforms {
    var originMM: SIMD3<Float>, rightMM: SIMD3<Float>, upMM: SIMD3<Float>, spacing: SIMD3<Float>
    var winLow: Float, winHigh: Float, labelOpacity: Float, aiOpacity: Float
    var hasLabels: Int32, hasAI: Int32, selected: Int32
    var mask: (UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32, UInt32)
}

private struct OVert { var position: SIMD2<Float>; var ndc: SIMD2<Float> }

final class ObliqueRenderer: NSObject, MTKViewDelegate {
    var params: ObliqueParams?
    private let loaded: LoadedCase
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let tex: VolumeTextures
    private let blankLabels: MTLTexture
    private let blankHeat: MTLTexture

    init(loaded: LoadedCase) {
        self.loaded = loaded
        let dev = VolumeTextures.device
        queue = dev.makeCommandQueue()!
        let lib = dev.makeDefaultLibrary()!
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "obliqueVertex")
        d.fragmentFunction = lib.makeFunction(name: "obliqueFragment")
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        pipeline = try! dev.makeRenderPipelineState(descriptor: d)
        tex = VolumeTextures.shared(for: loaded)
        blankLabels = Self.blank3D(dev, .r8Uint)
        blankHeat = Self.blank3D(dev, .r8Unorm)
    }

    private static func blank3D(_ dev: MTLDevice, _ fmt: MTLPixelFormat) -> MTLTexture {
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = fmt; d.width = 1; d.height = 1; d.depth = 1
        d.usage = .shaderRead
        let t = dev.makeTexture(descriptor: d)!
        var z: UInt8 = 0
        t.replace(region: MTLRegionMake3D(0, 0, 0, 1, 1, 1), mipmapLevel: 0, slice: 0,
                  withBytes: &z, bytesPerRow: 1, bytesPerImage: 1)
        return t
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { view.setNeedsDisplay() }

    func draw(in view: MTKView) {
        guard let p = params, let rpd = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cb = queue.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: rpd) else { return }
        let g = loaded.ct.geometry
        let size = view.drawableSize
        guard size.width > 0, size.height > 0 else { enc.endEncoding(); cb.commit(); return }

        // Screen-right = patient left (radiological, like the axial SliceView); screen-up rotates
        // from anterior (t = 0, axial) to superior (t = 90°, coronal).
        let t = p.tilt * .pi / 180
        let right = SIMD3<Float>(-1, 0, 0)
        let up = SIMD3<Float>(0, cos(t), sin(t))
        // Square field of view covering the whole volume, aspect-fitted into the view.
        let half = 0.5 * simd_reduce_max(g.extentMM) * 1.2   // margin for the corner labels (match ptsPerMM)
        let aspect = Float(size.width / size.height)
        let sx: Float = aspect >= 1 ? 1 / aspect : 1
        let sy: Float = aspect >= 1 ? 1 : aspect
        let verts: [OVert] = [
            OVert(position: [-sx, -sy], ndc: [-1, -1]), OVert(position: [sx, -sy], ndc: [1, -1]),
            OVert(position: [-sx, sy], ndc: [-1, 1]), OVert(position: [sx, sy], ndc: [1, 1]),
        ]
        let m = p.mask
        var u = ObliqueUniforms(
            originMM: (p.center + 0.5) * g.spacing, rightMM: right * half, upMM: up * half, spacing: g.spacing,
            winLow: p.winLow, winHigh: p.winHigh,
            labelOpacity: p.showLabels ? p.labelOpacity : 0, aiOpacity: p.aiOpacity,
            hasLabels: (p.showLabels && tex.labels != nil) ? 1 : 0,
            hasAI: (p.showAI && tex.aiHeatmap != nil) ? 1 : 0,
            selected: Int32(p.selected),
            mask: (m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]))

        enc.setRenderPipelineState(pipeline)
        enc.setVertexBytes(verts, length: MemoryLayout<OVert>.stride * verts.count, index: 0)
        enc.setFragmentBytes(&u, length: MemoryLayout<ObliqueUniforms>.stride, index: 0)
        enc.setFragmentTexture(tex.ct, index: 0)
        enc.setFragmentTexture(tex.labels ?? blankLabels, index: 1)
        enc.setFragmentTexture(tex.organLUT, index: 2)
        enc.setFragmentTexture(tex.aiHeatmap ?? blankHeat, index: 3)
        enc.setFragmentTexture(tex.aiLUT, index: 4)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        enc.endEncoding()
        cb.present(drawable)
        cb.commit()
    }
}

/// Small mono tag on a translucent chip, the caption style from the Layer Lens design.
struct LensTag: View {
    var text: String
    var color: Color = .white.opacity(0.95)
    var fill: Color = Color(red: 0.02, green: 0.035, blue: 0.043).opacity(0.72)
    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium, design: .monospaced)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 5).fill(fill))
    }
}
