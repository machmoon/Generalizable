// GeneralizableView.swift
//
// The pitch view (Layer Lens artifact, "one view"): the Duo's two screens show one cut.
//   Lid (top):    the cut plane tilted about the cut line by tilt = 180° − hinge (A2).
//   Base (bottom): the flat (tilt 0) slice through the same pivot, with the cut line drawn
//                  across it. Drag the base vertically to move the cut line; the slider
//                  moves the slice level. Findings are ringed on both screens by SliceView.
// Both screens are the same SliceView over the same CutPlane; only the tilt differs.

import SwiftUI
import simd

private struct LoadedBundle: @unchecked Sendable {
    let name: String
    let bundle: CaseBundle?
}

struct GeneralizableView: View {
    private static let caseOrder = ["head", "body", "sun", "circuit"]
    private static let caseTitle = ["head": "Head CT", "body": "Body CT", "sun": "The Sun", "circuit": "Circuit board"]

    @State private var driver = HingeTiltDriver()
    @State private var cases: [String] = []
    @State private var caseID = ""
    @State private var bundle: CaseBundle?
    @State private var cut = CutPlane()
    @State private var mode: SliceMode = .layers
    @State private var hidden: Set<Int> = []
    @State private var selected: CaseFinding?
    @State private var dragStart: SIMD3<Float>?

