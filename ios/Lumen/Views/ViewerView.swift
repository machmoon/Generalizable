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
// Deviation: OHIF's 1x1/2x2 layout selector plus double-click-to-maximise is kept, but on a
// phone the 2×2 grid uses tap-to-focus + double-tap-to-maximise because panes are small.
import SwiftUI

struct ViewerView: View {
    @State var state: ViewerState
    @Environment(\.dismiss) private var dismiss
    @State private var showOrgans = false
    @State private var showReport = false

    var body: some View {
        DuoAdaptiveViewer(state: state) {
            VStack(spacing: 0) {
                ViewerToolbar(state: state, onBack: { dismiss() },
                              showOrgans: $showOrgans, showReport: $showReport)
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.top, Theme.Space.xs)
                    .padding(.bottom, Theme.Space.s)
                panes
                    .padding(.horizontal, 6)
                ViewerStatusBar(state: state)
            }
            .background(Theme.bg.ignoresSafeArea())
        }
        .background(Theme.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
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
                    LumenSegmented(selection: $state.focusedPlane, items: [Plane.axial, .sagittal, .coronal].map {
                        .init(value: $0, title: $0.lumenTitle, icon: nil)
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
            title: p.lumenTitle, badge: p.lumenShort, tint: Theme.planeColor(p), focused: focused,
            trailing: "\(Int(state.slice(for: p)) + 1)/\(state.sliceCount(for: p))",
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
                LumenSegmented(selection: $state.volumeMode, items: VolumeRenderMode.allCases.map {
                    .init(value: $0, title: $0.lumenTitle, icon: nil)
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
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 3, height: 11)
                    Text(badge).font(Theme.mono(10, .bold)).foregroundStyle(Theme.text)
                }
                .padding(.horizontal, 7).frame(height: 22)
                .background(Capsule().fill(.black.opacity(0.55)))
                .allowsHitTesting(false)
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing).font(Theme.mono(10, .medium)).foregroundStyle(Theme.textSecondary)
                        .padding(.horizontal, 7).frame(height: 22)
                        .background(Capsule().fill(.black.opacity(0.55)))
                        .contentTransition(.numericText())
                        .allowsHitTesting(false)
                }
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
        .frame(height: 30)
    }
}
