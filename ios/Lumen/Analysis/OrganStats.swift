// Per-organ statistics and lesion summary for one loaded case.
//
// Prior art (ported, same metric names where they overlap):
// - BodyMaps flask-server/services/nifti_processor.py `NiftiProcessor.calculate_metrics`:
//   voxel_count, volume_cm3 (= voxel_count * |det(affine[:3,:3])| / 1000), mean_hu,
//   standard_deviation, min_value, max_value, center (mean voxel coord), and `truncated`
//   (mask touches the first/last axial slice with a component of >= 8 voxels; we use the
//   simpler "≥ 8 voxels on that slice" test, stated here as the one deviation).
// - PanTS-Demo/src/helpers/organNorms.ts: `percentileOf` / `lookupBucket` / `ageToBin` for
//   population percentiles against `organ_norms.json` (produced by
//   flask-server/scripts/compute_organ_norms.py). BodyMaps does not ship that JSON in the
//   repo, so percentiles only appear if an `organ_norms.json` is bundled; otherwise nil,
//   exactly like the web panel omits the column.
// - PanTS-Demo/src/helpers/reportFindings.ts: `sizeDescriptor` thresholds, `organRoot`,
//   `organLocation` (head/body/tail, left/right) and the >5 cc organ-list filter.
//
// Everything is one pass over labels + CT (plus a small BFS over lesion voxels only).

import Foundation
import simd

struct OrganStat: Identifiable, Sendable, Hashable {
    var organ: Organ
    var id: UInt8 { organ.rawValue }
    var voxelCount: Int
    /// mL == cm³ (BodyMaps `volume_cm3`).
    var volumeML: Double
    var meanHU: Double
    var stdHU: Double
    var minHU: Int16
    var maxHU: Int16
    /// Mean voxel coordinate (canonical voxel space) — BodyMaps `center_voxel_coord`.
    var centroidVoxel: SIMD3<Float>
    /// Centroid in world mm via the case affine.
    var centroidMM: SIMD3<Float>
    var bboxMin: SIMD3<Int32>
    var bboxMax: SIMD3<Int32>
    /// Bounding-box extents in mm (R-L, A-P, S-I).
    var extentMM: SIMD3<Float>
    /// Mask touches the first/last axial slice — volume may be clipped by the scan range.
    var truncated: Bool
    /// Population percentile (0–100) when norms are available.
    var percentile: Double?
}

struct LesionFinding: Identifiable, Sendable, Hashable {
    var id: Int
    var kind: Organ               // .pancreaticLesion, .liverLesion, ...
    var voxelCount: Int
    var volumeML: Double
    var meanHU: Double
    var stdHU: Double
    var centroidVoxel: SIMD3<Float>
    /// Longest in-plane (axial) diameter in mm (max Feret over axial slices).
    var longAxisMM: Float
    /// Perpendicular diameter on the same slice, mm.
    var shortAxisMM: Float
    /// Organ (or sub-part) the lesion sits in, by neighbourhood overlap. e.g. .pancreasHead.
    var host: Organ?

    /// "pancreas head", "kidney left", "liver".
    var locationText: String {
        guard let host else { return Analysis.organRoot(kind) }
        if let loc = Analysis.organLocation(host) {
            return loc.type == .lateral ? "\(loc.word) \(Analysis.organRoot(host))"
                                        : "\(Analysis.organRoot(host)) \(loc.word)"
        }
        return Analysis.organRoot(host)
    }
}

struct CaseReport: Sendable {
    var caseID: String
    var organs: [OrganStat]          // sorted by label id
    var lesions: [LesionFinding]     // largest first
    var normsBasis: String?
    func stat(_ o: Organ) -> OrganStat? { organs.first { $0.organ == o } }
}

enum Analysis {

    // MARK: reportFindings.ts helpers

    /// `organRoot` from reportFindings.ts, adapted to Organ.
    static func organRoot(_ o: Organ) -> String {
        let k = o.key
        if k.hasPrefix("pancrea") { return o == .pancreaticDuct ? "pancreatic duct" : "pancreas" }
        if k.hasPrefix("kidney") { return "kidney" }
        switch o {
        case .liverLesion: return "liver"
        case .colonLesion: return "colon"
        default: break
        }
        return k.replacingOccurrences(of: #"_(gland|body|tail|head|left|right)$"#, with: "",
                                      options: .regularExpression)
            .replacingOccurrences(of: "_", with: " ").lowercased()
    }

