// Compact AI result pill shown at the bottom-left of the axial pane.
import SwiftUI

struct AICard: View {
    @Bindable var state: ViewerState
    let ai: AIResult

    var body: some View {
        HStack(spacing: 7) {
            VStack(alignment: .leading, spacing: 1) {
                Text("AI: \(headline)").font(.caption.weight(.semibold)).lineLimit(1)
                Text("research model · not a diagnosis").font(.system(size: 8)).foregroundStyle(.secondary)
            }
            Button { jumpToPeak() } label: { Image(systemName: "scope").font(.caption) }
                .accessibilityLabel("Jump to the slice the model is most confident on")
            Button { state.showAI.toggle() } label: {
                Image(systemName: state.showAI ? "eye.fill" : "eye.slash").font(.caption)
            }
            .accessibilityLabel(state.showAI ? "Hide AI heatmap" : "Show AI heatmap")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .padding(.horizontal, 9).padding(.vertical, 6)
        .background(.black.opacity(0.55), in: Capsule())
        .fixedSize()
        #if DEBUG
        .onAppear { if UserDefaults.standard.bool(forKey: "aiJumpToPeak") { jumpToPeak() } }
        #endif
    }

    private var headline: String {
        let name = AICard.plainLabel(for: ai.headlineClass)
        guard let p = ai.headlineProbability else { return name }
        return "\(name) \(String(format: "%.1f", p * 100))%"
    }

    /// Plain-language label for the model's ICH sub-type classes (ai.json `headlineClass`),
    /// so the pill reads like a finding, not a pathology-course term.
    static func plainLabel(for rawClass: String) -> String {
        switch rawClass.lowercased() {
        case "subdural": "subdural bleed"
        case "epidural": "epidural bleed"
        case "subarachnoid": "subarachnoid bleed"
        case "intraparenchymal": "brain bleed"
        case "intraventricular": "bleed in the ventricles"
        case "any": "bleeding"
        default: rawClass.capitalized
        }
    }

    func jumpToPeak() { AICard.jumpToPeak(state: state, ai: ai) }

    static func jumpToPeak(state: ViewerState, ai: AIResult) {
        guard let z = ai.peakSlice else { return }
        var c = state.cursor
        c.z = Float(z)
        if let xy = ai.heatCentroid(z: z) { c.x = xy.x.rounded(); c.y = xy.y.rounded() }
        state.cursor = state.geometry.clamp(c)
        state.showAI = true
    }
}
