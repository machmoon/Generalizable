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

    var body: some View {
        VStack(spacing: Theme.Space.s) {
            HStack(spacing: Theme.Space.m) {
                LumenIconButton(systemName: "chevron.left", action: onBack)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.loaded.info.title)
                        .font(Theme.ui(15, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(state.loaded.info.id)
                        .font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                }
                Spacer(minLength: 4)
                LumenIconButton(systemName: "list.bullet.below.rectangle", active: showOrgans) {
                    showOrgans.toggle()
                }
                LumenIconButton(systemName: "doc.text.magnifyingglass", active: showReport) {
                    showReport = true
                }
            }
            ScrollView(.horizontal) {
                HStack(spacing: Theme.Space.s) {
                    LumenSegmented(selection: $state.activeTool, items: ViewerState.Tool.allCases.map {
                        .init(value: $0, title: nil, icon: $0.lumenIcon)
                    }, compact: true)
                    windowMenu
                    labelsControl
                    LumenSegmented(selection: layoutBinding, items: ViewerLayout.allCases.map {
                        .init(value: $0, title: nil, icon: $0.lumenIcon)
                    }, compact: true)
                }
                .padding(.vertical, 1)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var layoutBinding: Binding<ViewerLayout> {
        Binding(get: { state.layout }, set: { v in withAnimation(.snappy(duration: 0.3)) { state.layout = v } })
    }

    private var windowMenu: some View {
        Menu {
            ForEach(WindowLevel.presets) { p in
                Button {
                    state.window = p
                } label: {
                    if state.window == p {
                        Label("\(p.name)   W \(Int(p.width)) · L \(Int(p.center))", systemImage: "checkmark")
                    } else {
                        Text("\(p.name)   W \(Int(p.width)) · L \(Int(p.center))")
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "circle.lefthalf.filled").font(.system(size: 12, weight: .semibold))
                Text(state.window.name).font(Theme.ui(12, .semibold)).lineLimit(1)
                Text("\(Int(state.window.width))/\(Int(state.window.center))")
                    .font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 11).frame(height: 34)
            .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
            .overlay(Capsule().strokeBorder(Theme.stroke))
        }
    }

    private var labelsControl: some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.snappy) { state.showLabels.toggle() }
            } label: {
                Image(systemName: state.showLabels ? "eye.fill" : "eye.slash")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(state.showLabels ? Theme.accent : Theme.textSecondary)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Rectangle().fill(Theme.stroke).frame(width: 1, height: 18)
            Button { showLabelPopover = true } label: {
                Text("\(Int((state.labelOpacity * 100).rounded()))%")
                    .font(Theme.mono(11, .semibold))
                    .foregroundStyle(state.showLabels ? Theme.text : Theme.textTertiary)
                    .padding(.horizontal, 9).frame(height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
        }
        .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
        .overlay(Capsule().strokeBorder(Theme.stroke))
    }
}
