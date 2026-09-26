// Owned by agent duo.
//
// Hinge-first iPhone Duo experience for the Generalizable viewer.
//
// Apple API surface used (verified in the iOS 27.1 SDK shipped with Xcode 27.1, not from memory).
// Paths relative to Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/
// iPhoneOS27.1.sdk/System/Library/Frameworks/:
// - `View.onHingeChange(isEnabled:_:)` (line ~24267), `DeviceHingeContext { hinge: DeviceHinge? }`,
//   `DeviceHinge { status: Status (.closed/.partiallyOpen/.fullyOpen), angle: Angle }` (~16741)
//     SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/arm64e-apple-ios.swiftinterface
//   (UIKit equivalent: UIKit.framework/Headers/UIHinge.h, UIHingeInteraction.h — angle in radians)
// - `GeometryProxy.reservedRegions(kind: .division)` → `ReservedRegion.frame` (~4843), same
//   SwiftUICore .swiftinterface; UIKit: UIKit.framework/Headers/UIViewReservedRegion.h
// - `View.sceneAccessory { CameraCaptureAccessory { } ; ExternalNonInteractiveAccessory { } }`
//   (~19803, ~20779, ~20802) SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftinterface
//   UIKit: UIKit.framework/Headers/UISceneAccessory.h, UIWindowScene.h. There is no general-purpose
//   "outer display" API: the outer panel is only reachable as a camera-capture accessory (system
//   decides, only while a capture session runs) or an external non-interactive display accessory.
// - `View.sensoryFeedback(_:trigger:condition:)` (~2549), same SwiftUI .swiftinterface — detent haptics.
//
// Layout precedent: split at the hinge's `.division` reserved region, the SDK's own contract for
// "a region where an element should divide into two separate regions" (UIViewReservedRegion.h),
// the same idea as Microsoft's Surface Duo TwoPaneView (microsoft/surface-duo-sdk) and Jetpack
// WindowManager FoldingFeature: separate content on each side of the fold, never across it.
//
// Hinge → anatomy mapping, kept consistent with the team's reference app (repo root):
//   App/Core/CutPlane.swift  `HingeMapping.tilt(forHingeAngle:)`: tilt = 180° − clamp(θ, 90...180);
//     tilt 0° = axial, tilt 90° = coronal, rotating about the patient's left–right axis (+x).
//   App/Core/CutPlane.swift  `HingeMapping.sliceFraction(forHingeAngle:closedDeg: 10, flatDeg: 180)`
//     for scrub mode (closed = inferior, flat = superior), used by App/Duo/HingeScrubDriver.swift.
//   App/Core/CutPlane.swift  `HingeSmoother` (exponential low-pass, alpha 0.35) — ported below.
//   App/Core/DuoFoldGeometry.swift: the upright display rises at elevation e = 180° − θ.
// Here: θ (0 = closed, 180 = flat).
//   Cut:   clipNormal = (0, sin t, cos t) through `state.cursor`, t = tilt. The renderer keeps
//          dot(n,p)+d <= 0 (Shaders/Volume.metal), so at t = 0 the superior half is removed and you
//          look down on the axial cut; at laptop (θ = 90°) the anterior half is removed (coronal).
//   Scrub: θ → axial slice via the team's sliceFraction.
// Posture layout (laptop / tent): upright half = axial 2D slice, flat half = 3D you can touch.

import OSLog
import SwiftUI
import simd

// MARK: - Posture model

enum DuoPosture: Equatable {
    case flat, folded, closed
}

enum HingeMapping: String, CaseIterable, Identifiable {
    case cut = "Cut", scrub = "Scrub"
    var id: String { rawValue }
    var hint: String {
        switch self {
        case .cut: "Fold to tilt the lid's slice · flat = same slice, 90° = front view"
        case .scrub: "Fold to scrub axial slices · closed = feet, flat = head"
        }
    }
}

/// Hinge state as the viewer consumes it — real (from `onHingeChange`) or simulated.
struct HingeReading: Equatable {
    /// Fold angle in degrees: 0 = closed, 180 = flat.
    var degrees: Double
    var isReal: Bool

    var posture: DuoPosture {
        if degrees < 12 { return .closed }
        if degrees > 165 { return .flat }
        return .folded
    }
}

enum HingeMath {
    /// Team A2 mapping (App/Core/CutPlane.swift `HingeMapping.tilt`): below 90° the tilt holds at 90°.
    static func tiltDegrees(hinge degrees: Double) -> Double { 180 - min(max(degrees, 90), 180) }

