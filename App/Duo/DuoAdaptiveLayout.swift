import SwiftUI

// DuoAdaptiveLayout (contract: docs/contracts/render-interface.md)
//
// One custom `Layout` with fixed slots, so the slice (an MTKView) and the controls keep
// their identity across every pose change. There is never an if/else between stacks.
//
// Prior art:
// - google/accompanist `adaptive/src/main/java/com/google/accompanist/adaptive/TwoPane.kt`
//   (`TwoPane` L108-135: a single `Layout` with two fixed `layoutId` slots; L400-460:
//   `FoldAwareHorizontalTwoPaneStrategy` / `FoldAwareVerticalTwoPaneStrategy` pick the split
//   axis from the fold's orientation and use the fold bounds as the gap, `SplitResult(gapOrientation,
//   gapBounds)`). `FoldSplit` below mirrors `SplitResult`.
// - Apple SDK: SwiftUICore.swiftinterface (iPhoneSimulator27.1.sdk) `GeometryProxy.reservedRegions(kind:options:)`,
//   `ReservedRegion { kind, frame, margins, isActive }`, kinds `.division` / `.occlusion`,
//   option `.includeInactive`. UIKit/UIViewReservedRegion.h documents `frame` as "in the view's
//   coordinate space, including the margins ... for interactive content", so the gap is exactly `frame`.

// MARK: - Public view

struct DuoAdaptiveLayout<Slice: View, Controls: View>: View {
    private let slice: Slice
    private let controls: Controls

    @State private var pose: DuoPose = .noHinge
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(@ViewBuilder slice: () -> Slice, @ViewBuilder controls: () -> Controls) {
        self.slice = slice()
        self.controls = controls()
    }

    var body: some View {
        GeometryReader { proxy in
            let regions = DuoRegions.read(from: proxy, pose: pose)
            let split = FoldSplit.resolve(size: proxy.size,
                                          pose: pose,
                                          fold: regions.fold,
                                          isRegularWidth: hSize == .regular)
            FoldSplitLayout(split: split, occlusions: regions.occlusions) {
                // Slot order is load-bearing: 0 = slice, 1 = controls, 2 = gap paint.
                slice
                    .clipped()
                ScrollView(.vertical) {
                    controls
                        .frame(maxWidth: .infinity, alignment: .top)
                }
                .scrollBounceBehavior(.basedOnSize)
                Color.black
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: split.kind)
            .overlay(alignment: .topLeading) { DebugFoldOverlay(split: split, regions: regions) }
        }
        .background(Color.black)
        .onDuoPoseChange { newPose, _ in
            if newPose != pose { pose = newPose }
        }
    }
}

// MARK: - Split model (mirrors accompanist SplitResult)

enum SplitKind: Equatable {
    /// Horizontal fold (laptop / table pose): slice above, controls below.
    case table
    /// Vertical fold (book pose) or wide/regular width: controls leading, slice trailing.
    case book
    /// iPad regular width with no fold: controls leading at clamp(0.38W, 320, 440).
    case regularSidebar
    /// Compact iPhone or closed Duo: slice on top at min(W, 0.55H), controls scroll underneath.
    case stacked
}

struct FoldSplit: Equatable {
    var kind: SplitKind
    /// The gap in container coordinates (the fold's reserved frame, or synthetic). `.zero` when none.
    var gap: CGRect
    /// True when `gap` came from the SDK, false when synthesized.
    var gapIsMeasured: Bool

    static let syntheticFoldThickness: CGFloat = 24

