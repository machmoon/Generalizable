// SliceView — one MPR pane (axial / coronal / sagittal) backed by Metal.
// Layout of the annotations (orientation letters on the edges, crosshair lines coloured by
// the plane they represent; plane badge and slice n/N come from PaneChrome) follows the
// BodyMaps viewer (PanTS-Demo, built on Cornerstone3D: axial red, sagittal yellow,
// coronal green) and NiiVue's 2D slice view (github.com/niivue/niivue,
// packages/niivue/src/shader-srcs.ts `vertSliceMMShader` / `kFragSliceHead`).
import MetalKit
import SwiftUI

extension Plane {
    /// BodyMaps / Cornerstone3D reference-line colours.
    var tint: Color {
        switch self {
        case .axial: Color(red: 1, green: 0.23, blue: 0.19)
        case .sagittal: Color(red: 1, green: 0.85, blue: 0.1)
        case .coronal: Color(red: 0.2, green: 0.85, blue: 0.3)
        }
    }
    /// Plane whose normal is canonical `axis`.
    static func normal(_ axis: Int) -> Plane { axis == 0 ? .sagittal : axis == 1 ? .coronal : .axial }
    /// Radiological orientation letters (left, right, top, bottom) on screen.
    var edgeLetters: (l: String, r: String, t: String, b: String) {
        switch self {
        case .axial: ("R", "L", "A", "P")
        case .coronal: ("R", "L", "S", "I")
        case .sagittal: ("A", "P", "S", "I")
        }
    }
}

struct SliceView: View {
    let plane: Plane
    @Bindable var state: ViewerState
    @AppStorage("generalizable.labelOutline") private var outline = true

    private var viewport: SliceViewport {
        state.viewports[plane] ?? SliceViewport(plane: plane, viewSize: .zero)
    }

    private var params: SliceParams {
        var mask = [UInt32](repeating: 0, count: 8)
        for o in state.visibleOrgans { let r = Int(o.rawValue); mask[r >> 5] |= 1 << UInt32(r & 31) }
        return SliceParams(plane: plane, slice: Int(state.slice(for: plane)), viewport: viewport,
                           winLow: state.window.low, winHigh: state.window.high,
                           labelOpacity: state.labelOpacity, showLabels: state.showLabels,
                           outline: outline, selected: state.selectedOrgan?.rawValue ?? 0, mask: mask,
                           showAI: state.showAI && state.loaded.ai?.heatmap != nil, aiOpacity: state.aiOpacity)
    }

    var body: some View {
        ZStack {
            SliceMetalView(loaded: state.loaded, params: params)
            Crosshair(plane: plane, cursor: state.cursor, viewport: viewport, geometry: state.geometry)
                .allowsHitTesting(false)
            SliceInteractionLayer(plane: plane, state: state)
            annotations.allowsHitTesting(false)
            if plane == .axial, let ai = state.loaded.ai {
                VStack { HStack { AICard(state: state, ai: ai); Spacer() }; Spacer() }
                    .padding(.top, 24).padding(.leading, 6)
            }
        }
        .background(Color.black)
        .clipped()
        .onGeometryChange(for: CGSize.self, of: { $0.size }) { size in
            var vp = state.viewports[plane] ?? SliceViewport(plane: plane, viewSize: size)
            if vp.viewSize != size { vp.viewSize = size; state.viewports[plane] = vp }
        }
    }

    /// Orientation letters only: the plane badge and slice counter live in ViewerView's
    /// PaneChrome and W/L in its status bar, so drawing them here too made them overlap.
    private var annotations: some View {
        let e = plane.edgeLetters
        let font = Font.system(size: 11, weight: .semibold, design: .monospaced)
        return ZStack {
            VStack { Text(e.t); Spacer(); Text(e.b) }.padding(.top, 30).padding(.bottom, 6)
            HStack { Text(e.l); Spacer(); Text(e.r) }
                .padding(.leading, 6).padding(.trailing, 30)   // right edge hosts the slice slider
        }
        .font(font)
        .foregroundStyle(.white.opacity(0.85))
        .shadow(color: .black, radius: 1)
    }
}

/// Reference lines through the cursor, each coloured by the plane it represents.
private struct Crosshair: View {
    let plane: Plane
    let cursor: SIMD3<Float>
    let viewport: SliceViewport
    let geometry: VolumeGeometry

    var body: some View {
        Canvas { ctx, size in
            guard viewport.viewSize.width > 0 else { return }
            let p = viewport.voxelToView(cursor, geometry)
            let gap: CGFloat = 10
            let vColor = Plane.normal(plane.uAxis).tint   // vertical line = constant u
            let hColor = Plane.normal(plane.vAxis).tint   // horizontal line = constant v
            var v = Path()
            v.move(to: CGPoint(x: p.x, y: 0)); v.addLine(to: CGPoint(x: p.x, y: p.y - gap))
            v.move(to: CGPoint(x: p.x, y: p.y + gap)); v.addLine(to: CGPoint(x: p.x, y: size.height))
            var h = Path()
            h.move(to: CGPoint(x: 0, y: p.y)); h.addLine(to: CGPoint(x: p.x - gap, y: p.y))
            h.move(to: CGPoint(x: p.x + gap, y: p.y)); h.addLine(to: CGPoint(x: size.width, y: p.y))
            ctx.stroke(v, with: .color(vColor.opacity(0.85)), lineWidth: 1)
            ctx.stroke(h, with: .color(hColor.opacity(0.85)), lineWidth: 1)
        }
    }
}

/// MTKView wrapper; draws on demand only (enableSetNeedsDisplay), i.e. when params change.
private struct SliceMetalView: UIViewRepresentable {
    let loaded: LoadedCase
    let params: SliceParams

    func makeCoordinator() -> SliceRenderer {
        SliceRenderer(textures: VolumeTextures.shared(for: loaded), geometry: loaded.ct.geometry)
    }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: SliceRenderer.device)
        v.colorPixelFormat = .bgra8Unorm
        v.framebufferOnly = true
        v.enableSetNeedsDisplay = true
        v.isPaused = true
        v.autoResizeDrawable = true
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        v.backgroundColor = .black
        v.isUserInteractionEnabled = false
        v.delegate = context.coordinator
        context.coordinator.params = params
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        let r = context.coordinator
        if r.geometry != loaded.ct.geometry {
            r.textures = VolumeTextures.shared(for: loaded); r.geometry = loaded.ct.geometry
        }
        if r.params != params { r.params = params; v.setNeedsDisplay() }
    }
}

#Preview {
    let n: Int32 = 64
    let g = VolumeGeometry(dims: [n, n, n], spacing: [1, 1, 1], affine: matrix_identity_float4x4)
    var ct = [Int16](repeating: -1000, count: g.count)
    var lab = [UInt8](repeating: 0, count: g.count)
    for z in 0..<Int(n) { for y in 0..<Int(n) { for x in 0..<Int(n) {
        let d = simd_length(SIMD3<Float>(Float(x), Float(y), Float(z)) - 32)
        if d < 28 { ct[g.index(x, y, z)] = 40 }
        if d < 10 { ct[g.index(x, y, z)] = 80; lab[g.index(x, y, z)] = Organ.liver.rawValue }
    } } }
    let info = CaseInfo(id: "synthetic", title: "Synthetic")
    let state = ViewerState(loaded: LoadedCase(info: info, ct: CTVolume(geometry: g, voxels: ct),
                                               labels: LabelVolume(geometry: g, voxels: lab)))
    return SliceView(plane: .axial, state: state).frame(width: 360, height: 360)
}