    /// Cutting-plane normal for a fold angle (see header). nil when flat (no cut).
    static func clipNormal(degrees: Double) -> SIMD3<Float>? {
        guard degrees <= 165 else { return nil }
        let t = Float(tiltDegrees(hinge: degrees) * .pi / 180)
        return simd_normalize(SIMD3<Float>(0, sin(t), cos(t)))
    }

    /// Team A12 mapping (App/Core/CutPlane.swift `HingeMapping.sliceFraction`, closedDeg 10).
    static func scrubFraction(degrees: Double) -> Float {
        Float(min(max((degrees - 10) / (180 - 10), 0), 1))
    }

    /// Named detents that get a haptic tick.
    static let detents: [(name: String, degrees: Double)] = [
        ("Flat", 180), ("Oblique", 135), ("Laptop", 90), ("Tent", 60),
    ]
    static func detent(at degrees: Double) -> String? {
        detents.first { abs($0.degrees - degrees) <= 3 }?.name
    }
}

/// Port of the team's `HingeSmoother` (App/Core/CutPlane.swift): exponential low-pass so hinge
/// jitter doesn't make the slice/cut flicker.
struct HingeLowPass {
    var alpha: Double = 0.35
    private var smoothed: Double?
    mutating func update(_ x: Double) -> Double {
        let next = smoothed.map { alpha * x + (1 - alpha) * $0 } ?? x
        smoothed = next
        return next
    }
    mutating func reset(_ x: Double) { smoothed = x }
}

// MARK: - Adaptive viewer

/// Wraps a viewer so it adapts to iPhone Duo fold/hinge state. On devices without hinge events
/// a small hinge pill (in the bottom safe area, or on the hinge seam when folded) simulates it.
struct DuoAdaptiveViewer<Content: View>: View {
    @Bindable var state: ViewerState
    @ViewBuilder var content: () -> Content

    @State private var realDegrees: Double?
    @State private var simDegrees: Double = 180
    @State private var simEnabled = false
    @State private var showSimulator = false
    @State private var forcePill = false
    @State private var mapping: HingeMapping = .cut
    @State private var findings: [CaseFinding] = []
    /// Put the cross-section on the other half, for devices/simulators that report the halves
    /// the other way round (`-gzSwapHalves YES`, or the switch in the hinge panel).
    @AppStorage("gzSwapHalves") private var swapHalves = false

    private var usingSim: Bool { simEnabled || realDegrees == nil }
    private var reading: HingeReading {
        usingSim ? HingeReading(degrees: simDegrees, isReal: false)
                 : HingeReading(degrees: realDegrees ?? 180, isReal: true)
    }
    /// The pill auto-hides once the real hinge talks (triple-tap brings it back).
    private var pillVisible: Bool { usingSim || forcePill || showSimulator }

