// Slice probability track: per-axial-slice model probability as a heat strip beside the
// right-edge scrubber. Same vertical mapping as SliceScrubber (top = highest z; thumb centre
// at 9 + frac·(h-18)), colours from the NiiVue inferno LUT (see AILoader.swift).
//
// Drawn on its own rounded track (like SliceScrubber's capsule) rather than directly on the
// image: a run of consecutive high-probability slices (common — a bleed usually spans many
// slices) fills much of the strip's height at near-full brightness, and with no track behind
// it that solid saturated-yellow block was mistaken for a mis-sampled/misaligned AI heatmap.
// The track's background + border make clear this is a UI legend, not image content.
import SwiftUI

struct AIProbabilityTrack: View {
    @Bindable var state: ViewerState
    let ai: AIResult

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height, w = geo.size.width
            let n = max(state.sliceCount(for: .axial), 1)
            Canvas { ctx, _ in
                func y(_ z: Int) -> CGFloat { 9 + (n > 1 ? 1 - CGFloat(z) / CGFloat(n - 1) : 0) * max(h - 18, 0) }
                let track = Path(roundedRect: CGRect(x: 0, y: 9, width: w, height: max(h - 18, 0)), cornerRadius: w / 2)
                ctx.fill(track, with: .color(.black.opacity(0.4)))
                ctx.stroke(track, with: .color(.white.opacity(0.16)), lineWidth: 0.75)
                let rowH = max(max(h - 18, 1) / CGFloat(n) + 0.5, 1)
                for (z, p) in ai.sliceProbability.enumerated() where z < n && p > 0.02 {
                    let c = AILoader.infernoLUT[Int(min(max(p, 0), 1) * 255)]
                    let bw = max((w - 6) * CGFloat(p), 1.5)
                    let bar = CGRect(x: w - 3 - bw, y: y(z) - rowH / 2, width: bw, height: rowH)
                    ctx.fill(Path(roundedRect: bar, cornerRadius: min(rowH, bw) / 2),
                             with: .color(Color(red: Double(c.x) / 255, green: Double(c.y) / 255, blue: Double(c.z) / 255)))
                }
                if let pk = ai.peakSlice {
                    let py = y(pk)
                    var tri = Path()
                    tri.move(to: CGPoint(x: 0, y: py - 3.5)); tri.addLine(to: CGPoint(x: 4, y: py))
                    tri.addLine(to: CGPoint(x: 0, y: py + 3.5)); tri.closeSubpath()
                    ctx.fill(tri, with: .color(.orange))
                }
                let cy = y(Int(state.slice(for: .axial)))
                ctx.fill(Path(CGRect(x: 4, y: cy - 0.75, width: w - 4, height: 1.5)), with: .color(.white))
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { v in
                let f = min(max((v.location.y - 9) / max(h - 18, 1), 0), 1)
                state.setSlice(Float(((1 - f) * CGFloat(n - 1)).rounded()), for: .axial)
            })
            .accessibilityLabel("AI slice probability")
        }
    }
}