    private let cyan = Color(red: 0.27, green: 0.81, blue: 0.88)
    private let flag = Color(red: 1.0, green: 0.24, blue: 0.65)

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                lidScreen.frame(height: geo.size.height * 0.5)
                baseScreen
            }
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .hingeTiltDriver(driver)
        .onAppear {
            let c = $cut
            driver.bind { c.wrappedValue.tiltDegrees = $0 }
            if cases.isEmpty {
                let avail = Set(CaseBundle.availableBundled())
                cases = Self.caseOrder.filter { avail.contains($0) }
                if let first = cases.first { load(first) }
            }
        }
    }

    // MARK: Screens

    private var lidScreen: some View {
        ZStack(alignment: .topLeading) {
            if let b = bundle {
                SliceView(bundle: b, cut: cut, mode: mode, visibleLayerIDs: visible(b),
                          selectedFinding: selected, window: window(b), statusText: hingeLine)
            }
        }
        .clipped()
    }

    private var baseScreen: some View {
        VStack(spacing: 8) {
            ZStack {
                if let b = bundle {
                    SliceView(bundle: b, cut: flatCut, mode: mode, visibleLayerIDs: visible(b),
                              selectedFinding: selected, window: window(b))
                }
                // Cut line: the lid plane pivots about the case's left-right axis through the
                // pivot, so on the flat slice it is the horizontal line through the pivot (center).
                Rectangle().fill(cyan).frame(height: 2).shadow(color: .black, radius: 2)
                    .allowsHitTesting(false)
            }
            .clipped()
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 4)
                .onChanged { g in
                    let start = dragStart ?? cut.pivotMM
                    dragStart = start
                    let mmPerPt = Float(extentMM / 300)
                    var p = start
                    p.y = start.y - Float(g.translation.height) * mmPerPt
                    cut.pivotMM = p
                }
                .onEnded { _ in dragStart = nil })
            .accessibilityLabel("Flat slice. Drag up or down to move the cut line.")

            controls.padding(.horizontal, 12).padding(.bottom, 8)
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(cases, id: \.self) { c in
                        chip(Self.caseTitle[c] ?? c, on: c == caseID) { load(c) }
                    }
                    Divider().frame(height: 20)
                    chip("Layers", on: mode == .layers) { mode = .layers }
                    chip("CT scan", on: mode == .ct) { mode = .ct }
                }
            }
            if let b = bundle, !b.findings.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(b.findings.enumerated()), id: \.element.id) { i, f in
                            Button { select(f) } label: {
                                HStack(spacing: 6) {
                                    Text("\(i + 1)").font(.caption.bold()).frame(width: 20, height: 20)
                                        .background(flag, in: Circle())
                                    Text(f.title).font(.subheadline.weight(.semibold))
                                }
                                .padding(.horizontal, 10).padding(.vertical, 6)
                                .background(selected?.id == f.id ? flag.opacity(0.3) : .white.opacity(0.08),
                                            in: Capsule())
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if let s = selected {
                    Text(s.explanation).font(.caption).foregroundStyle(.white.opacity(0.75))
                        .lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            HStack(spacing: 8) {
                Text("Tilt").font(.caption.monospaced()).frame(width: 42, alignment: .leading)
                Slider(value: $cut.tiltDegrees, in: 0...90, step: 1).tint(cyan)
                ForEach([(0.0, "Flat"), (45.0, "45°"), (90.0, "Front")], id: \.1) { t, l in
                    chip(l, on: Int(cut.tiltDegrees.rounded()) == Int(t)) {
                        withAnimation(.easeInOut(duration: 0.4)) { cut.tiltDegrees = t }
                    }
                }
            }
            HStack(spacing: 8) {
                Text("Level").font(.caption.monospaced()).frame(width: 42, alignment: .leading)
                Slider(value: levelBinding, in: levelRange).tint(.orange)
            }
            if let b = bundle {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(b.layers.sorted { $0.peelOrder < $1.peelOrder }) { l in
                            Button {
                                if hidden.contains(l.id) { hidden.remove(l.id) } else { hidden.insert(l.id) }
                            } label: {
                                HStack(spacing: 5) {
                                    RoundedRectangle(cornerRadius: 3).fill(Color(hexString: l.color))
                                        .frame(width: 11, height: 11)
                                    Text(l.name).font(.caption.weight(.semibold))
                                }
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(.white.opacity(0.08), in: Capsule())
                                .opacity(hidden.contains(l.id) ? 0.4 : 1)
                                .strikethrough(hidden.contains(l.id))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            Text("Generalizable · demo only, public open-source research data. Not a diagnosis.")
                .font(.caption2).foregroundStyle(.white.opacity(0.5))
        }
        .foregroundStyle(.white)
    }

    private func chip(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(on ? Color.white : Color.white.opacity(0.1), in: Capsule())
                .foregroundStyle(on ? .black : .white)
        }.buttonStyle(.plain)
    }

    // MARK: Derived

    private var flatCut: CutPlane {
        var c = cut
        c.tiltDegrees = 0
        return c
    }

    private var viewName: String {
        let t = cut.tiltDegrees
        return t < 2 ? "Flat slice" : abs(t - 90) < 2 ? "Front view" : "Tilted slice"
    }

    private var hingeLine: String {
        if let a = driver.lastHingeAngle, driver.isHingeAvailable {
            return "Hinge \(Int(a.rounded()))° → cut tilt \(Int(cut.tiltDegrees.rounded()))° · fold to tilt"
        }
        return "No hinge · use the Tilt slider"
    }

    private var extentMM: Double {
        guard let b = bundle else { return 300 }
        return Double(max(b.extentMM.x, b.extentMM.y))
    }

    private var levelRange: ClosedRange<Double> {
        guard let b = bundle else { return -1...1 }
        let c = Double(b.centerMM.z), h = Double(b.extentMM.z) / 2
        return (c - h)...(c + h)
    }

    private var levelBinding: Binding<Double> {
        Binding(get: { Double(cut.pivotMM.z) },
                set: { cut.pivotMM.z = Float($0) })
    }

    private var levelText: String {
        String(format: "%.0f mm", cut.pivotMM.z)
    }

    private func visible(_ b: CaseBundle) -> Set<Int> {
        Set(b.layers.map(\.id)).subtracting(hidden)
    }

    private func window(_ b: CaseBundle) -> [Double] {
        let p = b.meta.windowPresets
        if b.name == "head", let w = p["brain"] { return w }
        return p["soft"] ?? p.values.first ?? [40, 400]
    }

    // MARK: Actions

    private func select(_ f: CaseFinding) {
        selected = f
        cut.select(f)
    }

    private func load(_ name: String) {
        caseID = name
        Task {
            let loaded = await Task.detached(priority: .userInitiated) {
                LoadedBundle(name: name, bundle: try? CaseBundle.bundled(name))
            }.value
            guard loaded.name == caseID, let b = loaded.bundle else { return }
            bundle = b
            hidden = []
            selected = nil
            var c = CutPlane(pivotMM: b.centerMM, tiltDegrees: cut.tiltDegrees)
            if let f = b.findings.first {
                c.select(f)
                selected = f
            }
            cut = c
        }
    }
}

private extension Color {
    init(hexString: String) {
        var s = hexString
        if s.hasPrefix("#") { s.removeFirst() }
        let v = UInt32(s, radix: 16) ?? 0x888888
        self.init(red: Double(v >> 16 & 255) / 255, green: Double(v >> 8 & 255) / 255, blue: Double(v & 255) / 255)
    }
}
