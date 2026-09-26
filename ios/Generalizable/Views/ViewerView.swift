// Main case viewer. Owned by agent shell.
//
// Prior art (read from source, OHIF Viewers, github.com/OHIF/Viewers @ master):
// - platform/ui-next/src/components/Header/Header.tsx — header row: return arrow + logo on
//   the far left (`isReturnEnabled` → Icons.ArrowLeft, "return-to-work-list"), tool buttons
//   in the middle, study/patient info and settings in a right-hand group. Our row 1 keeps the
//   same left/right split (back + case identity | structures + report panels).
// - extensions/cornerstone/src/customizations/toolbarButtonsCustomization.ts —
//   `toolbarSections[primary]` orders tools as MeasurementTools, Zoom, Pan, TrackballRotate,
//   WindowLevel, Capture, Layout, Crosshairs, MoreTools. Our row 2 follows that order:
//   interaction tools first, then window/level presets, then overlays, then Layout last.
// - modes/longitudinal/src/index.ts — segmentation lives in a side panel (`rightPanels:
//   [cornerstone.segmentation, ...]`) rather than the toolbar; OrganListPanel is that panel,
//   presented as a non-modal sheet on iPhone (background interaction stays enabled).
// - OHIF's `viewportActionMenu.topLeft` (orientation/data overlay per viewport) → our
//   per-pane chrome: plane badge top-left, slice counter top-right.
// - PanTS-Demo/src/components/OrganCheckbox.tsx `onJumpToOrgan` — a "Jump to" control next to
//   a structure moves the crosshair to it; FindingStrip's "Jump to" does the same for a
//   findings.json entry (center_mm → voxel through the inverse affine).
// Deviation: OHIF's 1x1/2x2 layout selector plus double-click-to-maximise is kept, but on a
// phone the 2×2 grid uses tap-to-focus + double-tap-to-maximise because panes are small.
import SwiftUI

struct ViewerView: View {
    @State var state: ViewerState
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var showOrgans = false
    @State private var showReport = false
    @State private var findings: [CaseFinding] = []
    @State private var didApplyDefaults = false

    var body: some View {
        DuoAdaptiveViewer(state: state) {
            VStack(spacing: 0) {
                ViewerToolbar(state: state, onBack: { if let onClose { onClose() } else { dismiss() } },
                              showOrgans: $showOrgans, showReport: $showReport)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.top, Theme.Space.xs)
                    .padding(.bottom, Theme.Space.s)
                if let f = findings.first {
                    FindingStrip(finding: f, count: findings.count, state: state)
                        .padding(.horizontal, 6)
                        .padding(.bottom, 6)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                panes
                    .padding(.horizontal, 6)
                ViewerStatusBar(state: state)
            }
            .background(Theme.bg.ignoresSafeArea())
        }
        .background(Theme.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear(perform: applyCaseDefaults)
        .task { _ = await OrganCentroids.stats(for: state.loaded) }   // warm the organ panel
        .sheet(isPresented: $showOrgans) {
            OrganListPanel(state: state)
                .presentationDetents([.fraction(0.42), .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.42)))
                .presentationBackground(.regularMaterial)
                .presentationCornerRadius(24)
        }
        .sheet(isPresented: $showReport) {
            ReportPanel(state: state)
                .presentationDetents([.medium, .large])
                .presentationBackground(.regularMaterial)
                .presentationCornerRadius(24)
        }
    }

    /// Head CT (labels contain brain): brain window, hemorrhage visible, findings loaded.
    private func applyCaseDefaults() {
        guard !didApplyDefaults else { return }
        didApplyDefaults = true
        if state.visibleOrgans.contains(.brain) {
            state.window = .brain
            // Lead with the finding: the brain/skull/skin fills wash out grey matter in a
            // W80 window, so they start hidden (toggle them in the Structures panel).
            state.visibleOrgans.subtract([.skin, .skull, .brain])
            state.visibleOrgans.insert(.hemorrhage)
        }
        let fs = CaseFindings.load(for: state.loaded.info) ?? []
        withAnimation(.snappy(duration: 0.3)) { findings = fs }
    }

