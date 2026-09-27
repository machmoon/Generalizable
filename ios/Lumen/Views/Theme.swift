// Lumen design tokens. Owned by agent shell.
//
// Plane accent colours follow the 3D Slicer convention (axial = red, sagittal = yellow,
// coronal = green; Slicer/Libs/MRML/Core/vtkMRMLSliceNode.cxx `SetOrientationToAxial` etc.
// set the slice node layout colours), which OHIF also mirrors for MPR viewports.
import SwiftUI

enum Theme {
    // Surfaces
    static let bg = Color(red: 0.027, green: 0.030, blue: 0.038)
    static let pane = Color(red: 0.0, green: 0.0, blue: 0.0)
    static let surface = Color(red: 0.075, green: 0.080, blue: 0.094)
    static let surfaceHi = Color(red: 0.12, green: 0.128, blue: 0.148)
    static let stroke = Color.white.opacity(0.08)
    static let strokeHi = Color.white.opacity(0.16)

    // Text
    static let text = Color.white.opacity(0.94)
    static let textSecondary = Color.white.opacity(0.60)
    static let textTertiary = Color.white.opacity(0.36)

    // Accents
    static let accent = Color(red: 0.34, green: 0.70, blue: 1.0)
    static let accentSoft = Color(red: 0.34, green: 0.70, blue: 1.0).opacity(0.18)
    static let danger = Color(red: 1.0, green: 0.38, blue: 0.36)
    static let success = Color(red: 0.35, green: 0.85, blue: 0.55)

    enum Space {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }
    enum Radius {
        static let control: CGFloat = 9
        static let pane: CGFloat = 12
        static let card: CGFloat = 18
    }

    /// SF Mono for every number on screen (slice indices, HU, W/L, sizes).
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func planeColor(_ p: Plane) -> Color {
        switch p {
        case .axial: Color(red: 0.95, green: 0.36, blue: 0.36)
        case .sagittal: Color(red: 0.98, green: 0.82, blue: 0.30)
        case .coronal: Color(red: 0.42, green: 0.86, blue: 0.48)
        }
    }
    static let volumeColor = Color(red: 0.62, green: 0.52, blue: 1.0)
}

extension Plane {
    var lumenTitle: String { rawValue.capitalized }
    var lumenShort: String {
        switch self { case .axial: "AX"; case .sagittal: "SAG"; case .coronal: "COR" }
    }
}

extension ViewerState.Tool {
    var lumenTitle: String {
        switch self {
        case .navigate: "Navigate"
        case .windowLevel: "Window / Level"
        case .measure: "Measure"
        case .probe: "Probe"
        }
    }
    var lumenIcon: String {
        switch self {
        case .navigate: "hand.point.up.left"
        case .windowLevel: "circle.lefthalf.filled"
        case .measure: "ruler"
        case .probe: "scope"
        }
    }
}

extension ViewerLayout {
    var lumenTitle: String {
        switch self { case .quad: "2×2"; case .single: "Single"; case .volumeFocus: "3D" }
    }
    var lumenIcon: String {
        switch self { case .quad: "square.grid.2x2"; case .single: "square"; case .volumeFocus: "cube" }
    }
}

extension VolumeRenderMode {
    var lumenTitle: String {
        switch self { case .meshes: "Meshes"; case .volume: "Volume"; case .mip: "MIP" }
    }
}

// MARK: - Reusable controls

/// Capsule segmented control with a sliding selection pill.
struct LumenSegmented<T: Hashable>: View {
    struct Item { var value: T; var title: String?; var icon: String? }
    @Binding var selection: T
    var items: [Item]
    var compact = false
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                let on = item.value == selection
                Button {
                    withAnimation(.snappy(duration: 0.22)) { selection = item.value }
                } label: {
                    HStack(spacing: 5) {
                        if let icon = item.icon { Image(systemName: icon).font(.system(size: 13, weight: .semibold)) }
                        if let t = item.title { Text(t).font(Theme.ui(12, .semibold)) }
                    }
                    .foregroundStyle(on ? Color.white : Theme.textSecondary)
                    .padding(.horizontal, compact ? 8 : 11)
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
            }
        }
        .padding(3)
        .background(Capsule().fill(Theme.surfaceHi.opacity(0.9)))
        .overlay(Capsule().strokeBorder(Theme.stroke))
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// Round icon button used in toolbars.
struct LumenIconButton: View {
    var systemName: String
    var active = false
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(active ? Color.white : Theme.text)
                .frame(width: 36, height: 36)
                .background(Circle().fill(active ? Theme.accent.opacity(0.85) : Theme.surfaceHi))
                .overlay(Circle().strokeBorder(Theme.stroke))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }
}

/// Small metadata chip.
struct LumenChip: View {
    var text: String
    var icon: String? = nil
    var tint: Color = Theme.textSecondary
    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)) }
            Text(text).font(Theme.ui(10.5, .medium)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 7).padding(.vertical, 3.5)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().strokeBorder(Theme.stroke))
    }
}

struct LumenCardBackground: ViewModifier {
    var radius: CGFloat = Theme.Radius.card
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.stroke))
    }
}

extension View {
    func lumenCard(radius: CGFloat = Theme.Radius.card) -> some View { modifier(LumenCardBackground(radius: radius)) }
}
