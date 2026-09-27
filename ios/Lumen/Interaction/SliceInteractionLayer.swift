// Gesture + annotation overlay for one slice plane.
//
// Interaction semantics follow Cornerstone3D (github.com/cornerstonejs/cornerstone3D, main):
// - packages/tools/src/tools/StackScrollTool.ts    — drag-to-scroll with pixelsPerImage accumulator
// - packages/tools/src/tools/WindowLevelTool.ts    — dx → window width, dy → window center, ×multiplier
// - packages/tools/src/tools/annotation/LengthTool.ts — drag creates a line; grab endpoint handles
//   within a proximity to edit; label shows length in mm
// - packages/tools/src/tools/annotation/ProbeTool.ts  — readout of value + index/world coords at a point
// - packages/tools/src/tools/CrosshairsTool.ts     — click jumps the shared crosshair (cursor) to the point
// Math lives in InteractionMath.swift (unit-tested in LumenTests/InteractionTests.swift).
// Deviations: touch-first — inertia on slice scroll, pinch/two-finger pan always active, and a
// right-edge slice scrubber (BodyMaps' viewer has a slice slider).
import SwiftUI
import UIKit
import simd

/// Transient per-layer interaction state (not shared with other modules).
@MainActor @Observable
final class InteractionModel {
    var draft: Measurement?
    var probePoint: CGPoint?
    var probeActive = false
    var scrubbing = false
}

/// Transparent overlay placed on top of each SliceView: gestures + measurement/probe drawings.
struct SliceInteractionLayer: View {
    let plane: Plane
    @Bindable var state: ViewerState
    @State private var model = InteractionModel()

    var body: some View {
        GeometryReader { geo in
            let vp = viewport(geo.size)
            ZStack {
                GestureSurface(plane: plane, state: state, model: model, fallbackSize: geo.size)
                Canvas { ctx, _ in draw(in: &ctx, vp: vp) }
                    .allowsHitTesting(false)
                if state.activeTool == .probe || model.probeActive, let p = model.probePoint {
                    ProbeReadout(state: state, plane: plane, point: p, vp: vp)
                        .position(readoutPosition(p, in: geo.size))
                        .allowsHitTesting(false)
                        .animation(.easeOut(duration: 0.08), value: p)
                }
                HStack {
                    Spacer()
                    SliceScrubber(plane: plane, state: state, model: model)
                        .frame(width: 28)
                        .padding(.vertical, 24)
                }
            }
        }
        .onChange(of: state.activeTool) { _, _ in
            model.draft = nil
            model.probePoint = nil
        }
    }

    private func viewport(_ size: CGSize) -> SliceViewport {
        var vp = state.viewports[plane] ?? SliceViewport(plane: plane, viewSize: size)
        if vp.viewSize == .zero { vp.viewSize = size }
        return vp
    }

    private func readoutPosition(_ p: CGPoint, in size: CGSize) -> CGPoint {
        // Float above the finger so it is not occluded; flip below near the top edge.
        let y = p.y < 110 ? p.y + 80 : p.y - 80
        let x = min(max(p.x, 95), max(size.width - 95, 95))
        return CGPoint(x: x, y: y)
    }

    // MARK: Drawing (all positions through voxelToView so they track zoom/pan)