    // MARK: Layouts

    @ViewBuilder private var panes: some View {
        switch state.layout {
        case .quad:
            GeometryReader { geo in
                let gap: CGFloat = 6
                let w = (geo.size.width - gap) / 2, h = (geo.size.height - gap) / 2
                VStack(spacing: gap) {
                    HStack(spacing: gap) {
                        slicePane(.axial).frame(width: w, height: h)
                        slicePane(.sagittal).frame(width: w, height: h)
                    }
                    HStack(spacing: gap) {
                        slicePane(.coronal).frame(width: w, height: h)
                        threeDPane.frame(width: w, height: h)
                    }
                }
            }
            .transition(.opacity)
        case .single:
            VStack(spacing: Theme.Space.s) {
                slicePane(state.focusedPlane)
                    .id(state.focusedPlane)
                    .transition(.opacity)
                HStack(spacing: Theme.Space.m) {
                    GeneralizableSegmented(selection: $state.focusedPlane, items: [Plane.axial, .sagittal, .coronal].map {
                        .init(value: $0, title: $0.gzTitle, icon: nil)
                    }, compact: true)
                    SliceScrubber(state: state, plane: state.focusedPlane)
                }
                .padding(.horizontal, Theme.Space.xs)
            }
            .transition(.opacity)
        case .volumeFocus:
            threeDPane.transition(.opacity)
        }
    }

    private func toggleMaximise(_ p: Plane?) {
        withAnimation(.snappy(duration: 0.32)) {
            if state.layout == .quad {
                if let p { state.focusedPlane = p; state.layout = .single } else { state.layout = .volumeFocus }
            } else {
                state.layout = .quad
            }
        }
    }

    private func slicePane(_ p: Plane) -> some View {
        let focused = state.layout == .quad && state.focusedPlane == p
        return PaneChrome(
            title: p.gzTitle, badge: p.gzShort, tint: Theme.planeColor(p), focused: focused,
            trailing: "",
            maximised: state.layout != .quad,
            onExpand: { toggleMaximise(p) }
        ) {
            SliceView(plane: p, state: state)
        }
        .simultaneousGesture(TapGesture(count: 2).onEnded { toggleMaximise(p) })
        .simultaneousGesture(TapGesture().onEnded { if state.focusedPlane != p { state.focusedPlane = p } })
    }

    private var threeDPane: some View {
        PaneChrome(title: "3D", badge: "3D", tint: Theme.volumeColor, focused: false,
                   trailing: nil, maximised: state.layout != .quad,
                   onExpand: { toggleMaximise(nil) }) {
            ZStack(alignment: .bottom) {
                Group {
                    if state.volumeMode == .meshes { MeshView(state: state) } else { VolumeView(state: state) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                GeneralizableSegmented(selection: $state.volumeMode, items: VolumeRenderMode.allCases.map {
                    .init(value: $0, title: $0.gzTitle, icon: nil)
                }, compact: true)
                .scaleEffect(state.layout == .quad ? 0.86 : 1)
                .padding(.bottom, 8)
            }
        }
    }
}

// MARK: - Pane chrome

private struct PaneChrome<Content: View>: View {
    var title: String
    var badge: String
    var tint: Color
    var focused: Bool
    var trailing: String?
    var maximised: Bool
    var onExpand: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            Theme.pane
            content()
            HStack(alignment: .top, spacing: 6) {
                // SliceView draws plane name, n/N and W/L itself; the chrome only adds the
                // 3D badge and the expand control (no duplicate labels).
                if trailing == nil {
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 3, height: 11)
                        Text(badge).font(Theme.mono(10, .bold)).foregroundStyle(Theme.text)
                    }
                    .padding(.horizontal, 7).frame(height: 22)
                    .background(Capsule().fill(.black.opacity(0.55)))
                    .allowsHitTesting(false)
                }
                Spacer(minLength: 0)
                Button(action: onExpand) {
                    Image(systemName: maximised ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 26, height: 22)
                        .background(Capsule().fill(.black.opacity(0.55)))
                        .contentShape(Rectangle().inset(by: -8))
                }
                .buttonStyle(.plain)
            }
            .padding(6)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.pane, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.pane, style: .continuous)
                .strokeBorder(focused ? tint.opacity(0.85) : Theme.stroke, lineWidth: focused ? 1.5 : 1)
                .allowsHitTesting(false)
        )
        .animation(.easeOut(duration: 0.15), value: focused)
    }
}