    var body: some View {
        GeometryReader { proxy in
            let hinge = DuoHingeGeometry(proxy: proxy)
            let split = hinge.split(in: proxy.size)
            ZStack {
                switch reading.posture {
                case .flat, .closed:
                    content()
                case .folded:
                    foldedLayout(split: split)
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .topLeading) {
                if pillVisible { pill(split: split, safe: proxy.safeAreaInsets, size: proxy.size) }
            }
            .overlay { if showSimulator { simulatorPanel } }
        }
        .animation(.snappy(duration: 0.25), value: reading.posture)
        .modifier(HingeObserver(degrees: $realDegrees))
        .modifier(DuoAccessories(state: state))
        .onChange(of: reading) { _, r in apply(r) }
        .onAppear {
            // Demo/testing: `-gzHinge <degrees>` starts at a simulated fold (e.g. 90 = laptop).
            if let v = UserDefaults.standard.object(forKey: "gzHinge") as? String, let d = Double(v) {
                simDegrees = d; simEnabled = true
            }
            findings = CaseFindings.load(for: state.loaded.info) ?? []
            if reading.posture == .folded { pivotOnFinding() }
        }
        .onChange(of: reading.posture) { _, p in if p == .folded { pivotOnFinding() } }
        .onChange(of: mapping) { _, _ in apply(reading) }
        .sensoryFeedback(.impact(weight: .medium), trigger: HingeMath.detent(at: reading.degrees)) { _, new in new != nil }
        .sensoryFeedback(.selection, trigger: reading.posture)
        // Hidden trigger to re-show the pill on a real Duo; won't collide with slice drags.
        .simultaneousGesture(
            TapGesture(count: 3).onEnded { withAnimation { forcePill.toggle() } }
        )
    }

    // MARK: Hinge → state

    /// Folding pivots the cut on the case's finding ("Pivot · finding centre"): both halves go
    /// through it, so tilting the lid keeps the finding in view.
    private func pivotOnFinding() {
        guard mapping == .cut, let f = findings.first, let v = f.voxel(in: state.geometry) else { return }
        state.cursor = v
    }

    private func apply(_ r: HingeReading) {
        switch mapping {
        case .cut:
            let n = r.posture == .folded ? HingeMath.clipNormal(degrees: r.degrees) : nil
            if state.clipNormal != n { state.clipNormal = n }
        case .scrub:
            if state.clipNormal != nil { state.clipNormal = nil }
            guard r.posture == .folded else { return }
            let maxV = Float(state.sliceCount(for: .axial) - 1)
            state.setSlice(HingeMath.scrubFraction(degrees: r.degrees) * maxV, for: .axial)
        }
    }

    // MARK: Folded (laptop / tent) — the Layer Lens design (artifact PzfR7pyW3vmAhbzrGqz47A):
    // the flat bottom screen holds your place (axial slice + cyan cut line through the cursor);
    // the lid shows the slice through that line, tilted 180° − hinge. Flat = same slice,
    // laptop (90°) = front view.

    /// Layer Lens `render()`: t = 180 − hinge over the whole range (no A2 clamp at 90°), so
    /// folding past laptop keeps tilting the lid's plane past coronal, as in the design.
    private var lidTilt: Double { 180 - min(max(reading.degrees, 0), 180) }

    @ViewBuilder
    private func foldedLayout(split raw: DuoHingeGeometry.Split) -> some View {
        // split.first is the upright lid (top in laptop, left in book), split.second the flat base.
        let split = swapHalves
            ? DuoHingeGeometry.Split(first: raw.second, second: raw.first, seam: raw.seam, vertical: raw.vertical)
            : raw
        ZStack(alignment: .topLeading) {
            Color.black
            if mapping == .cut {
                ObliqueSliceView(state: state, tilt: lidTilt, hinge: reading.degrees, findings: findings)
                    .frame(width: split.first.width, height: split.first.height)
                    .clipped()
                    .offset(x: split.first.minX, y: split.first.minY)
                // Base: the side (sagittal) slice through the finding. The fold tilts the lid's
                // plane about the patient's left–right axis, which is exactly what a side view
                // shows as a line: the blue line is the lid's plane, rotating as you fold.
                SliceView(plane: .sagittal, state: state, showCrosshair: false)
                    .overlay { CutAngleLine(state: state, tilt: lidTilt) }
                    .overlay(alignment: .topLeading) {
                        CornerLabel(title: "SAGITTAL", detail: findings.isEmpty ? "Through the cursor" : "Through finding centre")
                    }
                    .overlay(alignment: .topTrailing) {
                        CornerLabel(title: "Cut \(Int(lidTilt.rounded()))°", detail: "Hinge \(Int(reading.degrees.rounded()))°",
                                    trailing: true)
                    }
                    .overlay(alignment: .bottomLeading) {
                        Text("Fold to change the cut angle")
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.85))
                            .padding(14)
                    }
                    .overlay(alignment: .bottomTrailing) { LayersCTToggle(state: state).padding(.bottom, 12).padding(.trailing, 40) }   // clear of the slice slider
                    .frame(width: split.second.width, height: split.second.height)
                    .clipped()
                    .offset(x: split.second.minX, y: split.second.minY)
            } else {
                SliceView(plane: .axial, state: state)
                    .frame(width: split.first.width, height: split.first.height)
                    .clipped()
                    .overlay(alignment: .topLeading) { badge("Axial · \(sliceLabel)") }
                    .offset(x: split.first.minX, y: split.first.minY)
                threeD
                    .frame(width: split.second.width, height: split.second.height)
                    .clipped()
                    .overlay(alignment: .topLeading) { badge("3D · \(cutLabel)") }
                    .overlay(alignment: .bottom) { hintLine }
                    .offset(x: split.second.minX, y: split.second.minY)
            }
            HingeSeam(rect: split.seam, vertical: split.vertical, degrees: reading.degrees)
                .allowsHitTesting(false)
        }
    }

    /// Cut mode needs the ray-caster (it honours `clipNormal`); meshes don't clip.
    @ViewBuilder private var threeD: some View {
        if mapping == .cut || state.volumeMode != .meshes {
            VolumeView(state: state)
        } else {
            MeshView(state: state)
        }
    }

    private var cutLabel: String {
        mapping == .scrub ? "hinge scrubs axial" : "cut \(Int(HingeMath.tiltDegrees(hinge: reading.degrees).rounded()))° from axial"
    }
    private var sliceLabel: String {
        "\(Int(state.slice(for: .axial)) + 1)/\(state.sliceCount(for: .axial))"
    }

    private var hintLine: some View {
        Label(mapping.hint, systemImage: "rectangle.portrait.and.arrow.forward")
            .labelStyle(.titleAndIcon)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.white.opacity(0.75))
            .lineLimit(1).minimumScaleFactor(0.7)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(.black.opacity(0.45), in: Capsule())
            .padding(.bottom, 8)
            .allowsHitTesting(false)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.monospacedDigit().weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(8)
            .allowsHitTesting(false)
    }

    // MARK: Hinge pill (simulator / demo fallback)

    /// Folded: centred on the hinge seam (no imagery there). Flat: in the bottom safe-area strip
    /// beside the home indicator, trailing, so it never sits on a pane.
    private func pill(split: DuoHingeGeometry.Split, safe: EdgeInsets, size: CGSize) -> some View {
        let label = HStack(spacing: 5) {
            Image(systemName: reading.isReal ? "laptopcomputer" : "hand.draw")
            Text(reading.posture == .flat && !reading.isReal ? "Fold" : "\(Int(reading.degrees.rounded()))°")
                .monospacedDigit()
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.white.opacity(0.9))
        .padding(.horizontal, 9).frame(height: 22)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.15)))
        let pillW: CGFloat = 76, pillH: CGFloat = 22
        let origin: CGPoint
        if reading.posture == .folded {
            origin = split.vertical
                ? CGPoint(x: split.seam.midX - pillW / 2, y: size.height - safe.bottom - pillH - 8)
                : CGPoint(x: size.width - pillW - 12, y: split.seam.midY - pillH / 2)
        } else {
            // Bottom safe-area strip (home-indicator row); fall back to just inside the edge.
            let y = safe.bottom >= pillH ? size.height + (safe.bottom - pillH) / 2 : size.height - pillH - 2
            origin = CGPoint(x: size.width - pillW - 14, y: y)
        }
        return Button { withAnimation(.snappy) { showSimulator.toggle() } } label: { label }
            .buttonStyle(.plain)
            .frame(width: pillW, height: pillH)
            .offset(x: origin.x, y: origin.y)
            .accessibilityLabel("Hinge control")
    }

    private var simulatorPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Hinge", systemImage: "rectangle.portrait.and.arrow.forward").font(.headline)
                Spacer()
                Text(reading.isReal ? "device hinge" : "simulated")
                    .font(.caption).foregroundStyle(.secondary)
                Button { withAnimation { showSimulator = false } } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
            HStack {
                Text("\(Int(simDegrees))°").monospacedDigit().frame(width: 44, alignment: .leading)
                Slider(value: $simDegrees, in: 0...180, step: 1) { _ in simEnabled = true }
            }
            HStack(spacing: 8) {
                ForEach(HingeMath.detents, id: \.name) { d in
                    Button(d.name) { simEnabled = true; withAnimation(.smooth) { simDegrees = d.degrees } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            Picker("Mapping", selection: $mapping) {
                ForEach(HingeMapping.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            Text(mapping == .cut ? "Folded: lid = the slice through the cyan line, tilted by the fold; base = axial. Drag the handle to move the line." : "Folded: top = axial slice, bottom = 3D. \(mapping.hint).")
                .font(.caption2).foregroundStyle(.secondary)
            Toggle("Swap screens (cross-section on the other half)", isOn: $swapHalves).font(.caption)
            if realDegrees != nil {
                Toggle("Override device hinge", isOn: $simEnabled).font(.caption)
            }
        }
        .padding(14)
        .frame(maxWidth: 360)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 12)
        .padding()
        .frame(maxHeight: .infinity, alignment: .bottom)
    }
}

// MARK: - Hinge geometry (division reserved region)

struct DuoHingeGeometry {
    /// Hinge rect in the wrapper's local coordinates, if the system reports one.
    var division: CGRect?

    init(proxy: GeometryProxy) {
        if #available(iOS 27.1, *) {
            division = proxy.reservedRegions(kind: .division).first?.frame
        } else {
            division = nil
        }
    }

    struct Split { var first: CGRect; var second: CGRect; var seam: CGRect; var vertical: Bool }

    func split(in size: CGSize) -> Split {
        let bounds = CGRect(origin: .zero, size: size)
        let seam: CGRect
        if let d = division, !d.isEmpty || d.width > 0 || d.height > 0 {
            seam = d
        } else if size.width > size.height {
            seam = CGRect(x: size.width / 2 - 1, y: 0, width: 2, height: size.height)   // book
        } else {
            seam = CGRect(x: 0, y: size.height / 2 - 1, width: size.width, height: 2)   // laptop
        }
        let vertical = seam.height >= seam.width   // hinge runs top→bottom: side-by-side panes
        if vertical {
            let a = CGRect(x: 0, y: 0, width: max(seam.minX, 0), height: size.height)
            let b = CGRect(x: seam.maxX, y: 0, width: max(size.width - seam.maxX, 0), height: size.height)
            return Split(first: a.intersection(bounds), second: b.intersection(bounds), seam: seam, vertical: true)
        } else {
            let a = CGRect(x: 0, y: 0, width: size.width, height: max(seam.minY, 0))
            let b = CGRect(x: 0, y: seam.maxY, width: size.width, height: max(size.height - seam.maxY, 0))
            return Split(first: a.intersection(bounds), second: b.intersection(bounds), seam: seam, vertical: false)
        }
    }
}