    private func draw(in ctx: inout GraphicsContext, vp: SliceViewport) {
        let g = state.geometry
        let slice = state.slice(for: plane)
        var items = state.measurements.filter { InteractionMath.isVisible($0, plane: plane, slice: slice) }
        if let d = model.draft, !items.contains(where: { $0.id == d.id }) { items.append(d) }

        for m in items {
            let a = vp.voxelToView(m.start, g), b = vp.voxelToView(m.end, g)
            var line = Path(); line.move(to: a); line.addLine(to: b)
            let accent = Color(red: 1.0, green: 0.84, blue: 0.2)
            ctx.stroke(line, with: .color(.black.opacity(0.55)), lineWidth: 3.5)
            ctx.stroke(line, with: .color(accent), lineWidth: 1.75)
            for p in [a, b] {
                let r: CGFloat = 5
                let circle = Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))
                ctx.fill(circle, with: .color(.black.opacity(0.4)))
                ctx.stroke(circle, with: .color(accent), lineWidth: 1.75)
            }
            let label = String(format: "%.1f mm", m.lengthMM(g))
            let text = Text(label).font(.system(size: 12, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(accent)
            let resolved = ctx.resolve(text)
            let sz = resolved.measure(in: CGSize(width: 200, height: 40))
            // Place label beside the endpoint that is further right, like LengthTool's textbox.
            let anchor = a.x > b.x ? a : b
            let rect = CGRect(x: anchor.x + 10, y: anchor.y - sz.height / 2 - 3,
                              width: sz.width + 10, height: sz.height + 6)
            ctx.fill(Path(roundedRect: rect, cornerRadius: 5), with: .color(.black.opacity(0.6)))
            ctx.draw(resolved, at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
        }

        if state.activeTool == .probe || model.probeActive, let p = model.probePoint {
            var cross = Path()
            cross.move(to: CGPoint(x: p.x - 9, y: p.y)); cross.addLine(to: CGPoint(x: p.x + 9, y: p.y))
            cross.move(to: CGPoint(x: p.x, y: p.y - 9)); cross.addLine(to: CGPoint(x: p.x, y: p.y + 9))
            ctx.stroke(cross, with: .color(.black.opacity(0.6)), lineWidth: 3)
            ctx.stroke(cross, with: .color(.white), lineWidth: 1.25)
        }
    }
}

// MARK: - Probe readout

private struct ProbeReadout: View {
    let state: ViewerState
    let plane: Plane
    let point: CGPoint
    let vp: SliceViewport