// MARK: - Slice scrubber (single-pane layout)

private struct SliceScrubber: View {
    @Bindable var state: ViewerState
    var plane: Plane

    var body: some View {
        let n = max(1, state.sliceCount(for: plane))
        HStack(spacing: Theme.Space.s) {
            Slider(value: Binding(get: { Double(state.slice(for: plane)) },
                                  set: { state.setSlice(Float($0), for: plane) }),
                   in: 0...Double(max(1, n - 1)))
                .tint(Theme.planeColor(plane))
            Text("\(Int(state.slice(for: plane)) + 1)")
                .font(Theme.mono(11, .semibold)).foregroundStyle(Theme.textSecondary)
                .frame(minWidth: 30, alignment: .trailing)
        }
    }
}

// MARK: - Status bar (cursor, HU, structure, W/L)

private struct ViewerStatusBar: View {
    var state: ViewerState

    var body: some View {
        let c = state.cursor
        let hu = state.loaded.ct.hu(at: c)
        let organ = state.loaded.labels?.organ(at: c)
        HStack(spacing: Theme.Space.m) {
            Text("\(Int(c.x)),\(Int(c.y)),\(Int(c.z))")
                .foregroundStyle(Theme.textTertiary)
            if let hu {
                Text("\(hu) HU").foregroundStyle(Theme.text)
            }
            if let organ {
                HStack(spacing: 5) {
                    Circle().fill(organ.color).frame(width: 7, height: 7)
                    Text(organ.displayName).font(Theme.ui(11, .medium)).lineLimit(1)
                }
                .foregroundStyle(Theme.textSecondary)
            }
            Spacer(minLength: 0)
            Text("W \(Int(state.window.width)) L \(Int(state.window.center))")
                .foregroundStyle(Theme.textTertiary)
        }
        .font(Theme.mono(11))
        .lineLimit(1)
        .padding(.horizontal, Theme.Space.l)
        .frame(height: 32)
    }
}

// MARK: - Finding strip (findings.json → chip + Jump to)

private struct FindingStrip: View {
    var finding: CaseFinding
    var count: Int
    @Bindable var state: ViewerState
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Theme.Space.s) {
                Button { withAnimation(.snappy(duration: 0.25)) { expanded.toggle() } } label: {
                    HStack(spacing: 7) {
                        Circle().fill(Organ.hemorrhage.color).frame(width: 8, height: 8)
                            .shadow(color: Organ.hemorrhage.color.opacity(0.8), radius: 4)
                        Text(finding.title).font(Theme.ui(13, .semibold)).foregroundStyle(Theme.text)
                            .lineLimit(1)
                        if count > 1 {
                            Text("+\(count - 1)").font(Theme.mono(10.5, .semibold)).foregroundStyle(Theme.textTertiary)
                        }
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Theme.textTertiary)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button(action: jump) {
                    HStack(spacing: 4) {
                        Image(systemName: "scope").font(.system(size: 11, weight: .bold))
                        Text("Jump to").font(Theme.ui(12, .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10).frame(height: 28)
                    .background(Capsule().fill(Organ.hemorrhage.color.opacity(0.85)))
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.impact(weight: .light), trigger: state.cursor)
            }
            if expanded, let e = finding.explanation {
                Text(e).font(Theme.ui(12)).foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
        .padding(.leading, 12).padding(.trailing, 5).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Organ.hemorrhage.color.opacity(0.35)))
    }

    private func jump() {
        guard let v = finding.voxel(in: state.geometry) else { return }
        withAnimation(.snappy(duration: 0.25)) {
            state.cursor = v
            if let id = finding.labelID, id > 0 {
                // label_id is the source mask's value; hemorrhage is the only head finding.
                state.visibleOrgans.insert(.hemorrhage)
            }
            state.showLabels = true
        }
    }
}
