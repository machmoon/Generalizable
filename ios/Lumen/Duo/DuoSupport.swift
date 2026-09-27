// Owned by agent duo.
//
// Hinge-first iPhone Duo experience for the Lumen viewer.
//
// Apple API surface used (verified in the iOS 27.1 SDK shipped with Xcode 27.1, not from memory):
// - SwiftUI `View.onHingeChange(isEnabled:_:)`, `DeviceHingeContext { hinge: DeviceHinge? }`,
//   `DeviceHinge { status: Status (.closed/.partiallyOpen/.fullyOpen), angle: Angle }`
//     SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/arm64e-apple-ios.swiftinterface
//   (UIKit equivalent: UIKit.framework/Headers/UIHinge.h, UIHingeInteraction.h — angle in radians)
// - SwiftUI `GeometryProxy.reservedRegions(kind: .division)` → `ReservedRegion.frame`
//   (where the hinge divides the screen), same SwiftUICore .swiftinterface;
//   UIKit: UIKit.framework/Headers/UIViewReservedRegion.h, UIView.h (ReservedRegion category)
// - SwiftUI `View.sceneAccessory { CameraCaptureAccessory { } ; ExternalNonInteractiveAccessory { } }`
//     SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-ios.swiftinterface
//   UIKit: UIKit.framework/Headers/UISceneAccessory.h, UIWindowScene.h
//   (UIWindowSceneSessionRoleCameraCaptureAccessory). There is no general-purpose "outer display"
//   API: the outer panel is only reachable as a camera-capture accessory (system decides, only while
//   a capture session runs) or an external display accessory (non-interactive).
// (All paths relative to Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.1.sdk/System/Library/Frameworks/.)
//
// Layout precedent: split at the hinge's `.division` reserved region, the SDK's own contract for
// "a region where an element should divide into two separate regions" (UIViewReservedRegion.h),
// the same idea as Microsoft's Surface Duo TwoPaneView (microsoft/surface-duo-sdk, and
// Jetpack WindowManager FoldingFeature: separate content on each side of the fold).
//
// Hinge → anatomy mapping ("the hinge is a physical cutting plane"):
//   Fold angle θ (0 = closed, 180° = flat). The phone's lower half is the patient lying on the table
//   (coronal plane). The upright half is the cut: its tilt from the table is φ = 180° − θ, rotating
//   about the patient's left–right axis (canonical +x). So
//       clipNormal = normalize((0, cos φ, sin φ))  in canonical voxel space, through `state.cursor`
//   θ = 180° (flat)   → clip off (nil), the normal viewer is shown
//   θ = 135°          → 45° oblique cut between coronal and axial
//   θ =  90° (laptop) → pure axial cut: the upright screen *is* the axial slice plane
//   θ <  90°          → keeps tilting past axial toward the reversed coronal (tent)
// Alternative "Scrub" mode: θ ∈ [20°,160°] maps linearly onto the focused plane's slice range.

import SwiftUI
import simd

// MARK: - Posture model

enum DuoPosture: Equatable {
    case flat, folded, closed
}

enum HingeMapping: String, CaseIterable, Identifiable {
    case cut = "Cut", scrub = "Scrub"
    var id: String { rawValue }
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
    /// Oblique cutting-plane normal for a fold angle (see header).
    static func clipNormal(degrees: Double) -> SIMD3<Float>? {
        guard degrees <= 165 else { return nil }
        let phi = Float((180 - degrees) * .pi / 180)
        return simd_normalize(SIMD3<Float>(0, cos(phi), sin(phi)))
    }

    /// Fraction 0...1 for scrub mode.
    static func scrubFraction(degrees: Double) -> Float {
        Float(min(max((degrees - 20) / 140, 0), 1))
    }
}

// MARK: - Adaptive viewer

/// Wraps a viewer so it adapts to iPhone Duo fold/hinge state. No-op on other devices unless the
/// hidden hinge simulator (triple-tap with two fingers, or the chip) is used.
struct DuoAdaptiveViewer<Content: View>: View {
    @Bindable var state: ViewerState
    @ViewBuilder var content: () -> Content

    @State private var realDegrees: Double?
    @State private var simDegrees: Double = 180
    @State private var simEnabled = false
    @State private var showSimulator = false
    @State private var mapping: HingeMapping = .cut

    private var reading: HingeReading {
        if simEnabled || realDegrees == nil { return HingeReading(degrees: simDegrees, isReal: false) }
        return HingeReading(degrees: realDegrees ?? 180, isReal: true)
    }