    enum LocationType { case lateral, subregion }
    /// `organLocation` from reportFindings.ts.
    static func organLocation(_ o: Organ) -> (type: LocationType, word: String)? {
        let suffix = o.key.split(separator: "_").last.map(String.init) ?? ""
        if suffix == "left" || suffix == "right" { return (.lateral, suffix) }
        if ["tail", "head", "body"].contains(suffix) { return (.subregion, suffix) }
        return nil
    }

    /// `sizeDescriptor` from reportFindings.ts (max dimension in cm first, then volume in cc).
    static func sizeDescriptor(volumeCC: Double?, maxDimCM: Double?) -> String {
        if let d = maxDimCM {
            if d < 1 { return "tiny" }
            if d < 2 { return "small" }
            if d < 5 { return "noticeable" }
            return "sizable"
        }
        if let v = volumeCC {
            if v < 1 { return "tiny" }
            if v < 5 { return "small" }
            if v < 20 { return "noticeable" }
            return "sizable"
        }
        return ""
    }

    /// Candidate host organs for a lesion kind, most specific first.
    static func hostCandidates(for lesion: Organ) -> [Organ] {
        switch lesion {
        case .pancreaticLesion: return [.pancreasHead, .pancreasBody, .pancreasTail, .pancreas]
        case .liverLesion: return [.liver]
        case .kidneyLesion: return [.kidneyLeft, .kidneyRight]
        case .colonLesion: return [.colon]
        default: return []
        }
    }

    // MARK: Norms (organNorms.ts)

    struct NormBucket: Decodable, Sendable { var n: Int; var q: [Double] }
    struct OrganNorms: Decodable, Sendable {
        var version: Int
        var min_n: Int?
        var percentile_grid: [Double]
        var organs: [String: [String: NormBucket]]
    }