    var body: some View {
        let g = state.geometry
        let v = vp.viewToVoxel(point, slice: state.slice(for: plane), g).rounded(.toNearestOrAwayFromZero)
        let inside = g.contains(v)
        let hu = state.loaded.ct.hu(at: v)
        let organ = state.loaded.labels?.organ(at: v)
        let mm = v * g.spacing
        VStack(alignment: .leading, spacing: 2) {
            if inside, let hu {
                Text("\(hu) HU").font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                HStack(spacing: 5) {
                    Circle().fill(organ?.color ?? .gray).frame(width: 7, height: 7)
                    Text(organ?.displayName ?? "No label").font(.caption.weight(.medium))
                }
                Text("vox \(Int(v.x)), \(Int(v.y)), \(Int(v.z))")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Text(String(format: "mm %.1f, %.1f, %.1f", mm.x, mm.y, mm.z))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            } else {
                Text("Outside volume").font(.caption.weight(.medium))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
        .environment(\.colorScheme, .dark)
        .fixedSize()
    }
}

// MARK: - Slice scrubber (right edge)

private struct SliceScrubber: View {
    let plane: Plane
    @Bindable var state: ViewerState
    let model: InteractionModel
    @State private var lastTick = -1
    private let haptics = UISelectionFeedbackGenerator()

    var body: some View {
        GeometryReader { geo in
            let n = max(state.sliceCount(for: plane), 1)
            let s = CGFloat(state.slice(for: plane))
            // Top of the track = highest index (superior / anterior / left), matching screen-up.
            let frac = n > 1 ? 1 - s / CGFloat(n - 1) : 0
            let h = geo.size.height
            ZStack(alignment: .top) {
                Capsule().fill(.white.opacity(model.scrubbing ? 0.28 : 0.14))
                    .frame(width: model.scrubbing ? 5 : 3)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Capsule().fill(.white)
                    .frame(width: model.scrubbing ? 14 : 9, height: model.scrubbing ? 26 : 18)
                    .shadow(color: .black.opacity(0.5), radius: 2)
                    .offset(y: frac * max(h - 18, 0))
                if model.scrubbing {
                    Text("\(Int(s) + 1)/\(n)")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(.black.opacity(0.7), in: Capsule())
                        .foregroundStyle(.white)
                        .fixedSize()
                        .offset(x: -44, y: frac * max(h - 18, 0))
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if !model.scrubbing { model.scrubbing = true; haptics.prepare() }
                        let f = min(max(v.location.y / max(h, 1), 0), 1)
                        let idx = Int(((1 - f) * CGFloat(n - 1)).rounded())
                        state.setSlice(Float(idx), for: plane)
                        let tick = idx / 10
                        if tick != lastTick { if lastTick >= 0 { haptics.selectionChanged() }; lastTick = tick }
                    }
                    .onEnded { _ in model.scrubbing = false; lastTick = -1 }
            )
            .animation(.easeOut(duration: 0.12), value: model.scrubbing)
        }
    }
}

// MARK: - UIKit gesture surface (reliable 1- vs 2-finger discrimination)

private struct GestureSurface: UIViewRepresentable {
    let plane: Plane
    let state: ViewerState
    let model: InteractionModel
    let fallbackSize: CGSize

    func makeCoordinator() -> Coordinator { Coordinator(plane: plane, state: state, model: model) }

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        v.isMultipleTouchEnabled = true
        let c = context.coordinator

        let pan1 = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.onePan(_:)))
        pan1.maximumNumberOfTouches = 1
        let pan2 = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.twoPan(_:)))
        pan2.minimumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinch(_:)))
        let tap2 = UITapGestureRecognizer(target: c, action: #selector(Coordinator.doubleTap(_:)))
        tap2.numberOfTapsRequired = 2
        let tap1 = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap(_:)))
        tap1.require(toFail: tap2)
        let hold = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.hold(_:)))
        hold.minimumPressDuration = 0.25
        hold.allowableMovement = 12

        for g in [pan1, pan2, pinch, tap1, tap2, hold] as [UIGestureRecognizer] {
            g.delegate = c
            v.addGestureRecognizer(g)
        }
        c.view = v
        return v
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.fallbackSize = fallbackSize
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        let plane: Plane
        let state: ViewerState
        let model: InteractionModel
        weak var view: UIView?
        var fallbackSize: CGSize = .zero

        // Stack scroll
        private var scrollRemainder: CGFloat = 0
        private var lastTranslation: CGPoint = .zero
        private var inertia: CADisplayLink?
        private var inertiaVelocity: CGFloat = 0   // points/sec
        private var inertiaLast: CFTimeInterval = 0
        // Window/level
        private var wlMultiplier: Float?
        // Measure
        private enum Handle { case start, end }
        private var editing: (id: UUID, handle: Handle)?
        // Pinch / pan
        private var pinchStartZoom: CGFloat = 1
        private var pinchStartPan: CGSize = .zero
        private var twoPanStart: CGSize = .zero

        init(plane: Plane, state: ViewerState, model: InteractionModel) {
            self.plane = plane; self.state = state; self.model = model
        }

        var viewport: SliceViewport {
            get {
                var vp = state.viewports[plane] ?? SliceViewport(plane: plane, viewSize: fallbackSize)
                if vp.viewSize == .zero { vp.viewSize = view?.bounds.size ?? fallbackSize }
                return vp
            }
            set { state.viewports[plane] = newValue }
        }
        var slice: Float { state.slice(for: plane) }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith o: UIGestureRecognizer) -> Bool {
            // Pinch and two-finger pan together; everything else exclusive.
            (g is UIPinchGestureRecognizer && o is UIPanGestureRecognizer && (o as! UIPanGestureRecognizer).minimumNumberOfTouches == 2)
            || (o is UIPinchGestureRecognizer && g is UIPanGestureRecognizer && (g as! UIPanGestureRecognizer).minimumNumberOfTouches == 2)
        }

        // MARK: One-finger drag — tool dependent

        @objc func onePan(_ g: UIPanGestureRecognizer) {
            guard let view else { return }
            let p = g.location(in: view)
            switch state.activeTool {
            case .navigate: scrollPan(g)
            case .windowLevel: windowLevelPan(g)
            case .measure: measurePan(g, at: p)
            case .probe:
                switch g.state {
                case .began, .changed: model.probePoint = p; model.probeActive = true
                default: model.probeActive = false
                }
            }
        }

        private func scrollPan(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: view)
            switch g.state {
            case .began:
                stopInertia(); scrollRemainder = 0; lastTranslation = t
            case .changed:
                applyScroll(delta: t.y - lastTranslation.y); lastTranslation = t
            case .ended:
                let v = g.velocity(in: view).y
                if abs(v) > 250 { startInertia(v) }
            default: break
            }
        }

        private func applyScroll(delta: CGFloat) {
            let h = viewport.viewSize.height
            let ppi = InteractionMath.pixelsPerImage(viewHeight: h, sliceCount: state.sliceCount(for: plane))
            let r = InteractionMath.stackScroll(accumulated: scrollRemainder, delta: delta, pixelsPerImage: ppi)
            scrollRemainder = r.remainder
            if r.steps != 0 { state.setSlice(slice + Float(r.steps), for: plane) }
        }

        private func startInertia(_ v: CGFloat) {
            inertiaVelocity = v
            inertiaLast = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(inertiaStep(_:)))
            link.add(to: .main, forMode: .common)
            inertia = link
        }
        @objc private func inertiaStep(_ link: CADisplayLink) {
            let now = link.timestamp
            let dt = CGFloat(max(now - inertiaLast, 1.0 / 120)); inertiaLast = now
            applyScroll(delta: inertiaVelocity * dt)
            inertiaVelocity *= pow(0.004, dt)   // ~UIScrollView normal deceleration feel
            let s = slice, maxS = Float(state.sliceCount(for: plane) - 1)
            if abs(inertiaVelocity) < 40 || s <= 0 || s >= maxS { stopInertia() }
        }
        private func stopInertia() { inertia?.invalidate(); inertia = nil }

        private func windowLevelPan(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: view)
            switch g.state {
            case .began:
                lastTranslation = t
                if wlMultiplier == nil { wlMultiplier = computeMultiplier() }
            case .changed:
                let dx = t.x - lastTranslation.x, dy = t.y - lastTranslation.y
                lastTranslation = t
                state.window = InteractionMath.windowLevel(state.window, dx: dx, dy: dy,
                                                           multiplier: wlMultiplier ?? InteractionMath.defaultWLMultiplier)
            default: break
            }
        }

        /// Dynamic range of the middle axial slice, as WindowLevelTool does for volumes.
        private func computeMultiplier() -> Float {
            let g = state.geometry, ct = state.loaded.ct
            let nx = Int(g.dims.x), ny = Int(g.dims.y), z = Int(g.dims.z) / 2
            let base = z * nx * ny
            guard nx * ny > 0, base + nx * ny <= ct.voxels.count else { return InteractionMath.defaultWLMultiplier }
            var lo = Int16.max, hi = Int16.min
            for i in stride(from: base, to: base + nx * ny, by: 3) { let v = ct.voxels[i]; lo = min(lo, v); hi = max(hi, v) }
            return InteractionMath.wlMultiplier(dynamicRange: Float(Int(hi) - Int(lo)))
        }

        private func measurePan(_ g: UIPanGestureRecognizer, at p: CGPoint) {
            let vp = viewport, geo = state.geometry
            // Start from where the finger first touched, not where the pan was recognised.
            let t = g.translation(in: view)
            switch g.state {
            case .began:
                let origin = CGPoint(x: p.x - t.x, y: p.y - t.y)
                if let hit = hitHandle(origin, vp: vp) {
                    editing = hit
                } else {
                    let v = vp.viewToVoxel(origin, slice: slice, geo)
                    let m = Measurement(plane: plane, start: v, end: vp.viewToVoxel(p, slice: slice, geo))
                    model.draft = m
                    editing = (m.id, .end)
                }
            case .changed:
                guard let e = editing else { return }
                let v = vp.viewToVoxel(p, slice: slice, geo)
                if var d = model.draft, d.id == e.id {
                    if e.handle == .end { d.end = v } else { d.start = v }
                    model.draft = d
                } else if let i = state.measurements.firstIndex(where: { $0.id == e.id }) {
                    if e.handle == .end { state.measurements[i].end = v } else { state.measurements[i].start = v }
                }
            case .ended:
                if let d = model.draft, d.id == editing?.id {
                    let a = vp.voxelToView(d.start, geo), b = vp.voxelToView(d.end, geo)
                    if InteractionMath.distance(a, b) > 6 { state.measurements.append(d) }
                    model.draft = nil
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
                editing = nil
            default:
                model.draft = nil; editing = nil
            }
        }

        private func hitHandle(_ p: CGPoint, vp: SliceViewport) -> (id: UUID, handle: Handle)? {
            let geo = state.geometry
            var best: (UUID, Handle, CGFloat)?
            for m in state.measurements where InteractionMath.isVisible(m, plane: plane, slice: slice) {
                for (h, v) in [(Handle.start, m.start), (.end, m.end)] {
                    let d = InteractionMath.distance(p, vp.voxelToView(v, geo))
                    if d < 24, d < (best?.2 ?? .infinity) { best = (m.id, h, d) }
                }
            }
            return best.map { ($0.0, $0.1) }
        }

        // MARK: Tap / double tap / hold

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let view else { return }
            let p = g.location(in: view)
            switch state.activeTool {
            case .navigate, .windowLevel:
                // CrosshairsTool: jump the shared cursor to the tapped point (keeps this plane's slice).
                stopInertia()
                let v = viewport.viewToVoxel(p, slice: slice, state.geometry)
                if state.geometry.contains(v) { state.cursor = state.geometry.clamp(v.rounded(.toNearestOrAwayFromZero)) }
            case .probe:
                model.probePoint = p
            case .measure:
                break
            }
        }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let view else { return }
            let p = g.location(in: view)
            if state.activeTool == .measure {
                // Delete the nearest measurement line on this slice.
                let vp = viewport, geo = state.geometry
                if let m = state.measurements.first(where: {
                    InteractionMath.isVisible($0, plane: plane, slice: slice)
                        && InteractionMath.distanceToSegment(p, vp.voxelToView($0.start, geo), vp.voxelToView($0.end, geo)) < 20
                }) {
                    state.measurements.removeAll { $0.id == m.id }
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    return
                }
            }
            if state.activeTool == .windowLevel {
                state.window = .softTissue
                return
            }
            var vp = viewport
            withAnimation(.snappy(duration: 0.25)) {
                vp.zoom = 1; vp.pan = .zero
                viewport = vp
            }
        }

        @objc func hold(_ g: UILongPressGestureRecognizer) {
            guard let view else { return }
            let p = g.location(in: view)
            switch g.state {
            case .began:
                // Press-and-hold probes in any tool (ProbeTool readout).
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                model.probePoint = p; model.probeActive = true
            case .changed: model.probePoint = p
            default:
                model.probeActive = false
                if state.activeTool != .probe { model.probePoint = nil }
            }
        }

        // MARK: Two fingers — pinch zoom + pan

        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            guard let view else { return }
            switch g.state {
            case .began:
                stopInertia()
                pinchStartZoom = viewport.zoom
            case .changed:
                var vp = viewport
                let newZoom = min(max(pinchStartZoom * g.scale, InteractionMath.minZoom), InteractionMath.maxZoom)
                vp.pan = InteractionMath.zoomPan(pan: vp.pan, zoom: vp.zoom, newZoom: newZoom,
                                                 focus: g.location(in: view), viewSize: vp.viewSize)
                vp.zoom = newZoom
                viewport = vp
            default: break
            }
        }

        @objc func twoPan(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: view)
            switch g.state {
            case .began: stopInertia(); lastTranslation = t
            case .changed:
                var vp = viewport
                vp.pan.width += t.x - lastTranslation.x
                vp.pan.height += t.y - lastTranslation.y
                lastTranslation = t
                viewport = vp
            default: break
            }
        }
    }
}
