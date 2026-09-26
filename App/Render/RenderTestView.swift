// RenderTestView.swift  (E5, L3c branch only)
//
// Rehearsal harness for the Duo demo (build spec section 5). It wires every L3c piece
// through the contract APIs only (docs/contracts/render-interface.md):
//   DuoAdaptiveLayout { SliceView } controls: { OverviewView, tilt, offset, mode, layers, findings }
//   .hingeTiltDriver(driver) with driver.bind { cut.tiltDegrees = $0 }
//
// Prior art followed:
//   - Slice offset control: 3D Slicer Libs/MRML/Widgets/qMRMLSliceControllerWidget.cxx
//     (offset slider stepped by the minimum voxel spacing, signed mm readout).
//   - Harness panel (hinge/pivot/ring/case lines): no open-source precedent; it is the
//     design leads' own spec (section 5), implemented as written.

import SwiftUI
import simd
import QuartzCore

/// Carries a loaded (non-Sendable) CaseBundle from the background loader back to the main actor.
/// The bundle is immutable after load, so handing it across once is safe.
private struct LoadedCase: @unchecked Sendable {
    let name: String
    let result: Result<CaseBundle, Error>
}

/// Main-thread frame counter (CADisplayLink). Reports the display cadence the UI actually gets,
/// which is the proxy for "FPS >= 55 while sweeping" (the MTKView draws on the same run loop).
@Observable
final class FrameRateMeter: NSObject {
    private(set) var fps: Double = 0
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var frames = 0
    @ObservationIgnored private var windowStart: CFTimeInterval = 0

    func start() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        l.add(to: .main, forMode: .common)
        link = l
        windowStart = CACurrentMediaTime()
        frames = 0
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ l: CADisplayLink) {
        frames += 1
        let now = CACurrentMediaTime()
        let dt = now - windowStart
        if dt >= 0.5 {
            fps = Double(frames) / dt
            frames = 0
            windowStart = now
        }
    }
}

struct RenderTestView: View {
    // Spec 7: default findings, hard-coded in UI. Never pivot on the Sun's core.
    private static let defaultFindingKey: [String: String] = ["sun": "sunspot", "circuit": "via"]
    private static let stageCases = ["sun", "circuit", "head", "body"]

    @State private var driver = HingeTiltDriver()
    @State private var meter = FrameRateMeter()

    @State private var available: [String] = []
    @State private var caseID: String = ""
    @State private var bundle: CaseBundle?
    @State private var loadError: String?
    @State private var isLoading = false

    @State private var cut = CutPlane()
    @State private var mode: SliceMode = .layers
    @State private var hiddenLayerIDs: Set<Int> = []
    @State private var selectedFindingID: Int?

    @State private var sweepTask: Task<Void, Never>?
    /// Spec 1 arbitration, done here through the contract's start()/stop(): nil = the fold steers;
    /// non-nil = manual, holding the raw hinge angle at takeover (or -1 when there was none).
    @State private var manualTakeoverAngle: Double?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // MARK: Derived

    private var selectedFinding: CaseFinding? {
        guard let bundle, let id = selectedFindingID else { return nil }
        return bundle.findings.first { $0.id == id }
    }

    private var visibleLayerIDs: Set<Int> {
        guard let bundle else { return [] }
        return Set(bundle.layers.map(\.id)).subtracting(hiddenLayerIDs)
    }

    private var peelOrderedLayers: [CaseLayer] {
        (bundle?.layers ?? []).sorted { $0.peelOrder < $1.peelOrder }
    }

    private var isMedical: Bool { caseID == "head" || caseID == "body" }

    /// CT window: soft-tissue preset for medical cases, the "density" preset for synthetic ones,
    /// falling back to any "soft*" key, then the first key alphabetically.
    private var window: [Double] {
        guard let presets = bundle?.meta.windowPresets, !presets.isEmpty else { return [40, 400] }
        let preferred = isMedical ? ["soft", "soft_tissue", "brain"] : ["density", "soft"]
        for k in preferred { if let w = presets[k], w.count >= 2 { return w } }
        if let k = presets.keys.sorted().first(where: { $0.hasPrefix("soft") }), let w = presets[k] { return w }
        return presets[presets.keys.sorted()[0]] ?? [40, 400]
    }