// MARK: - Fold design pieces (monospace corner labels, blue cut line, Layers | CT)

enum FoldStyle {
    static let blue = Color(red: 0.36, green: 0.58, blue: 0.95)
    static let amber = Color(red: 0.93, green: 0.66, blue: 0.29)
    static let dim = Color.white.opacity(0.55)
}

/// Two-line monospace corner label: bold title, dim detail.
struct CornerLabel: View {
    var title: String
    var detail: String? = nil
    var trailing = false
    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: 2) {
            Text(title).font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(.white.opacity(0.92))
            if let detail {
                Text(detail).font(.system(size: 10, weight: .regular, design: .monospaced)).foregroundStyle(FoldStyle.dim)
            }
        }
        .padding(12)
        .allowsHitTesting(false)
    }
}

/// The lid's plane seen edge-on in the side view: a line through the pivot along the plane's
/// in-plane "up" direction (0, cos t, sin t) (same basis as ObliqueRenderer), with a dot at the pivot.
private struct CutAngleLine: View {
    @Bindable var state: ViewerState
    var tilt: Double
    var body: some View {
        GeometryReader { geo in
            if let vp = state.viewports[.sagittal], vp.viewSize.width > 0 {
                let g = state.geometry, t = Float(tilt * .pi / 180)
                let p = vp.voxelToView(state.cursor, g)
                // Direction in mm → voxels, then projected: a far point gives the on-screen angle.
                let dir = SIMD3<Float>(0, cos(t) / g.spacing.y, sin(t) / g.spacing.z) * 100
                let q = vp.voxelToView(state.cursor + dir, g)
                let dx = q.x - p.x, dy = q.y - p.y, len = max(hypot(dx, dy), 0.001)
                let reach = hypot(geo.size.width, geo.size.height)
                let ux = dx / len * reach, uy = dy / len * reach
                Path { path in
                    path.move(to: CGPoint(x: p.x - ux, y: p.y - uy)); path.addLine(to: CGPoint(x: p.x + ux, y: p.y + uy))
                }
                .stroke(FoldStyle.blue, lineWidth: 1.5)
                Circle().fill(FoldStyle.amber).frame(width: 9, height: 9)
                    .overlay(Circle().stroke(.black.opacity(0.8), lineWidth: 1.5))
                    .position(p)
            }
        }
        .allowsHitTesting(false)
    }
}