    static func ageToBin(_ age: String?) -> String {
        guard let s = age, let a = Double(s.filter { "0123456789.".contains($0) }), a >= 0 else { return "UNKNOWN" }
        let lo = min(Int(a / 10) * 10, 90)
        return "\(lo)-\(lo + 9)"
    }
    static func normalizeSex(_ s: String?) -> String {
        let u = (s ?? "").trimmingCharacters(in: .whitespaces).uppercased()
        return u == "M" || u == "F" ? u : "ALL"
    }
    /// `percentileOf` — linear interpolation over quantile breakpoints, clamped.
    static func percentileOf(_ value: Double, grid: [Double], q: [Double]) -> Double {
        let n = min(grid.count, q.count)
        guard n > 0, value.isFinite else { return .nan }
        if value <= q[0] { return grid[0] }
        if value >= q[n - 1] { return grid[n - 1] }
        for i in 0..<(n - 1) where value >= q[i] && value <= q[i + 1] {
            if q[i + 1] == q[i] { return grid[i] }
            return grid[i] + (value - q[i]) / (q[i + 1] - q[i]) * (grid[i + 1] - grid[i])
        }
        return grid[n - 1]
    }
    static func lookupBucket(_ norms: OrganNorms, organ: String, sex: String?, age: String?) -> (String, NormBucket)? {
        guard let by = norms.organs[organ] else { return nil }
        let s = normalizeSex(sex), bin = ageToBin(age), minN = norms.min_n ?? 1
        let keys = s == "ALL" ? ["ALL|\(bin)", "ALL|ALL"] : ["\(s)|\(bin)", "\(s)|ALL", "ALL|\(bin)", "ALL|ALL"]
        for k in keys { if let b = by[k], b.n >= minN, !b.q.isEmpty { return (k, b) } }
        return nil
    }
    static func loadBundledNorms() -> OrganNorms? {
        guard let url = Bundle.main.url(forResource: "organ_norms", withExtension: "json")
                ?? Bundle.main.url(forResource: "Cases/organ_norms", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(OrganNorms.self, from: data)
    }

    // MARK: Main computation

    static func compute(_ loaded: LoadedCase, norms: OrganNorms? = nil) -> CaseReport {
        guard let labels = loaded.labels else {
            return CaseReport(caseID: loaded.info.id, organs: [], lesions: [], normsBasis: nil)
        }
        let r = compute(ct: loaded.ct, labels: labels, sex: loaded.info.metadata["sex"],
                        age: loaded.info.metadata["age"], norms: norms)
        return CaseReport(caseID: loaded.info.id, organs: r.organs, lesions: r.lesions, normsBasis: r.normsBasis)
    }

    static func compute(ct: CTVolume, labels: LabelVolume, sex: String? = nil, age: String? = nil,
                        norms: OrganNorms? = nil) -> CaseReport {
        let g = labels.geometry
        let nx = Int(g.dims.x), ny = Int(g.dims.y), nz = Int(g.dims.z)
        let sp = SIMD3<Double>(g.spacing)
        let voxelML = sp.x * sp.y * sp.z / 1000.0

        var count = [Int](repeating: 0, count: 256)
        var sum = [Double](repeating: 0, count: 256)
        var sum2 = [Double](repeating: 0, count: 256)
        var sx = [Double](repeating: 0, count: 256)
        var sy = [Double](repeating: 0, count: 256)
        var szz = [Double](repeating: 0, count: 256)
        var mn = [Int16](repeating: .max, count: 256)
        var mx = [Int16](repeating: .min, count: 256)
        var bmin = [SIMD3<Int32>](repeating: SIMD3(repeating: .max), count: 256)
        var bmax = [SIMD3<Int32>](repeating: SIMD3(repeating: .min), count: 256)
        var firstSlice = [Int](repeating: 0, count: 256)
        var lastSlice = [Int](repeating: 0, count: 256)

        labels.voxels.withUnsafeBufferPointer { lab in
            ct.voxels.withUnsafeBufferPointer { hu in
                var i = 0
                for z in 0..<nz {
                    let isFirst = z == 0, isLast = z == nz - 1
                    for y in 0..<ny {
                        for x in 0..<nx {
                            let l = Int(lab[i])
                            if l != 0 {
                                let h = hu[i]
                                let hd = Double(h)
                                count[l] += 1; sum[l] += hd; sum2[l] += hd * hd
                                sx[l] += Double(x); sy[l] += Double(y); szz[l] += Double(z)
                                if h < mn[l] { mn[l] = h }
                                if h > mx[l] { mx[l] = h }
                                let p = SIMD3<Int32>(Int32(x), Int32(y), Int32(z))
                                bmin[l] = simd_min(bmin[l], p); bmax[l] = simd_max(bmax[l], p)
                                if isFirst { firstSlice[l] += 1 }
                                if isLast { lastSlice[l] += 1 }
                            }
                            i += 1
                        }
                    }
                }
            }
        }

        var basis: String?
        var organs: [OrganStat] = []
        for o in Organ.allCases {
            let l = Int(o.rawValue), n = count[l]
            guard n > 0 else { continue }
            let mean = sum[l] / Double(n)
            let variance = max(0, sum2[l] / Double(n) - mean * mean)   // population SD, like np.std
            let c = SIMD3<Float>(Float(sx[l] / Double(n)), Float(sy[l] / Double(n)), Float(szz[l] / Double(n)))
            let w = g.affine * SIMD4<Float>(c, 1)
            let ext = SIMD3<Float>(bmax[l] &- bmin[l] &+ 1) * g.spacing
            let vol = Double(n) * voxelML
            var pct: Double?
            if let norms, let (key, b) = lookupBucket(norms, organ: o.key, sex: sex, age: age) {
                let p = percentileOf(vol, grid: norms.percentile_grid, q: b.q)
                if p.isFinite { pct = p; basis = basis ?? key }
            }
            organs.append(OrganStat(organ: o, voxelCount: n, volumeML: vol, meanHU: mean,
                                    stdHU: variance.squareRoot(), minHU: mn[l], maxHU: mx[l],
                                    centroidVoxel: c, centroidMM: SIMD3(w.x, w.y, w.z),
                                    bboxMin: bmin[l], bboxMax: bmax[l], extentMM: ext,
                                    truncated: firstSlice[l] >= 8 || lastSlice[l] >= 8,
                                    percentile: pct))
        }

        // Lesions: connected components (26-connectivity) over each lesion label, visiting
        // only that label's bounding box.
        var lesions: [LesionFinding] = []
        let lesionKinds = Organ.allCases.filter { $0.isLesion && count[Int($0.rawValue)] > 0 }
        for kind in lesionKinds {
            let lv = kind.rawValue
            let lo = bmin[Int(lv)], hi = bmax[Int(lv)]
            var visited = Set<Int>()
            let candidates = hostCandidates(for: kind)
            labels.voxels.withUnsafeBufferPointer { lab in
                for z in Int(lo.z)...Int(hi.z) { for y in Int(lo.y)...Int(hi.y) { for x in Int(lo.x)...Int(hi.x) {
                    let seed = g.index(x, y, z)
                    guard lab[seed] == lv, !visited.contains(seed) else { continue }
                    var stack = [SIMD3<Int32>(Int32(x), Int32(y), Int32(z))]
                    visited.insert(seed)
                    var pts: [SIMD3<Int32>] = []
                    while let p = stack.popLast() {
                        pts.append(p)
                        for dz: Int32 in -1...1 { for dy: Int32 in -1...1 { for dx: Int32 in -1...1 {
                            let q = p &+ SIMD3(dx, dy, dz)
                            guard q.x >= 0, q.y >= 0, q.z >= 0, Int(q.x) < nx, Int(q.y) < ny, Int(q.z) < nz else { continue }
                            let qi = g.index(Int(q.x), Int(q.y), Int(q.z))
                            if lab[qi] == lv, visited.insert(qi).inserted { stack.append(q) }
                        } } }
                    }
                    lesions.append(summarizeLesion(kind: kind, points: pts, ct: ct, lab: lab, g: g,
                                                   candidates: candidates, id: lesions.count))
                } } }
            }
        }
        lesions.sort { $0.volumeML > $1.volumeML }
        for i in lesions.indices { lesions[i].id = i }
        return CaseReport(caseID: "", organs: organs, lesions: lesions, normsBasis: basis)
    }

    private static func summarizeLesion(kind: Organ, points: [SIMD3<Int32>], ct: CTVolume,
                                        lab: UnsafeBufferPointer<UInt8>, g: VolumeGeometry,
                                        candidates: [Organ], id: Int) -> LesionFinding {
        var s = 0.0, s2 = 0.0, c = SIMD3<Double>.zero
        var bySlice: [Int32: [SIMD2<Float>]] = [:]
        var hostVotes: [UInt8: Int] = [:]
        let candSet = Set(candidates.map(\.rawValue))
        let reach: Int32 = 3
        for p in points {
            let h = Double(ct.voxels[g.index(Int(p.x), Int(p.y), Int(p.z))])
            s += h; s2 += h * h
            c += SIMD3<Double>(p)
            bySlice[p.z, default: []].append(SIMD2(Float(p.x) * g.spacing.x, Float(p.y) * g.spacing.y))
            // Host organ by overlap with the neighbourhood (±reach voxels on each axis).
            for axis in 0..<3 { for d in [-reach, -1, 1, reach] {
                var q = p; q[axis] += d
                guard all(q .>= 0), all(q .< g.dims) else { continue }
                let l = lab[g.index(Int(q.x), Int(q.y), Int(q.z))]
                if candSet.contains(l) { hostVotes[l, default: 0] += 1 }
            } }
        }
        let n = Double(points.count)
        let mean = s / n
        // Longest axial diameter: max Feret diameter per slice (projection sweep, 2° steps),
        // then the perpendicular width on that same slice.
        var bestLong: Float = 0, bestShort: Float = 0
        for (_, pts) in bySlice {
            let (l, sh) = feret(pts, pixel: SIMD2(g.spacing.x, g.spacing.y))
            if l > bestLong { bestLong = l; bestShort = sh }
        }
        // Prefer the most specific candidate: sub-parts beat the whole pancreas.
        var host: Organ?
        if let best = hostVotes.filter({ $0.key != Organ.pancreas.rawValue }).max(by: { $0.value < $1.value }) {
            host = Organ(rawValue: best.key)
        } else if hostVotes[Organ.pancreas.rawValue] != nil {
            host = .pancreas
        }
        return LesionFinding(id: id, kind: kind, voxelCount: points.count,
                             volumeML: n * Double(g.spacing.x * g.spacing.y * g.spacing.z) / 1000,
                             meanHU: mean, stdHU: max(0, s2 / n - mean * mean).squareRoot(),
                             centroidVoxel: SIMD3<Float>(c / n), longAxisMM: bestLong,
                             shortAxisMM: bestShort, host: host)
    }

    /// Max caliper width over directions (Feret), plus the width perpendicular to it.
    /// Widths include one voxel footprint so a single voxel measures one pixel wide.
    static func feret(_ pts: [SIMD2<Float>], pixel: SIMD2<Float>) -> (Float, Float) {
        guard !pts.isEmpty else { return (0, 0) }
        func width(_ a: Float) -> Float {
            let d = SIMD2<Float>(cos(a), sin(a))
            var lo = Float.infinity, hi = -Float.infinity
            for p in pts { let t = simd_dot(p, d); lo = min(lo, t); hi = max(hi, t) }
            return hi - lo + simd_length(d * pixel)
        }
        var best: Float = 0, bestA: Float = 0
        var a: Float = 0
        while a < .pi { let w = width(a); if w > best { best = w; bestA = a }; a += .pi / 90 }
        return (best, width(bestA + .pi / 2))
    }

    // MARK: Impression (deterministic, reportFindings.ts vocabulary)

    static func findingSentence(_ l: LesionFinding, geometry: VolumeGeometry? = nil) -> String {
        let desc = sizeDescriptor(volumeCC: l.volumeML, maxDimCM: Double(l.longAxisMM) / 10)
        let size = String(format: "%.1f × %.1f cm", l.longAxisMM / 10, l.shortAxisMM / 10)
        let what = desc.isEmpty ? "lesion" : "\(desc) lesion"
        return "A \(what) in the \(l.locationText), measuring \(size) (axial), volume \(String(format: "%.1f", l.volumeML)) mL, mean \(Int(l.meanHU.rounded())) HU."
    }

    static func impression(_ r: CaseReport) -> [String] {
        var out: [String] = []
        if r.lesions.isEmpty {
            out.append("No lesion is segmented in this study.")
        } else {
            let byKind = Dictionary(grouping: r.lesions, by: \.kind)
            for kind in [Organ.pancreaticLesion, .liverLesion, .kidneyLesion, .colonLesion] {
                guard let ls = byKind[kind], let big = ls.first else { continue }
                let organ = organRoot(kind)
                let countText = ls.count == 1 ? "A \(organ) lesion" : "\(ls.count) \(organ) lesions"
                out.append("\(countText); the largest sits in the \(big.locationText) and measures "
                    + String(format: "%.1f cm", big.longAxisMM / 10) + " in longest axial diameter ("
                    + String(format: "%.1f mL", big.volumeML) + ").")
            }
        }
        let outliers = r.organs.compactMap { s -> String? in
            guard let p = s.percentile, p < 5 || p > 95 else { return nil }
            return "\(s.organ.displayName.lowercased()) volume at p\(Int(p.rounded()))"
        }
        if !outliers.isEmpty { out.append("Outside the population 5–95th percentile: " + outliers.joined(separator: ", ") + ".") }
        let clipped = r.organs.filter { $0.truncated && !$0.organ.isLesion }.map { $0.organ.displayName.lowercased() }
        if !clipped.isEmpty {
            out.append("Partially outside the scan range, volumes may be underestimated: " + clipped.joined(separator: ", ") + ".")
        }
        return out.enumerated().map { "\($0.offset + 1). \($0.element)" }
    }

    /// Organ table rows: same >5 cc filter as reportFindings.ts `splitOrgans`, lesions excluded.
    static func tableRows(_ r: CaseReport) -> [OrganStat] {
        r.organs.filter { !$0.organ.isLesion && $0.volumeML > 5 }
    }

    static func plainText(_ r: CaseReport, info: CaseInfo) -> String {
        var t = "LUMEN STRUCTURED REPORT\nCase: \(info.id)\n"
        if !info.metadata.isEmpty {
            t += info.metadata.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "  ") + "\n"
        }
        t += "\nFINDINGS\n"
        if r.lesions.isEmpty { t += "No segmented lesions.\n" }
        for (i, l) in r.lesions.enumerated() { t += "\(i + 1). \(l.kind.displayName): " + findingSentence(l) + "\n" }
        t += "\nORGANS (volume mL, mean HU ± SD)\n"
        for s in tableRows(r) {
            t += String(format: "%@: %.1f mL, %.0f ± %.0f HU", s.organ.displayName, s.volumeML, s.meanHU, s.stdHU)
            if let p = s.percentile { t += String(format: ", p%.0f", p) }
            if s.truncated { t += " (clipped)" }
            t += "\n"
        }
        t += "\nIMPRESSION\n" + impression(r).joined(separator: "\n") + "\n"
        t += "\nGenerated deterministically from the segmentation; not a diagnosis.\n"
        return t
    }
}