    private var minSpacing: Double { bundle?.meta.spacingMM.min() ?? 1 }

    private var offsetRange: ClosedRange<Double> {
        guard let bundle else { return -100...100 }
        let half = Double(simd_length(bundle.extentMM)) / 2
        return -half...half
    }

    // MARK: Body

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            DuoAdaptiveLayout {
                sliceArea
            } controls: {
                controls
            }
        }
        .preferredColorScheme(.dark)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .hingeTiltDriver(driver)
        .onAppear {
            let tilt = $cut
            driver.bind { tilt.wrappedValue.tiltDegrees = $0 }
            meter.start()
            if available.isEmpty {
                available = CaseBundle.availableBundled()
                stageStart()
            }
        }
        .onDisappear {
            meter.stop()
            sweepTask?.cancel()
        }
        // Spec 1: last input wins. While manual, a 3 deg move of the raw hinge hands control back.
        .onChange(of: driver.lastHingeAngle) { _, new in
            guard let takeover = manualTakeoverAngle, let new else { return }
            if takeover < 0 || abs(new - takeover) >= 3 { resumeHinge() }
        }
    }

    // MARK: Slice (top / trailing)

    @ViewBuilder
    private var sliceArea: some View {
        ZStack {
            if let bundle {
                SliceView(bundle: bundle,
                          cut: cut,
                          mode: mode,
                          visibleLayerIDs: visibleLayerIDs,
                          selectedFinding: selectedFinding,
                          window: window,
                          statusText: sliceStatusText)
                    .id(caseID)
            } else {
                Color(white: 0.11)
                VStack(spacing: 8) {
                    if isLoading { ProgressView() }
                    Text(loadError ?? (isLoading ? "Loading \(caseID)…" : "No case loaded"))
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding()
                }
            }
            centerCrosshair
            VStack {
                Spacer()
                harnessPanel
                    // Sit above SliceView's bottom-leading "Demo only" plate, which must stay visible.
                    .padding(.bottom, 40)
            }
        }
        .clipped()
    }

    /// 1 pt white crosshair at 30% through the view centre: the ring must sit on it at every tilt.
    private var centerCrosshair: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            var p = Path()
            p.move(to: CGPoint(x: 0, y: c.y)); p.addLine(to: CGPoint(x: size.width, y: c.y))
            p.move(to: CGPoint(x: c.x, y: 0)); p.addLine(to: CGPoint(x: c.x, y: size.height))
            ctx.stroke(p, with: .color(.white.opacity(0.3)), lineWidth: 1)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var harnessPanel: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(hingeLine)
            Text(pivotLine)
            Text(ringLine)
            Text(caseLine)
        }
        .font(.system(size: 13, design: .monospaced))
        .foregroundStyle(.white)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.6))
        .allowsHitTesting(false)
    }

    // MARK: Panel strings (spec 5)

    private var hingeLine: String {
        let tilt = String(format: "%.1f°", cut.tiltDegrees)
        guard driver.isHingeAvailable, let a = driver.lastHingeAngle else {
            return "Hinge —  (no hinge) → Tilt \(tilt)  src: \(sourceText)"
        }
        return "Hinge \(String(format: "%.1f°", a)) (\(statusText)) → Tilt \(tilt)  src: \(sourceText)"
    }

    private var statusText: String { String(describing: driver.pose) }
    private var sourceText: String { manualTakeoverAngle == nil && driver.isHingeAvailable ? "HINGE" : "MANUAL" }

    /// Spec 2 readout strings for SliceView's status line.
    private var sliceStatusText: String? {
        let t = Int(cut.tiltDegrees.rounded())
        switch driver.pose {
        case .noHinge: return nil
        case .closed: return "Closed · tilt held at \(t)°"
        default:
            guard manualTakeoverAngle == nil, let a = driver.lastHingeAngle else { return nil }
            return "Hinge \(Int(a.rounded()))° → Tilt \(t)° · \(planeName(cut.tiltDegrees))"
        }
    }

    private func beginManual() {
        if manualTakeoverAngle == nil { manualTakeoverAngle = driver.lastHingeAngle ?? -1 }
        driver.stop()
    }

    private func resumeHinge() {
        sweepTask?.cancel()
        manualTakeoverAngle = nil
        driver.start()   // replays the latest hinge reading
    }

    private var pivotLine: String {
        let p = cut.pivotMM
        let onPlane: String
        if let f = selectedFinding {
            let d = abs(simd_dot(f.center - cut.originMM, cut.normal))
            onPlane = d <= Float(f.radiusMM) ? "YES" : "NO"
        } else {
            onPlane = "—"
        }
        return String(format: "Pivot (%.0f,%.0f,%.0f) mm  offset %.1f mm  finding on-plane: %@",
                      p.x, p.y, p.z, cut.sliceOffsetMM, onPlane)
    }

    /// In-plane distance of the finding's projection from the slice centre (u=0, v=0 is the view
    /// centre per spec 2). Reported in mm: the pt scale is private to SliceView, and 0.0 mm is 0.0 pt.
    private var ringLine: String {
        let fps = String(format: "FPS %.0f", meter.fps)
        guard let f = selectedFinding else { return "Ring Δ from center: —   \(fps)" }
        let rel = f.center - cut.originMM
        let du = simd_dot(rel, cut.uAxis), dv = simd_dot(rel, cut.vAxis)
        return String(format: "Ring Δ from center: %.1f mm   %@", (du * du + dv * dv).squareRoot(), fps)
    }

    private var caseLine: String {
        guard let b = bundle else { return "Case \(caseID) · not loaded" }
        let d = b.meta.dims.map(String.init).joined(separator: "×")
        return "Case \(caseID) · \(d) · \(String(format: "%.1f", minSpacing)) mm"
    }

    // MARK: Controls (bottom / leading), spec 5 order, then the contract extras

    /// DuoAdaptiveLayout already wraps the controls slot in a ScrollView.
    private var controls: some View {
        VStack(alignment: .leading, spacing: 14) {
                casePicker
                if let bundle {
                    OverviewView(bundle: bundle, cut: $cut, visibleLayerIDs: visibleLayerIDs)
                        .frame(height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .id(caseID)
                }
                findingPicker
                modePicker
                tiltRow
                offsetRow
                layersRow
                actionRow
                Text("Demo only — not a diagnosis.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.black.opacity(0.55),
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .padding(16)
        .background(Color.black)
    }

    private var casePicker: some View {
        HStack(spacing: 6) {
            ForEach(Self.stageCases, id: \.self) { name in
                let present = available.contains(name)
                Button(name) { loadCase(name) }
                    .buttonStyle(.bordered)
                    .tint(name == caseID ? Color(red: 0.39, green: 0.82, blue: 1.0) : .gray)
                    .disabled(!present || isLoading)
                    .opacity(present ? 1 : 0.35)
                    .frame(minHeight: 44)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Case")
    }

    private var findingPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(isMedical ? "Findings" : "Points of interest")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(bundle?.findings ?? []) { f in
                        let isSel = f.id == selectedFindingID
                        Button { select(f, announce: true) } label: {
                            Text(f.title).font(.subheadline)
                                .padding(.horizontal, 12).frame(minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(isSel ? Color(red: 1.0, green: 0.176, blue: 0.584) : .gray)
                        .accessibilityAddTraits(isSel ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var modePicker: some View {
        Picker("View", selection: $mode) {
            Text("Layers").tag(SliceMode.layers)
            Text(isMedical ? "CT scan" : "Density").tag(SliceMode.ct)
        }
        .pickerStyle(.segmented)
    }

    private var tiltRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Cut tilt").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if driver.isHingeAvailable {
                    Text(manualTakeoverAngle == nil ? "FOLD" : "MANUAL · fold to resume")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(red: 0.39, green: 0.82, blue: 1.0).opacity(0.25), in: Capsule())
                }
                Spacer()
                Text(readout).font(.caption.monospacedDigit())
            }
            Slider(value: $cut.tiltDegrees, in: 0...90, step: 1) { editing in
                if editing {
                    sweepTask?.cancel()
                    beginManual()
                }
            }
            .accessibilityLabel("Cut tilt")
            .accessibilityValue("\(Int(cut.tiltDegrees.rounded())) degrees, \(planeName(cut.tiltDegrees).lowercased()), \(manualTakeoverAngle == nil && driver.isHingeAvailable ? "set by fold" : "set manually")")
            Text("Fold to change the cut angle").font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// Contract readout "Hinge <raw>° → Tilt <tilt>°" (spec 2 wording, with the plane name).
    private var readout: String {
        let t = Int(cut.tiltDegrees.rounded())
        if manualTakeoverAngle == nil, driver.isHingeAvailable, let a = driver.lastHingeAngle {
            return "Hinge \(Int(a.rounded()))° → Tilt \(t)° · \(planeName(cut.tiltDegrees))"
        }
        return "Tilt \(t)° · \(planeName(cut.tiltDegrees))"
    }

    private func planeName(_ tilt: Double) -> String {
        let t = Int(tilt.rounded())
        switch t {
        case 0: return "Axial"
        case 90: return "Coronal"
        case 45: return "Oblique 45"
        default: return "Oblique"
        }
    }

    private var offsetRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Slice offset").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(Self.signedMM(cut.sliceOffsetMM)).font(.caption.monospacedDigit())
            }
            HStack {
                Slider(value: Binding(get: { Double(cut.sliceOffsetMM) },
                                      set: { cut.sliceOffsetMM = Float($0) }),
                       in: offsetRange, step: minSpacing)
                    .accessibilityLabel("Slice offset")
                    .accessibilityValue(Self.signedMM(cut.sliceOffsetMM))
                Button("Return to finding") {
                    if let f = selectedFinding { cut.select(f) } else { cut.sliceOffsetMM = 0 }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
            }
        }
    }

    /// "+12 mm" / "−12 mm" with U+2212 for minus (spec 4).
    private static func signedMM(_ v: Float) -> String {
        let r = Int(v.rounded())
        if r == 0 { return "0 mm" }
        return r > 0 ? "+\(r) mm" : "\u{2212}\(-r) mm"
    }

    private var layersRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Layers").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Button("Peel") { peel() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color(red: 0.39, green: 0.82, blue: 1.0))
                        .frame(minHeight: 44)
                    ForEach(peelOrderedLayers) { layer in
                        let on = !hiddenLayerIDs.contains(layer.id)
                        Button {
                            if on { hiddenLayerIDs.insert(layer.id) } else { hiddenLayerIDs.remove(layer.id) }
                        } label: {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(on ? Color(rgba: layer.rgba) : .clear)
                                    .overlay(Circle().stroke(Color(rgba: layer.rgba), lineWidth: 1.5))
                                    .frame(width: 10, height: 10)
                                Text(layer.name).font(.subheadline)
                                    .foregroundStyle(on ? .primary : .secondary)
                            }
                            .padding(.horizontal, 12).frame(minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(.gray)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
        }
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Button("Sweep") { sweep() }.buttonStyle(.borderedProminent)
            Button("Stage start") { stageStart() }.buttonStyle(.bordered)
            Button("Reset View") { resetView() }.buttonStyle(.bordered)
        }
        .frame(minHeight: 44)
    }

    // MARK: Actions

    /// Loads a bundled case off the main thread, then applies spec 7 defaults for it.
    private func loadCase(_ name: String, then apply: (() -> Void)? = nil) {
        guard !name.isEmpty else { return }
        sweepTask?.cancel()
        caseID = name
        isLoading = true
        loadError = nil
        Task {
            let loaded = await Task.detached(priority: .userInitiated) { () -> LoadedCase in
                do { return LoadedCase(name: name, result: .success(try CaseBundle.bundled(name))) }
                catch { return LoadedCase(name: name, result: .failure(error)) }
            }.value
            guard loaded.name == caseID else { return }   // a newer pick won
            isLoading = false
            switch loaded.result {
            case .success(let b):
                bundle = b
                applyCaseDefaults(b)
                apply?()
            case .failure(let e):
                bundle = nil
                loadError = String(describing: e)
            }
        }
    }

    /// Spec 7 launch defaults for the loaded case: default finding, Layers, peel_order 1 hidden.
    private func applyCaseDefaults(_ b: CaseBundle) {
        mode = .layers
        hiddenLayerIDs = Set(b.layers.filter { $0.peelOrder == 1 }.map(\.id))
        let key = Self.defaultFindingKey[b.name]
        let f = b.findings.first { key != nil && $0.title.lowercased().contains(key!) } ?? b.findings.first
        if let f {
            select(f, announce: false)
        } else {
            selectedFindingID = nil
            cut.pivotMM = b.centerMM
            cut.sliceOffsetMM = 0
        }
    }

    private func select(_ f: CaseFinding, announce: Bool) {
        selectedFindingID = f.id
        cut.select(f)   // A1: pivot to the finding, offset 0, tilt and source untouched
        if announce {
            AccessibilityNotification.Announcement("\(f.title). Cut moved to this finding.").post()
        }
    }

    /// Next visible layer in peel order goes hidden.
    private func peel() {
        if let next = peelOrderedLayers.first(where: { !hiddenLayerIDs.contains($0.id) }),
           visibleLayerIDs.count > 1 {
            hiddenLayerIDs.insert(next.id)
        }
    }

    private func resetView() {
        sweepTask?.cancel()
        cut.tiltDegrees = 0
        cut.rotationDegrees = 0
        if let f = selectedFinding { cut.select(f) }
        else if let b = bundle { cut.pivotMM = b.centerMM; cut.sliceOffsetMM = 0 }
    }

    /// Spec 7 launch state: head (or sun if head is missing), Layers, peel 1 hidden, default
    /// finding, flat (tilt 0) unless the hinge is steering.
    private func stageStart() {
        resumeHinge()
        let name = available.contains("head") ? "head"
            : (available.contains("sun") ? "sun" : (available.first ?? ""))
        let reset = {
            if !driver.isHingeAvailable { cut.tiltDegrees = 0 }
            cut.rotationDegrees = 0
        }
        if name == caseID, let b = bundle {
            applyCaseDefaults(b)
            reset()
        } else {
            loadCase(name, then: reset)
        }
    }

    /// Spec 5: 0 -> 90 over 4 s, hold 1 s, then 90 -> 60 over 1.5 s, ~60 Hz steps.
    private func sweep() {
        sweepTask?.cancel()
        beginManual()
        let tilt = $cut
        sweepTask = Task { @MainActor in
            func ramp(_ from: Double, _ to: Double, _ seconds: Double) async -> Bool {
                let start = CACurrentMediaTime()
                while !Task.isCancelled {
                    let t = min((CACurrentMediaTime() - start) / seconds, 1)
                    tilt.wrappedValue.tiltDegrees = from + (to - from) * t
                    if t >= 1 { return true }
                    try? await Task.sleep(for: .milliseconds(16))
                }
                return false
            }
            guard await ramp(0, 90, 4) else { return }
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            _ = await ramp(90, 60, 1.5)
        }
    }
}

private extension Color {
    init(rgba: SIMD4<Float>) {
        self.init(.sRGB, red: Double(rgba.x), green: Double(rgba.y), blue: Double(rgba.z), opacity: Double(rgba.w))
    }
}

#Preview {
    RenderTestView()
}
