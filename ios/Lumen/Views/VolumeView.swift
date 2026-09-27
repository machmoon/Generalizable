// VolumeView — the 3D pane's "Volume" / "MIP" modes: an MTKView driven by VolumeRenderer
// (GPU raycaster, Shaders/Volume.metal; design after NiiVue's shader-srcs.ts render shader).
// Gestures follow NiiVue / 3D Slicer 3D-view conventions: one-finger drag orbits, pinch
// zooms, two-finger drag pans, double-tap resets. Renders at 1x scale with 2x ray steps
// while a gesture is active and returns to full quality ~0.25 s after it ends.
import MetalKit
import SwiftUI

struct VolumeView: View {
    @Bindable var state: ViewerState

    private var params: VolumeRenderParams {
        var mask = SIMD2<UInt32>(0, 0)
        for o in state.visibleOrgans {
            let r = UInt32(o.rawValue)
            if r < 32 { mask.x |= 1 << r } else if r < 64 { mask.y |= 1 << (r - 32) }
        }
        return VolumeRenderParams(
            mode: state.volumeMode == .mip ? .mip : .volume,
            cursor: state.cursor,
            clipNormal: state.clipNormal,
            organMask: mask,
            tint: state.showLabels && !state.visibleOrgans.isEmpty,
            window: state.window,
            selected: state.selectedOrgan?.rawValue ?? 0,
            showPlanes: true)
    }

    var body: some View {
        VolumeMetalView(loaded: state.loaded, params: params)
            .background(Color.black)
            .overlay(alignment: .bottomLeading) {
                Text(state.volumeMode == .mip ? "MIP" : "Volume")
                    .font(.caption2.monospaced()).foregroundStyle(.white.opacity(0.55))
                    .padding(6).allowsHitTesting(false)
            }
            .clipped()
    }
}

struct VolumeMetalView: UIViewRepresentable {
    let loaded: LoadedCase
    let params: VolumeRenderParams

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: VolumeTextures.device)
        v.colorPixelFormat = .bgra8Unorm
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        v.framebufferOnly = true
        v.isPaused = true
        v.enableSetNeedsDisplay = true
        v.autoResizeDrawable = true
        v.isMultipleTouchEnabled = true
        let c = context.coordinator
        c.view = v
        c.renderer = VolumeRenderer(loaded: loaded)
        c.caseID = loaded.info.id
        c.renderer?.params = params
        v.delegate = c.renderer
        c.installGestures(on: v)
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        let c = context.coordinator
        if c.caseID != loaded.info.id {
            c.renderer = VolumeRenderer(loaded: loaded)
            c.caseID = loaded.info.id
            v.delegate = c.renderer
        }
        if c.renderer?.params != params {
            c.renderer?.params = params
        }
        c.applyScale()
        v.setNeedsDisplay()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var view: MTKView?
        var renderer: VolumeRenderer?
        var caseID = ""
        private var idleWork: DispatchWorkItem?
        private var lastPinch: CGFloat = 1

        func installGestures(on v: MTKView) {
            let orbit = UIPanGestureRecognizer(target: self, action: #selector(onOrbit(_:)))
            orbit.minimumNumberOfTouches = 1; orbit.maximumNumberOfTouches = 1
            let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
            pan.minimumNumberOfTouches = 2; pan.maximumNumberOfTouches = 2
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
            let dbl = UITapGestureRecognizer(target: self, action: #selector(onDoubleTap))
            dbl.numberOfTapsRequired = 2
            for g in [orbit, pan, pinch, dbl] as [UIGestureRecognizer] { g.delegate = self; v.addGestureRecognizer(g) }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith o: UIGestureRecognizer) -> Bool {
            (g is UIPinchGestureRecognizer && o is UIPanGestureRecognizer) || (o is UIPinchGestureRecognizer && g is UIPanGestureRecognizer)
        }

        private var fullScale: CGFloat {
            min(view?.traitCollection.displayScale ?? 2, 2)
        }

        func applyScale() {
            guard let v = view, let r = renderer else { return }
            let s: CGFloat = r.interacting ? 1 : fullScale
            if v.contentScaleFactor != s { v.contentScaleFactor = s }
            r.setViewHeight(points: v.bounds.height)
        }

        private func begin() {
            idleWork?.cancel()
            guard let r = renderer, !r.interacting else { return }
            r.interacting = true
            applyScale()
        }

        private func end() {
            idleWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let self, let r = self.renderer else { return }
                r.interacting = false
                self.applyScale()
                self.view?.setNeedsDisplay()
            }
            idleWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: w)
        }

        private func phase(_ g: UIGestureRecognizer) {
            switch g.state {
            case .began: begin()
            case .ended, .cancelled, .failed: end()
            default: break
            }
        }

        @objc func onOrbit(_ g: UIPanGestureRecognizer) {
            phase(g)
            let t = g.translation(in: g.view); g.setTranslation(.zero, in: g.view)
            renderer?.orbit(dx: Float(t.x), dy: Float(t.y))
            view?.setNeedsDisplay()
        }

        @objc func onPan(_ g: UIPanGestureRecognizer) {
            phase(g)
            let t = g.translation(in: g.view); g.setTranslation(.zero, in: g.view)
            renderer?.setViewHeight(points: g.view?.bounds.height ?? 1)
            renderer?.pan(dx: Float(t.x), dy: Float(t.y))
            view?.setNeedsDisplay()
        }

        @objc func onPinch(_ g: UIPinchGestureRecognizer) {
            phase(g)
            if g.state == .began { lastPinch = 1 }
            renderer?.zoom(by: Float(g.scale / lastPinch))
            lastPinch = g.scale
            view?.setNeedsDisplay()
        }

        @objc func onDoubleTap() {
            renderer?.resetCamera()
            view?.setNeedsDisplay()
        }
    }
}
