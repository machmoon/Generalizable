// Compact viewer toolbar. Owned by agent shell.
// Row 1 mirrors OHIF's Header (return + identity on the left, panels on the right);
// row 2 is OHIF's primary toolbar section order (tools → window/level → layout).
// See the citation block at the top of ViewerView.swift.
import SwiftUI

struct ViewerToolbar: View {
    @Bindable var state: ViewerState
    var onBack: () -> Void
    @Binding var showOrgans: Bool
    @Binding var showReport: Bool

    @State private var showLabelPopover = false
    @Environment(ProStore.self) private var pro

    var body: some View {
        VStack(spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.m) {
                GeneralizableIconButton(systemName: "chevron.left", action: onBack)
                    .accessibilityLabel("Back")
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.loaded.info.title)
                        .font(Theme.ui(15, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    // The title already carries the case number; the full ID moved out to make room.
                    Text("Not a diagnosis")
                        .font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                }
                .layoutPriority(1)
                Spacer(minLength: 4)
                // Full text labels when there's room; icon-only (with an accessibility label) otherwise.
                ViewThatFits(in: .horizontal) {
                    panelButtons(labeled: true)
                    panelButtons(labeled: false)
                }
            }
            // Fit the row at iPhone Duo portrait width: full labels when there is room,
            // then a dense icon-first row, then horizontal scrolling as a last resort.
            ViewThatFits(in: .horizontal) {
                toolRow(dense: false)
                toolRow(dense: true)
                ScrollView(.horizontal) { toolRow(dense: true).padding(.vertical, 1) }
                    .scrollIndicators(.hidden)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Two icon-only buttons at the top-right: Structures panel and Report panel.
    /// Shown with text labels when there's room, otherwise as icons with an accessibility label.
    private func panelButtons(labeled: Bool) -> some View {
        HStack(spacing: Theme.Space.s) {
            panelButton(icon: "list.bullet.below.rectangle", label: "Structures", active: showOrgans, labeled: labeled) {
                showOrgans.toggle()
            }
            panelButton(icon: "doc.text.magnifyingglass", label: "Report", active: showReport, labeled: labeled) {
                showReport = true
            }
        }
    }

    private func panelButton(icon: String, label: String, active: Bool, labeled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 14, weight: .semibold))
                if labeled {
                    Text(label).font(Theme.ui(12, .semibold)).lineLimit(1)
                }
            }
            .foregroundStyle(active ? Color.white : Theme.text)
            .padding(.horizontal, labeled ? 12 : 0)
            .frame(width: labeled ? nil : 36, height: 36)
            .background(Capsule().fill(active ? Theme.accent.opacity(0.85) : Theme.surfaceHi))
            .overlay(Capsule().strokeBorder(Theme.stroke))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func toolRow(dense: Bool) -> some View {
        HStack(spacing: dense ? 6 : Theme.Space.s) {
            GZIconSegmented(selection: $state.activeTool, items: ViewerState.Tool.allCases.map {
                .init(value: $0, icon: $0.gzIcon, accessibilityLabel: $0.gzTitle)
            }, dense: dense)
            windowMenu(dense: dense)
            labelsControl(dense: dense)
            if !dense { Spacer(minLength: 0) }
            GZIconSegmented(selection: layoutBinding, items: ViewerLayout.allCases.map {
                .init(value: $0, icon: $0.gzIcon, accessibilityLabel: "\($0.gzTitle) layout")
            }, dense: dense)
        }
        .fixedSize(horizontal: true, vertical: false)
    }

    private var layoutBinding: Binding<ViewerLayout> {
        Binding(get: { state.layout }, set: { v in withAnimation(.snappy(duration: 0.3)) { state.layout = v } })
    }

    /// Head CT (brain labelled): Brain / Subdural / Bone first, the standard neuro set.
    private var presets: [WindowLevel] {
        guard state.loaded.labels.map({ _ in state.visibleOrgans.contains(.brain) || state.window == .brain }) == true
        else { return WindowLevel.presets }
        let head: [WindowLevel] = [.brain, .subdural, .bone]
        return head + WindowLevel.presets.filter { !head.contains($0) }
    }