/// "Layers | CT": coloured structure overlay on, or the plain grayscale scan.
private struct LayersCTToggle: View {
    @Bindable var state: ViewerState
    var body: some View {
        HStack(spacing: 0) {
            segment("Layers", on: state.showLabels) { state.showLabels = true }
            segment("CT", on: !state.showLabels) { state.showLabels = false }
        }
        .padding(2)
        .background(Capsule().fill(.white.opacity(0.12)))
    }
    private func segment(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { withAnimation(.snappy(duration: 0.2), action) }) {
            Text(title).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(on ? .black : .white.opacity(0.7))
                .padding(.horizontal, 14).frame(height: 26)
                .background(Capsule().fill(on ? Color.white : .clear))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A glowing seam along the hinge, tinted by how deep the cut is.
private struct HingeSeam: View {
    var rect: CGRect
    var vertical: Bool
    var degrees: Double
    var body: some View {
        let t = 1 - min(max(degrees / 180, 0), 1)
        let glow = Color(hue: 0.52 - 0.4 * t, saturation: 0.9, brightness: 1)
        Rectangle()
            .fill(glow.opacity(0.9))
            .frame(width: vertical ? max(rect.width, 2) : rect.width,
                   height: vertical ? rect.height : max(rect.height, 2))
            .shadow(color: glow, radius: 8)
            .offset(x: rect.minX, y: rect.minY)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Real hinge events (iOS 27.1+)

private struct HingeObserver: ViewModifier {
    @Binding var degrees: Double?
    @State private var lowPass = HingeLowPass()
    /// PRD A10: Apple doesn't document whether angle 0 means closed or flat. Learned from the
    /// endpoints, where `status` is authoritative: fully open reading ~0°, or closed reading
    /// ~180°, means the device reports deflection-from-flat, so every angle is flipped.
    @State private var flatReadsZero = false
    private static let log = Logger(subsystem: "dev.patliu.generalizable", category: "hinge")
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, new in
                if let h = new.hinge {
                    let raw = h.angle.degrees
                    Self.log.info("hinge status=\(String(describing: h.status), privacy: .public) angle=\(raw, privacy: .public)")
                    if h.status == .fullyOpen, raw < 30 { flatReadsZero = true }
                    if h.status == .closed, raw > 150 { flatReadsZero = true }
                    let opening = min(max(flatReadsZero ? 180 - raw : raw, 0), 180)
                    // Status is authoritative for the endpoints; the angle can be coarse.
                    if h.status == .closed { lowPass.reset(0); degrees = 0 }
                    else if h.status == .fullyOpen { lowPass.reset(180); degrees = 180 }
                    else { degrees = lowPass.update(opening) }
                } else {
                    degrees = nil
                }
            }
        } else {
            content
        }
    }
}

// MARK: - Outer / external display content

private struct DuoAccessories: ViewModifier {
    let state: ViewerState
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.sceneAccessory {
                // Outer panel while a camera capture session runs (system decides placement).
                CameraCaptureAccessory { PatientFacingView(state: state) }
                // AirPlay / external display: colleague- or patient-facing, non-interactive.
                ExternalNonInteractiveAccessory { PatientFacingView(state: state) }
            }
        } else {
            content
        }
    }
}

