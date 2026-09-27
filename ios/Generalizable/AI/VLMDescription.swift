// VLMDescription — the cached Hugging Face vision-language model description for a case
// (Cases/<id>/analysis.json, written by scripts/ml/hf_analyze.py; PRD A11). Port of the team
// reference app's App/UI/AnalysisCard.swift `CaseAnalysis`. The app never calls the network:
// the result is precomputed so the demo works offline. Research description only.
import Foundation

struct VLMDescription: Decodable {
    struct Result: Decodable {
        var structures: [String]?
        var observations: [String]?
        var confidence: String?
        var caveat: String?
    }
    var model: String
    var views: [String]?
    var blind: Bool?
    var roi: Bool?
    var result: Result
    /// What the models said on the full slices, when that differs from the shipped (ROI) answer.
    var full_slices_blind: String?

    var shortModel: String { model.split(separator: "/").last.map(String.init) ?? model }

    /// How the model was prompted, stated plainly so nobody mistakes an echo for a detection.
    var promptDisclosure: String {
        if blind == true && roi == true { return "Shown a close-up of the highlighted region, not told what it is." }
        if blind == true { return "Not told about any finding." }
        return "Told what the dataset annotates."
    }

    /// nil when the case folder has no analysis.json.
    static func load(caseFolder: URL?) -> VLMDescription? {
        guard let url = caseFolder?.appendingPathComponent("analysis.json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(VLMDescription.self, from: data)
    }
}