    private func windowMenu(dense: Bool) -> some View {
        Menu {
            ForEach(presets) { p in
                Button {
                    if !p.requiresPro || pro.require() { state.window = p }
                } label: {
                    if state.window == p {
                        Label("\(p.name)   W \(Int(p.width)) · L \(Int(p.center))", systemImage: "checkmark")
                    } else if p.requiresPro && !pro.isPro {   // Pro preset (ProPaywall.swift)
                        Label("\(p.name)   W \(Int(p.width)) · L \(Int(p.center))", systemImage: "lock.fill")
                    } else {
                        Text("\(p.name)   W \(Int(p.width)) · L \(Int(p.center))")
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                if !dense {
                    Image(systemName: "circle.lefthalf.filled").font(.system(size: 12, weight: .semibold))
                }
                Text(state.window.name).font(Theme.ui(12, .semibold)).lineLimit(1)
                // W/L numbers are in the status bar; repeating them here pushed the row off-screen.
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, dense ? 9 : 11).frame(height: 34)
            .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
            .overlay(Capsule().strokeBorder(Theme.stroke))
        }
        .accessibilityLabel("Window preset")
        .accessibilityValue(state.window.name)
    }

    @ViewBuilder
    private func eyeLabel(dense: Bool) -> some View {
        let color: Color = state.showLabels ? Theme.accent : Theme.textSecondary
        let iconName = state.showLabels ? "eye.fill" : "eye.slash"
        if dense {
            Image(systemName: iconName)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 32, height: 34)
                .contentShape(Rectangle())
        } else {
            HStack(spacing: 5) {
                Image(systemName: iconName).font(.system(size: 12, weight: .semibold))
                Text("Labels").font(Theme.ui(12, .semibold)).lineLimit(1)
            }
            .foregroundStyle(color)
            .padding(.horizontal, 4).frame(height: 34)
            .contentShape(Rectangle())
        }
    }

    private func labelsControl(dense: Bool) -> some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.snappy) { state.showLabels.toggle() }
            } label: {
                eyeLabel(dense: dense)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(LongPressGesture().onEnded { _ in showLabelPopover = true })
            .accessibilityLabel("Labels")
            .accessibilityValue(state.showLabels ? "On" : "Off")
            .accessibilityHint("Double tap to toggle. Touch and hold to adjust opacity.")
            if !dense {
            Rectangle().fill(Theme.stroke).frame(width: 1, height: 18)
            Button { showLabelPopover = true } label: {
                Text("\(Int((state.labelOpacity * 100).rounded()))%")
                    .font(Theme.mono(11, .semibold))
                    .foregroundStyle(state.showLabels ? Theme.text : Theme.textTertiary)
                    .padding(.horizontal, 9).frame(height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Label opacity")
            .accessibilityValue("\(Int((state.labelOpacity * 100).rounded())) percent")
            }
        }
        .popover(isPresented: $showLabelPopover) {
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    HStack {
                        Text("Label opacity").font(Theme.ui(13, .semibold))
                        Spacer()
                        Text("\(Int((state.labelOpacity * 100).rounded()))%").font(Theme.mono(12))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Slider(value: Binding(get: { Double(state.labelOpacity) },
                                          set: { state.labelOpacity = Float($0); state.showLabels = true }),
                           in: 0...1)
                    Toggle("Show labels", isOn: $state.showLabels).font(Theme.ui(13))
                }
                .padding(Theme.Space.l)
                .frame(width: 260)
                .presentationCompactAdaptation(.popover)
        }
        .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
        .overlay(Capsule().strokeBorder(Theme.stroke))
    }
}

/// Icon-only segmented control for the tool and layout pickers. Same visual language as
/// `GeneralizableSegmented`, but each item carries its own accessibility label so VoiceOver
/// announces "Navigate" / "Measure" / "2×2 layout" rather than a bare SF Symbol name — the icons
/// stay unlabeled on screen to fit the row at iPhone Duo width.
private struct GZIconSegmented<T: Hashable>: View {
    struct Item { var value: T; var icon: String; var accessibilityLabel: String }
    @Binding var selection: T
    var items: [Item]
    var dense: Bool
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                let on = item.value == selection
                Button {
                    withAnimation(.snappy(duration: 0.22)) { selection = item.value }
                } label: {
                    Image(systemName: item.icon).font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(on ? Color.white : Theme.textSecondary)
                        .padding(.horizontal, dense ? 5 : 8)
                        .frame(height: 28)
                        .background {
                            if on {
                                Capsule().fill(Theme.accent.opacity(0.85))
                                    .matchedGeometryEffect(id: "pill", in: ns)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.accessibilityLabel)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
        .overlay(Capsule().strokeBorder(Theme.stroke))
        .sensoryFeedback(.selection, trigger: selection)
    }
}