    static func resolve(size: CGSize, pose: DuoPose, fold: CGRect?, isRegularWidth: Bool) -> FoldSplit {
        let bounds = CGRect(origin: .zero, size: size)
        let hingeOpen = pose == .partiallyOpen || pose == .fullyOpen

        // 1. A real division region that overlaps us wins (accompanist: `bounds.overlaps(...)`).
        //    Queried with .includeInactive so going fully open (flat) keeps the same split.
        if let fold, !fold.isEmpty, fold.intersects(bounds), pose != .closed {
            let gap = fold.intersection(bounds)
            let isHorizontalFold = gap.width >= gap.height
            return FoldSplit(kind: isHorizontalFold ? .table : .book, gap: gap, gapIsMeasured: true)
        }

        // 2. Hinge says open but the simulator returned no region: synthesize a 24 pt fold at the
        //    midline across the longer axis (a folding phone's hinge splits its long side).
        if hingeOpen {
            let t = syntheticFoldThickness
            if size.height >= size.width {
                return FoldSplit(kind: .table,
                                 gap: CGRect(x: 0, y: size.height / 2 - t / 2, width: size.width, height: t),
                                 gapIsMeasured: false)
            } else {
                return FoldSplit(kind: .book,
                                 gap: CGRect(x: size.width / 2 - t / 2, y: 0, width: t, height: size.height),
                                 gapIsMeasured: false)
            }
        }

        // 3. No fold.
        if isRegularWidth { return FoldSplit(kind: .regularSidebar, gap: .zero, gapIsMeasured: false) }
        // Compact landscape phone: stacking a min(W, 0.55H) slice leaves no room, so go side by side.
        if size.width > size.height * 1.2 { return FoldSplit(kind: .book, gap: .zero, gapIsMeasured: false) }
        return FoldSplit(kind: .stacked, gap: .zero, gapIsMeasured: false)
    }
}

// MARK: - Reserved regions (iOS 27.1 behind #available)

struct DuoRegions: Equatable {
    var fold: CGRect?
    var occlusions: [CGRect]

    static let none = DuoRegions(fold: nil, occlusions: [])

    static func read(from proxy: GeometryProxy, pose: DuoPose) -> DuoRegions {
        guard #available(iOS 27.1, *) else { return .none }
        let divisions = proxy.reservedRegions(kind: .division, options: .includeInactive)
        let occlusions = proxy.reservedRegions(kind: .occlusion)
            .filter(\.isActive)
            .map(\.frame)
        // Prefer an active division; fall back to an inactive one (flat keeps the split).
        let fold = (divisions.first(where: \.isActive) ?? divisions.first)?.frame
        return DuoRegions(fold: fold, occlusions: occlusions)
    }
}

// MARK: - The Layout

/// Fixed three-slot layout: [slice, controls, gap paint]. Every pose places the same three
/// subviews, so SwiftUI never tears down the MTKView or the controls' state.
struct FoldSplitLayout: Layout {
    var split: FoldSplit
    var occlusions: [CGRect]

    /// Minimum clearance between any control and the fold or an occlusion region (spec §4).
    static let controlClearance: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else {
            for s in subviews { s.place(at: bounds.origin, proposal: .init(bounds.size)) }
            return
        }
        let frames = Self.frames(for: split, in: CGRect(origin: .zero, size: bounds.size))
        var controlsRect = frames.controls
        for occ in occlusions { controlsRect = Self.avoid(occ.insetBy(dx: -Self.controlClearance, dy: -Self.controlClearance), in: controlsRect) }

