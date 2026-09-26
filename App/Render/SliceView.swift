// SliceView.swift
// The contract's SliceView and SliceMode (docs/contracts/render-interface.md), design spec section 2.
//
// Layers, back to front (the demo label is last and never hidden):
//   1. SliceMetalView: the Metal reslice (SliceRenderer.swift / Slice.metal).
//   2. Finding ring (Canvas) + selection pulse + title chip.
//   3. Chrome: 2 pt cutAccent bar, hero tilt block (top-leading), mode tag (top-trailing).
//   4. "Demo only — not a diagnosis." (bottom-leading).
//
// The slice is always centred on the plane origin (pivot + offset): u = 0, v = 0 is the view centre.
// No gestures on this view.

import SwiftUI
import simd

enum SliceMode { case layers, ct }          // "what patients see" / "what doctors see"

// Tokens from the design spec's shared table. E2 owns RenderStyle.swift per the spec, but this
// lane's file list is fixed to three files, so they live here, fileprivate, to avoid a duplicate
// type if RenderStyle.swift lands separately.
fileprivate enum SliceStyle {
    static let cutAccent = Color(red: 100 / 255, green: 210 / 255, blue: 1)          // #64D2FF
    static let findingInk = Color(red: 1, green: 45 / 255, blue: 149 / 255)           // #FF2D95
    static let halo = Color.black.opacity(0.55)
    static let labelSecondary = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.6)
    static let plate = Color.black.opacity(0.55)
    static let plateShape = RoundedRectangle(cornerRadius: 8, style: .continuous)
}

fileprivate extension View {
    func slicePlate(h: CGFloat = 10, v: CGFloat = 6) -> some View {
        padding(.horizontal, h).padding(.vertical, v)
            .background(SliceStyle.plate, in: SliceStyle.plateShape)
    }
}

/// Orientation name for a tilt, matching the detents (0 / 45 / 90, within 1°).
enum SliceOrientationName {
    static func name(forTilt t: Double) -> String {
        if abs(t) <= 1 { return "Axial" }
        if abs(t - 90) <= 1 { return "Coronal" }
        if abs(t - 45) <= 1 { return "Oblique 45" }
        return "Oblique"
    }
}

struct SliceView: View {
    let bundle: CaseBundle
    let cut: CutPlane
    let mode: SliceMode
    let visibleLayerIDs: Set<Int>
    let selectedFinding: CaseFinding?
    let window: [Double]
    /// Optional hinge readout (HingeTiltDriver.hingeStatusText), e.g. "Hinge 120° → Tilt 60° · Oblique"
    /// or "Closed · tilt held at 60°". Nil shows the manual form "Tilt 60° · Oblique".
    /// Defaulted, so the contract's six-argument init is unchanged.
    let statusText: String?