/// Patient/colleague-facing view: the 3D anatomy with the findings called out.
struct PatientFacingView: View {
    @Bindable var state: ViewerState
    var body: some View {
        let lesions = state.visibleOrgans.filter(\.isLesion).sorted { $0.rawValue < $1.rawValue }
        ZStack(alignment: .bottom) {
            Color.black.ignoresSafeArea()
            MeshView(state: state)
            VStack(alignment: .leading, spacing: 4) {
                if let ai = state.loaded.ai {
                    let p = ai.series.first { $0.name == ai.headlineClass }?.probability ?? 0
                    Text("\(ai.headlineClass.capitalized) hemorrhage · AI \(String(format: "%.1f", p * 100))%")
                        .font(.largeTitle.weight(.bold))
                }
                Text(state.loaded.info.title).font(.headline)
                if lesions.isEmpty {
                    Text("No lesion labelled").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    ForEach(lesions) { o in
                        Label(o.displayName, systemImage: "circle.fill")
                            .foregroundStyle(o.color)
                            .font(.subheadline.weight(.semibold))
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial)
        }
        .foregroundStyle(.white)
    }
}

/// Cyan line on the base (axial) slice marking where the lid's plane cuts it: the patient's
/// left–right line through the cursor (Layer Lens `hline(bctx, …, "#45CFE0")`). The design moves
/// the cut by dragging the bottom screen (`moveCut`); here a pan on the slice already scrolls
/// slices (the design's wheel), so the drag lives on a handle at the line's leading end instead.
private struct CutLine: View {
    @Bindable var state: ViewerState
    var visible: Bool
    private let cyan = Color(red: 0.27, green: 0.81, blue: 0.88)
    private static let space = "gz.cutline"
    var body: some View {
        GeometryReader { geo in
            if visible, let vp = state.viewports[.axial], vp.viewSize.width > 0 {
                let y = vp.voxelToView(state.cursor, state.geometry).y
                Path { p in p.move(to: CGPoint(x: 0, y: y)); p.addLine(to: CGPoint(x: geo.size.width, y: y)) }
                    .stroke(cyan, lineWidth: 2)
                    .shadow(color: .black.opacity(0.6), radius: 1.5)
                    .allowsHitTesting(false)
                Capsule().fill(cyan)
                    .overlay(Image(systemName: "arrow.up.and.down").font(.system(size: 10, weight: .bold)).foregroundStyle(.black))
                    .frame(width: 34, height: 20)
                    .frame(width: 56, height: 44)
                    .contentShape(Rectangle())
                    .position(x: 36, y: y)
                    .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space)).onChanged { v in
                        let vox = vp.viewToVoxel(CGPoint(x: geo.size.width / 2, y: v.location.y),
                                                 slice: state.cursor.z, state.geometry)
                        let maxY = Float(state.geometry.dims.y - 1)
                        state.cursor.y = min(max(vox.y.rounded(), 0), maxY)
                    })
                    .accessibilityLabel("Cut line")
                    .accessibilityAdjustableAction { dir in
                        let maxY = Float(state.geometry.dims.y - 1)
                        state.cursor.y = min(max(state.cursor.y + (dir == .increment ? 5 : -5), 0), maxY)
                    }
            }
        }
        .coordinateSpace(name: Self.space)
    }
}