        place(subviews[0], in: frames.slice, offset: bounds.origin)
        place(subviews[1], in: controlsRect, offset: bounds.origin)
        place(subviews[2], in: frames.gap, offset: bounds.origin)
    }

    private func place(_ view: LayoutSubview, in rect: CGRect, offset: CGPoint) {
        let r = rect.standardized
        view.place(at: CGPoint(x: r.minX + offset.x, y: r.minY + offset.y),
                   anchor: .topLeading,
                   proposal: ProposedViewSize(width: max(r.width, 0), height: max(r.height, 0)))
    }

    struct Frames { var slice: CGRect; var controls: CGRect; var gap: CGRect }

    static func frames(for split: FoldSplit, in b: CGRect) -> Frames {
        let W = b.width, H = b.height
        let c = controlClearance
        switch split.kind {
        case .table:
            let g = split.gap
            let slice = CGRect(x: 0, y: 0, width: W, height: max(g.minY, 0))
            let controlsTop = min(g.maxY + c, H)
            let controls = CGRect(x: 0, y: controlsTop, width: W, height: max(H - controlsTop, 0))
            return Frames(slice: slice, controls: controls, gap: g)

        case .book:
            if split.gap.isEmpty {
                // Wide, no fold: controls leading at the same clamp as iPad, slice trailing.
                let cw = min(max(0.38 * W, 280), 440)
                return Frames(slice: CGRect(x: cw, y: 0, width: W - cw, height: H),
                              controls: CGRect(x: 0, y: 0, width: cw, height: H),
                              gap: CGRect(x: cw, y: 0, width: 0, height: H))
            }
            let g = split.gap
            let controlsRight = max(g.minX - c, 0)
            let controls = CGRect(x: 0, y: 0, width: controlsRight, height: H)
            let slice = CGRect(x: g.maxX, y: 0, width: max(W - g.maxX, 0), height: H)
            return Frames(slice: slice, controls: controls, gap: g)

        case .regularSidebar:
            let cw = min(max(0.38 * W, 320), 440)
            return Frames(slice: CGRect(x: cw, y: 0, width: W - cw, height: H),
                          controls: CGRect(x: 0, y: 0, width: cw, height: H),
                          gap: CGRect(x: cw, y: 0, width: 0, height: H))

        case .stacked:
            let sh = min(W, 0.55 * H)
            return Frames(slice: CGRect(x: 0, y: 0, width: W, height: sh),
                          controls: CGRect(x: 0, y: sh, width: W, height: H - sh),
                          gap: CGRect(x: 0, y: sh, width: W, height: 0))
        }
    }

    /// Shrinks `rect` from whichever single edge loses the least area so it no longer
    /// intersects `obstacle`. Good enough for the camera-island style occlusions we expect.
    static func avoid(_ obstacle: CGRect, in rect: CGRect) -> CGRect {
        guard rect.intersects(obstacle) else { return rect }
        let candidates = [
            CGRect(x: rect.minX, y: obstacle.maxY, width: rect.width, height: rect.maxY - obstacle.maxY),   // below
            CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: obstacle.minY - rect.minY),       // above
            CGRect(x: obstacle.maxX, y: rect.minY, width: rect.maxX - obstacle.maxX, height: rect.height),  // right
            CGRect(x: rect.minX, y: rect.minY, width: obstacle.minX - rect.minX, height: rect.height),      // left
        ].filter { $0.width > 0 && $0.height > 0 }
        return candidates.max(by: { $0.width * $0.height < $1.width * $1.height }) ?? rect
    }
}

// MARK: - DEBUG overlay (-showFold)

private struct DebugFoldOverlay: View {
    let split: FoldSplit
    let regions: DuoRegions

    var body: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-showFold") {
            ZStack(alignment: .topLeading) {
                Rectangle()
                    .fill(Color.red.opacity(0.35))
                    .overlay(Rectangle().stroke(Color.red, lineWidth: 1))
                    .frame(width: max(split.gap.width, 1), height: max(split.gap.height, 1))
                    .offset(x: split.gap.minX, y: split.gap.minY)
                ForEach(Array(regions.occlusions.enumerated()), id: \.offset) { _, r in
                    Rectangle().stroke(Color.orange, lineWidth: 1)
                        .frame(width: r.width, height: r.height)
                        .offset(x: r.minX, y: r.minY)
                }
                Text("\(String(describing: split.kind)) · \(split.gapIsMeasured ? "measured" : "synthetic") · \(Int(split.gap.minX)),\(Int(split.gap.minY)) \(Int(split.gap.width))×\(Int(split.gap.height))")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white)
                    .padding(4)
                    .background(Color.red.opacity(0.7))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        #endif
    }
}