    var body: some View {
        GeometryReader { proxy in
            let hinge = DuoHingeGeometry(proxy: proxy)
            ZStack {
                switch reading.posture {
                case .flat, .closed:
                    content()
                case .folded:
                    foldedLayout(hinge: hinge, size: proxy.size)
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .bottomLeading) { hingeChip }
            .overlay { if showSimulator { simulatorPanel } }
        }
        .animation(.snappy(duration: 0.25), value: reading.posture)
        .modifier(HingeObserver(degrees: $realDegrees))
        .modifier(DuoAccessories(state: state))
        .onChange(of: reading) { _, r in apply(r) }
        .onChange(of: mapping) { _, _ in apply(reading) }
        // Hidden debug trigger that won't collide with one-finger slice gestures.
        .simultaneousGesture(
            TapGesture(count: 3).onEnded { withAnimation { showSimulator.toggle() } }
        )
    }

    // MARK: Hinge → state

    private func apply(_ r: HingeReading) {
        switch mapping {
        case .cut:
            let n = r.posture == .folded ? HingeMath.clipNormal(degrees: r.degrees) : nil
            if state.clipNormal != n { state.clipNormal = n }
        case .scrub:
            if state.clipNormal != nil { state.clipNormal = nil }
            guard r.posture == .folded else { return }
            let plane = state.focusedPlane
            let maxV = Float(state.sliceCount(for: plane) - 1)
            state.setSlice(HingeMath.scrubFraction(degrees: r.degrees) * maxV, for: plane)
        }
    }

    // MARK: Folded: lightbox (2D) + model (3D), split exactly at the hinge

    @ViewBuilder
    private func foldedLayout(hinge: DuoHingeGeometry, size: CGSize) -> some View {
        let split = hinge.split(in: size)
        ZStack(alignment: .topLeading) {
            Color.black
            // Upright half (top / leading) = the model; flat half = the lightbox you touch.
            threeD
                .frame(width: split.first.width, height: split.first.height)
                .clipped()
                .overlay(alignment: .topLeading) { badge("3D · \(cutLabel)") }
                .offset(x: split.first.minX, y: split.first.minY)
            SliceView(plane: state.focusedPlane, state: state)
                .frame(width: split.second.width, height: split.second.height)
                .clipped()
                .overlay(alignment: .topLeading) { badge("\(state.focusedPlane.rawValue.capitalized) · \(sliceLabel)") }
                .offset(x: split.second.minX, y: split.second.minY)
            HingeSeam(rect: split.seam, vertical: split.vertical, degrees: reading.degrees)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var threeD: some View {
        switch state.volumeMode {
        case .meshes: MeshView(state: state)
        case .volume, .mip: VolumeView(state: state)
        }
    }

    private var cutLabel: String {
        mapping == .scrub ? "hinge scrubs slices" : "hinge cut \(Int(180 - reading.degrees))°"
    }
    private var sliceLabel: String {
        "\(Int(state.slice(for: state.focusedPlane)) + 1)/\(state.sliceCount(for: state.focusedPlane))"
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.monospacedDigit().weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(8)
            .allowsHitTesting(false)
    }

    // MARK: Debug / demo hinge control

    private var hingeChip: some View {
        Button { withAnimation { showSimulator.toggle() } } label: {
            HStack(spacing: 4) {
                Image(systemName: reading.isReal ? "laptopcomputer" : "slider.horizontal.below.rectangle")
                Text("\(Int(reading.degrees))°").monospacedDigit()
            }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(.ultraThinMaterial, in: Capsule())
            .opacity(reading.isReal && !showSimulator ? 0.35 : 0.8)
        }
        .buttonStyle(.plain)
        .padding(10)
    }

    private var simulatorPanel: some View {
        VStack(spacing: 10) {
            HStack {
                Text("Hinge").font(.headline)
                Spacer()
                Text(reading.isReal ? "device" : "simulated")
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
                ForEach([("Flat", 180.0), ("Oblique", 135.0), ("Laptop", 90.0), ("Tent", 60.0)], id: \.0) { name, deg in
                    Button(name) { simEnabled = true; withAnimation { simDegrees = deg } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            Picker("Mapping", selection: $mapping) {
                ForEach(HingeMapping.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            if realDegrees != nil {
                Toggle("Override device hinge", isOn: $simEnabled).font(.caption)
            }
        }
        .padding(14)
        .frame(maxWidth: 340)
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
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.onHingeChange { _, new in
                if let h = new.hinge {
                    // Status is authoritative for the endpoints; the angle can be coarse.
                    if h.status == .closed { degrees = 0 }
                    else if h.status == .fullyOpen { degrees = 180 }
                    else { degrees = min(max(h.angle.degrees, 0), 180) }
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