/// Magenta rings where the axial slice crosses a finding's sphere (Layer Lens `ring()`: radius
/// √(r² − d²) of the sphere at distance d from the slice; numbered badge; label when selected).
private struct FindingRings: View {
    @Bindable var state: ViewerState
    var findings: [CaseFinding]
    var body: some View {
        GeometryReader { geo in
            if let vp = state.viewports[.axial], vp.viewSize.width > 0 {
                let g = state.geometry
                ForEach(Array(findings.enumerated()), id: \.element.id) { k, f in
                    if let v = f.voxel(in: g) {
                        let r = Float(f.radiusMM ?? 10)
                        let d = (v.z - state.cursor.z) * g.spacing.z
                        if abs(d) < r {
                            let c = vp.voxelToView(v, g)
                            let rad = CGFloat((r * r - d * d).squareRoot()) * vp.pointsPerMM(g)
                            LensRing(center: c, radius: rad, number: k + 1, label: f.title, containerWidth: geo.size.width)
                        }
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// The design's finding ring: dark halo, magenta circle, numbered badge, title chip.
struct LensRing: View {
    var center: CGPoint
    var radius: CGFloat
    var number: Int
    var label: String
    /// Width of the pane this ring is drawn in, if known. When the label chip would run past
    /// the right edge, it flips to the left of the badge instead of clipping.
    var containerWidth: CGFloat? = nil
    static let magenta = Color(red: 1, green: 0.243, blue: 0.647)
    private static let chipWidth: CGFloat = 240
    var body: some View {
        let r = max(radius, 9) + 5
        let badge = CGPoint(x: center.x + r * 0.72, y: center.y - r * 0.72)
        let fitsRight = containerWidth.map { badge.x + 12 + Self.chipWidth <= $0 } ?? true
        let chipCenterX = fitsRight ? badge.x + 12 + Self.chipWidth / 2 : badge.x - 12 - Self.chipWidth / 2
        let chipAlignment: Alignment = fitsRight ? .leading : .trailing
        ZStack(alignment: .topLeading) {
            Circle().stroke(.black.opacity(0.6), lineWidth: 5)
                .frame(width: 2 * r, height: 2 * r).position(center)
            Circle().stroke(Self.magenta, lineWidth: 2.6)
                .frame(width: 2 * r, height: 2 * r).position(center)
            Circle().fill(Self.magenta).frame(width: 18, height: 18)
                .overlay(Text("\(number)").font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(.white))
                .position(badge)
            LensTag(text: label, color: .white, fill: Self.magenta.opacity(0.92))
                .fixedSize()
                .frame(width: Self.chipWidth, alignment: chipAlignment)
                .position(x: chipCenterX, y: badge.y)
        }
    }
}