    init(bundle: CaseBundle,
         cut: CutPlane,
         mode: SliceMode,
         visibleLayerIDs: Set<Int>,
         selectedFinding: CaseFinding?,
         window: [Double],
         statusText: String? = nil) {
        self.bundle = bundle
        self.cut = cut
        self.mode = mode
        self.visibleLayerIDs = visibleLayerIDs
        self.selectedFinding = selectedFinding
        self.window = window
        self.statusText = statusText
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulseScale: CGFloat = 1
    @State private var pulseOpacity: Double = 0
    @State private var lastTiltChange = Date.distantPast
    @State private var pulseTask: Task<Void, Never>?

    // MARK: Derived

    private var frame: SlicePlaneFrame { SlicePlaneFrame(cut: cut, bundle: bundle) }

    private var tiltInt: Int { Int(cut.tiltDegrees.rounded()) }

    private var isSynthetic: Bool { bundle.name == "sun" || bundle.name == "circuit" }

    private static func pair(_ w: [Double]) -> SIMD2<Float>? {
        w.count >= 2 ? SIMD2<Float>(Float(w[0]), Float(w[1])) : nil
    }

    private var activeWindow: SIMD2<Float> {
        Self.pair(window) ?? Self.pair(bundle.meta.windowPresets["soft"] ?? []) ?? SIMD2(40, 400)
    }

    /// Layers mode dims CT with the soft preset (design spec 2), falling back to the given window.
    private var softWindow: SIMD2<Float> {
        Self.pair(bundle.meta.windowPresets["soft"] ?? []) ?? activeWindow
    }

    private var renderParams: SliceRenderParams {
        SliceRenderParams(frame: frame,
                          modeIsCT: mode == .ct,
                          visibleLayerIDs: visibleLayerIDs,
                          window: activeWindow,
                          softWindow: softWindow)
    }

    private var presetName: String {
        let match = bundle.meta.windowPresets.first { $0.value.count >= 2 && window.count >= 2
            && abs($0.value[0] - window[0]) < 0.5 && abs($0.value[1] - window[1]) < 0.5 }?.key
        switch match {
        case "soft": return isSynthetic ? "Soft" : "Soft tissue"
        case let k?: return k.prefix(1).uppercased() + k.dropFirst()
        case nil: return "Custom"
        }
    }

    private var modeTag: String {
        switch mode {
        case .layers: return "LAYERS"
        case .ct: return isSynthetic ? "Density · \(presetName)" : "CT · \(presetName)"
        }
    }

    private var readout: String {
        statusText ?? "Tilt \(tiltInt)° · \(SliceOrientationName.name(forTilt: cut.tiltDegrees))"
    }

    private var accessibilityValueText: String {
        var s = mode == .layers ? "Layers view. " : (isSynthetic ? "Density view. " : "CT view. ")
        s += "Tilt \(tiltInt) degrees. "
        if let f = selectedFinding {
            let atPivot = simd_distance(cut.pivotMM, f.center) < 0.5
            if atPivot && abs(cut.sliceOffsetMM) < 0.5 {
                s += "Slice at the finding."
            } else if atPivot {
                s += "Slice \(Int(abs(cut.sliceOffsetMM).rounded())) millimetres from the finding."
            }
        }
        return s.trimmingCharacters(in: .whitespaces)
    }

    // MARK: Body

    var body: some View {
        ZStack {
            Color.black
            ZStack {
                SliceMetalView(bundle: bundle, params: renderParams)
                GeometryReader { proxy in
                    findingOverlay(SliceGeometry(frame: frame, size: proxy.size))
                }
                .allowsHitTesting(false)
                chrome
                if let failure = SliceMetal.shared.failure {
                    Text(failure).font(.footnote).foregroundStyle(.white).slicePlate()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Cross-section")
            .accessibilityValue(accessibilityValueText)
            .accessibilityAddTraits(.isImage)

            demoLabel
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .clipped()
        .onChange(of: cut.tiltDegrees) { _, _ in lastTiltChange = Date() }
        .onChange(of: selectedFinding?.id) { _, new in
            if new != nil { pulse() }
        }
        .onDisappear { pulseTask?.cancel() }
    }

    // MARK: Finding ring

    @ViewBuilder
    private func findingOverlay(_ g: SliceGeometry) -> some View {
        if let f = selectedFinding {
            let c = g.planeCoords(ofMM: f.center)
            let center = g.point(u: c.u, v: c.v)
            let r = Float(f.radiusMM)
            let inPlane = abs(c.d) <= r
            let ringRadius: CGFloat = inPlane
                ? max(g.points(fromMM: (max(r * r - c.d * c.d, 0)).squareRoot()) + 4, 18)
                : 14

            ZStack {
                Canvas { ctx, _ in
                    let rect = CGRect(x: center.x - ringRadius, y: center.y - ringRadius,
                                      width: ringRadius * 2, height: ringRadius * 2)
                    let path = Path(ellipseIn: rect)
                    if inPlane {
                        ctx.stroke(path, with: .color(SliceStyle.halo), lineWidth: 4)
                        ctx.stroke(path, with: .color(SliceStyle.findingInk), lineWidth: 2)
                    } else {
                        ctx.stroke(path, with: .color(SliceStyle.findingInk.opacity(0.5)),
                                   style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    }
                }

                Circle()
                    .stroke(SliceStyle.findingInk, lineWidth: 2)
                    .frame(width: ringRadius * 2, height: ringRadius * 2)
                    .scaleEffect(pulseScale)
                    .opacity(pulseOpacity)
                    .position(center)

                let chipY = center.y - ringRadius - 8 - 12
                Text(f.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .slicePlate(h: 8, v: 4)
                    .fixedSize()
                    .position(x: min(max(center.x, 80), max(g.size.width - 80, 80)),
                              y: max(chipY, 14))
            }
        }
    }

    /// Selection pulse: scale 1.0 -> 1.8, opacity 0.9 -> 0, 0.6 s easeOut, twice.
    /// Never during a fold (tilt changed in the last 0.3 s), never under Reduce Motion.
    private func pulse() {
        pulseTask?.cancel()
        guard !reduceMotion, Date().timeIntervalSince(lastTiltChange) > 0.3 else { return }
        pulseTask = Task { @MainActor in
            for _ in 0..<2 {
                var t = Transaction(); t.disablesAnimations = true
                withTransaction(t) { pulseScale = 1; pulseOpacity = 0.9 }
                try? await Task.sleep(nanoseconds: 16_000_000)
                withAnimation(.easeOut(duration: 0.6)) { pulseScale = 1.8; pulseOpacity = 0 }
                try? await Task.sleep(nanoseconds: 600_000_000)
                if Task.isCancelled { return }
            }
        }
    }

    // MARK: Chrome

    private var chrome: some View {
        ZStack(alignment: .top) {
            SliceStyle.cutAccent.frame(height: 2).frame(maxWidth: .infinity)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("CUT ANGLE")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(SliceStyle.labelSecondary)
                    Text("\(tiltInt)°")
                        .font(.system(size: 56, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.9))
                        .contentTransition(reduceMotion ? .identity : .numericText(value: Double(tiltInt)))
                        .animation(reduceMotion ? nil : .snappy(duration: 0.15), value: tiltInt)
                    Text(readout)
                        .font(.system(.subheadline, design: .rounded).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .slicePlate(h: 12, v: 8)

                Spacer(minLength: 8)

                Text(modeTag)
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(.white.opacity(0.9))
                    .lineLimit(1)
                    .slicePlate(h: 8, v: 5)
            }
            .padding(16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
    }

    private var demoLabel: some View {
        Text("Demo only — not a diagnosis.")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white.opacity(0.85))
            .lineLimit(1)
            .fixedSize()
            .slicePlate(h: 8, v: 5)
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .allowsHitTesting(false)
    }
}
