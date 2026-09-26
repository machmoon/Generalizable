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
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.loaded.info.title)
                        .font(Theme.ui(15, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    // The title already carries the case number; the full ID moved out to make room.
                    Text("Not a diagnosis")
                        .font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                }
                .layoutPriority(1)
                Spacer(minLength: 4)
                GeneralizableIconButton(systemName: "list.bullet.below.rectangle", active: showOrgans) {
                    showOrgans.toggle()
                }
                GeneralizableIconButton(systemName: "doc.text.magnifyingglass", active: showReport) {
                    showReport = true
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

    private func toolRow(dense: Bool) -> some View {
        HStack(spacing: dense ? 6 : Theme.Space.s) {
            GeneralizableSegmented(selection: $state.activeTool, items: ViewerState.Tool.allCases.map {
                .init(value: $0, title: nil, icon: $0.gzIcon)
            }, compact: true, dense: dense)
            windowMenu(dense: dense)
            labelsControl(dense: dense)
            if !dense { Spacer(minLength: 0) }
            GeneralizableSegmented(selection: layoutBinding, items: ViewerLayout.allCases.map {
                .init(value: $0, title: nil, icon: $0.gzIcon)
            }, compact: true, dense: dense)
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
    }

    private func labelsControl(dense: Bool) -> some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.snappy) { state.showLabels.toggle() }
            } label: {
                Image(systemName: state.showLabels ? "eye.fill" : "eye.slash")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(state.showLabels ? Theme.accent : Theme.textSecondary)
                    .frame(width: dense ? 32 : 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .simultaneousGesture(LongPressGesture().onEnded { _ in showLabelPopover = true })
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
