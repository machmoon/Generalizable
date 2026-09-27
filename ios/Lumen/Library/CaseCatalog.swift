// CaseCatalog — the case library: bundled cases, on-device downloads, and the remote
// BodyMaps/iPanTSMini listing on HuggingFace.
//
// Prior art (BodyMaps web viewer, PanTS-Demo/src/helpers/):
// - curatedCache.ts: one module-level cache + one `inFlight` promise so repeated
//   callers join a single fetch, and "total failure doesn't poison the cache" (a failed
//   fetch keeps the previous list instead of replacing it with an empty one). Mirrored
//   here by `refreshTask` and by only overwriting the listing cache on success.
// - compareSources.ts `resolveSources`: local source first, HuggingFace
//   `resolve/main/{image_only,mask_only}/<id>/…?download=true` fallback. Mirrored by
//   the bundled → simulator scans/ → Application Support → HF resolution order.
//   Like that file, we never download CT volumes speculatively — only on ensureLocal.
// - search.ts `itemToId`: a case id is matched by its number ("PanTS_00008854" ↔ 8854),
//   so typing "8854", "08854" or the full id all hit. Ported in `CaseCatalog.filter`.
// - prefetchViewer.ts: reset the "started" flag on failure so a later call retries —
//   same for our per-id download tasks (removed from `inflight` on completion/failure).
//
// Remote listing: HF tree API, paginated via the RFC 5988 `Link: <…>; rel="next"`
// header (the same scheme huggingface_hub's `paginate` follows in
// huggingface_hub/utils/_pagination.py). Cached to Caches/Lumen/hf-listing.json.
// Resume: URLSession's NSURLSessionDownloadTaskResumeData from the failure error is
// kept on disk and reused on the next attempt.

import Foundation
import SwiftUI

@MainActor @Observable
final class CaseCatalog {
    static let shared = CaseCatalog()

    nonisolated static let heroID = "PanTS_00008205"
    nonisolated static let hfBase = "https://huggingface.co/datasets/BodyMaps/iPanTSMini"

    var cases: [CaseInfo] = []
    /// Download progress 0...1 keyed by case id while downloading.
    var downloads: [String: Double] = [:]
    /// Last download/listing error per case id (nil key "" = listing).
    var errors: [String: String] = [:]
    /// True while the remote listing is being fetched.
    var isRefreshing = false
    /// Remote listing timestamp (from cache or network).
    var listingDate: Date?

    private var refreshTask: Task<Void, Never>?
    private var inflight: [String: Task<CaseInfo, Error>] = [:]
    private var remoteIDs: [String] = []

    init() {
        // Synchronous first paint: bundled + local + cached listing, no network.
        if let cached = Self.loadCachedListing() {
            remoteIDs = cached.ids
            listingDate = cached.date
        }
        rebuild()
    }

    // MARK: Public API

    /// Rebuilds from disk and refreshes the remote listing (joins an in-flight refresh).
    func refresh() async {
        if let t = refreshTask { return await t.value }
        let t = Task { @MainActor in
            self.isRefreshing = true
            defer { self.isRefreshing = false; self.refreshTask = nil }
            self.rebuild()
            do {
                let ids = try await Self.fetchRemoteIDs()
                guard !ids.isEmpty else { return }
                self.remoteIDs = ids
                self.listingDate = Date()
                Self.saveCachedListing(ids)
                self.errors[""] = nil
            } catch {
                // Keep previous listing (curatedCache.ts: don't poison the cache).
                self.errors[""] = error.localizedDescription
            }
            self.rebuild()
        }
        refreshTask = t
        await t.value
    }

    /// Ensures ctURL/labelURL are local; returns the updated CaseInfo.
    func ensureLocal(_ c: CaseInfo) async throws -> CaseInfo {
        if let local = localInfo(for: c.id, base: c) { return local }
        if let t = inflight[c.id] { return try await t.value }
        let id = c.id
        let t = Task { @MainActor () throws -> CaseInfo in
            defer { self.inflight[id] = nil; self.downloads[id] = nil }
            self.downloads[id] = 0
            self.errors[id] = nil
            do {
                let dir = Self.downloadsDir.appendingPathComponent(id, isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                // Weights roughly match file sizes (CT ≫ labels ≫ thumbnail).
                let parts: [(remote: String, file: String, lo: Double, hi: Double, required: Bool)] = [
                    ("image_only/\(id)/ct.nii.gz", "ct.nii.gz", 0.0, 0.85, true),
                    ("mask_only/\(id)/combined_labels.nii.gz", "combined_labels.nii.gz", 0.85, 0.99, false),
                    ("profile_only/\(id)/profile.jpg", "profile.jpg", 0.99, 1.0, false),
                ]
                for p in parts {
                    let dest = dir.appendingPathComponent(p.file)
                    if FileManager.default.fileExists(atPath: dest.path) { continue }
                    do {
                        try await Self.download(Self.resolveURL(p.remote), to: dest) { f in
                            Task { @MainActor in
                                if self.downloads[id] != nil { self.downloads[id] = p.lo + (p.hi - p.lo) * f }
                            }
                        }
                    } catch {
                        if p.required { throw error }
                    }
                }
                self.downloads[id] = 1
                self.rebuild()
                guard let out = self.localInfo(for: id, base: c) else { throw CatalogError.missingAfterDownload }
                return out
            } catch {
                self.errors[id] = error.localizedDescription
                throw error
            }
        }
        inflight[id] = t
        return try await t.value
    }

    func isDownloading(_ id: String) -> Bool { inflight[id] != nil }

    /// Removes a downloaded (non-bundled) case from disk.
    func deleteLocal(_ id: String) {
        try? FileManager.default.removeItem(at: Self.downloadsDir.appendingPathComponent(id))
        rebuild()
    }

    // MARK: Search (port of PanTS-Demo/src/helpers/search.ts itemToId matching)

    /// Numeric part of a case id: "PanTS_00008854" → 8854, "8854" → 8854.
    nonisolated static func idNumber(_ s: String) -> Int? {
        guard let r = s.range(of: #"\d+"#, options: .regularExpression) else { return nil }
        return Int(s[r])
    }

    /// Canonical id for a typed number: 8854 → "PanTS_00008854" (search.ts caseIdToApiId).
    nonisolated static func canonicalID(_ n: Int) -> String {
        "PanTS_" + String(format: "%08d", n)
    }

    /// Filter by query: a number matches the id number exactly or as a prefix of its
    /// digits (so "82" finds 8205 while typing); text matches id/title/metadata.
    nonisolated static func filter(_ cases: [CaseInfo], query: String, localOnly: Bool = false) -> [CaseInfo] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = localOnly ? cases.filter { $0.ctURL != nil } : cases
        guard !q.isEmpty else { return base }
        let digitsOnly = q.allSatisfy(\.isNumber)
        if digitsOnly || q.lowercased().hasPrefix("pants"), let n = idNumber(q) {
            let qDigits = String(n)
            let exact = base.filter { idNumber($0.id) == n }
            let prefix = base.filter { c in
                guard let m = idNumber(c.id), m != n else { return false }
                return String(m).hasPrefix(qDigits)
            }
            return exact + prefix
        }
        let lq = q.lowercased()
        return base.filter { c in
            c.id.lowercased().contains(lq) || c.title.lowercased().contains(lq)
                || c.metadata.values.contains { $0.lowercased().contains(lq) }
        }
    }

    func filtered(_ query: String, localOnly: Bool = false) -> [CaseInfo] {
        Self.filter(cases, query: query, localOnly: localOnly)
    }

    // MARK: Building the list

    private func rebuild() {
        var out: [CaseInfo] = []
        var seen = Set<String>()

        // 1. Bundled (hero first).
        for c in Self.bundledCases() where seen.insert(c.id).inserted { out.append(c) }

        // 2. Simulator dev scans + downloaded cases.
        var localIDs = Set<String>()
        #if targetEnvironment(simulator)
        localIDs.formUnion(Self.listDirs(Self.devScansDir))
        #endif
        localIDs.formUnion(Self.listDirs(Self.downloadsDir))
        for id in localIDs.sorted(by: Self.idOrder) where !seen.contains(id) {
            if let c = localInfo(for: id, base: nil) { seen.insert(id); out.append(c) }
        }

        // 3. Remote.
        for id in remoteIDs where !seen.contains(id) {
            seen.insert(id)
            out.append(Self.remoteInfo(id))
        }
        cases = out
    }

    /// Local CaseInfo if the CT exists on device (bundled, sim scans, or downloaded).
    private func localInfo(for id: String, base: CaseInfo?) -> CaseInfo? {
        if let b = base, b.isBundled, let ct = b.ctURL, FileManager.default.fileExists(atPath: ct.path) {
            return b
        }
        var dirs: [URL] = []
        if let bundled = Self.bundledRoot?.appendingPathComponent(id) { dirs.append(bundled) }
        #if targetEnvironment(simulator)
        dirs.append(Self.devScansDir.appendingPathComponent(id))
        #endif
        dirs.append(Self.downloadsDir.appendingPathComponent(id))
        let fm = FileManager.default
        for d in dirs {
            let ct = d.appendingPathComponent("ct.nii.gz")
            guard fm.fileExists(atPath: ct.path) else { continue }
            let lab = d.appendingPathComponent("combined_labels.nii.gz")
            let thumb = d.appendingPathComponent("profile.jpg")
            var c = base ?? Self.remoteInfo(id)
            c.ctURL = ct
            c.labelURL = fm.fileExists(atPath: lab.path) ? lab : nil
            c.thumbnailURL = fm.fileExists(atPath: thumb.path) ? thumb : Self.remoteThumb(id)
            return c
        }
        return nil
    }

    // MARK: Bundled

    private struct BundledEntry: Decodable {
        var id: String
        var title: String?
        var dims: [Int]?
        var spacing: [Double]?
        var hasLabels: Bool?
        var organs: [String]?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try? c.decode(String.self, forKey: .title)
            dims = try? c.decode([Int].self, forKey: .dims)
            spacing = try? c.decode([Double].self, forKey: .spacing)
            hasLabels = try? c.decode(Bool.self, forKey: .hasLabels)
            // organs may be [String] or [Int] or a dict; accept the string form only.
            organs = try? c.decode([String].self, forKey: .organs)
        }
        enum CodingKeys: String, CodingKey { case id, title, dims, spacing, hasLabels, organs }
    }

    nonisolated static var bundledRoot: URL? {
        Bundle.main.url(forResource: "Cases", withExtension: nil)
    }

    private static func bundledCases() -> [CaseInfo] {
        guard let root = bundledRoot else { return [] }
        let fm = FileManager.default
        var entries: [BundledEntry] = []
        if let data = try? Data(contentsOf: root.appendingPathComponent("index.json")),
           let list = try? JSONDecoder().decode([BundledEntry].self, from: data) {
            entries = list
        } else {
            // No/invalid index.json: fall back to the folder listing.
            entries = listDirs(root).compactMap {
                try? JSONDecoder().decode(BundledEntry.self, from: Data(#"{"id":"\#($0)"}"#.utf8))
            }
        }
        var out: [CaseInfo] = []
        for e in entries {
            let dir = root.appendingPathComponent(e.id)
            let ct = dir.appendingPathComponent("ct.nii.gz")
            guard fm.fileExists(atPath: ct.path) else { continue }
            let lab = dir.appendingPathComponent("combined_labels.nii.gz")
            let thumb = dir.appendingPathComponent("profile.jpg")
            var md: [String: String] = ["source": "Bundled"]
            if let d = e.dims, d.count == 3 { md["dims"] = d.map(String.init).joined(separator: "×") }
            if let s = e.spacing, s.count == 3 {
                md["spacing"] = s.map { String(format: "%.2f", $0) }.joined(separator: "×") + " mm"
            }
            if let o = e.organs { md["organs"] = String(o.count) }
            out.append(CaseInfo(
                id: e.id,
                title: e.title ?? defaultTitle(e.id),
                ctURL: ct,
                labelURL: fm.fileExists(atPath: lab.path) ? lab : nil,
                thumbnailURL: fm.fileExists(atPath: thumb.path) ? thumb : remoteThumb(e.id),
                metadata: md,
                isBundled: true))
        }
        out.sort { a, b in
            if a.id == heroID { return b.id != heroID }
            if b.id == heroID { return false }
            return idOrder(a.id, b.id)
        }
        return out
    }

    // MARK: Remote

    private static func remoteInfo(_ id: String) -> CaseInfo {
        CaseInfo(id: id, title: defaultTitle(id), ctURL: nil, labelURL: nil,
                 thumbnailURL: remoteThumb(id), metadata: ["source": "BodyMaps iPanTSMini"])
    }

    nonisolated static func defaultTitle(_ id: String) -> String {
        if let n = idNumber(id) { return "PanTS \(n)" }
        return id
    }

    nonisolated static func resolveURL(_ path: String) -> URL {
        URL(string: "\(hfBase)/resolve/main/\(path)?download=true")!
    }

    nonisolated static func remoteThumb(_ id: String) -> URL {
        URL(string: "\(hfBase)/resolve/main/profile_only/\(id)/profile.jpg")!
    }

    /// Pages through the HF tree API following `Link: rel="next"`, with backoff on 429/5xx.
    nonisolated static func fetchRemoteIDs() async throws -> [String] {
        var next: URL? = URL(string:
            "https://huggingface.co/api/datasets/BodyMaps/iPanTSMini/tree/main/image_only?limit=1000")
        var ids: [String] = []
        var pages = 0
        while let url = next, pages < 50 {
            pages += 1
            let (data, resp) = try await fetchWithBackoff(url)
            struct Entry: Decodable { var type: String; var path: String }
            let entries = try JSONDecoder().decode([Entry].self, from: data)
            for e in entries where e.type == "directory" {
                let id = (e.path as NSString).lastPathComponent
                if id.hasPrefix("PanTS_") || id.hasPrefix("CV_") { ids.append(id) }
            }
            next = nextLink(resp)
        }
        return Array(Set(ids)).sorted(by: idOrder)
    }

    nonisolated private static func fetchWithBackoff(_ url: URL) async throws -> (Data, HTTPURLResponse) {
        var delay: Double = 1
        var lastError: Error = CatalogError.http(0)
        for _ in 0..<4 {
            var req = URLRequest(url: url)
            req.timeoutInterval = 20
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                guard let http = resp as? HTTPURLResponse else { throw CatalogError.http(0) }
                if http.statusCode == 200 { return (data, http) }
                lastError = CatalogError.http(http.statusCode)
                guard http.statusCode == 429 || http.statusCode >= 500 else { throw lastError }
                if let ra = http.value(forHTTPHeaderField: "Retry-After"), let s = Double(ra) {
                    delay = min(max(s, delay), 30)
                }
            } catch let e as CatalogError {
                if case .http(let code) = e, code != 0, code != 429, code < 500 { throw e }
                lastError = e
            } catch {
                lastError = error
            }
            try await Task.sleep(nanoseconds: UInt64((delay + Double.random(in: 0...0.5)) * 1e9))
            delay *= 2
        }
        throw lastError
    }

    /// Parses `Link: <url>; rel="next"`.
    nonisolated static func nextLink(_ resp: HTTPURLResponse) -> URL? {
        guard let link = resp.value(forHTTPHeaderField: "Link") else { return nil }
        for part in link.split(separator: ",") where part.contains("rel=\"next\"") {
            if let l = part.firstIndex(of: "<"), let r = part.firstIndex(of: ">"), l < r {
                return URL(string: String(part[part.index(after: l)..<r]))
            }
        }
        return nil
    }

    // MARK: Listing cache

    private struct CachedListing: Codable { var date: Date; var ids: [String] }

    nonisolated static var listingCacheURL: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lumen", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("hf-listing.json")
    }

    private static func loadCachedListing() -> CachedListing? {
        guard let d = try? Data(contentsOf: listingCacheURL) else { return nil }
        return try? JSONDecoder().decode(CachedListing.self, from: d)
    }

    private static func saveCachedListing(_ ids: [String]) {
        if let d = try? JSONEncoder().encode(CachedListing(date: Date(), ids: ids)) {
            try? d.write(to: listingCacheURL, options: .atomic)
        }
    }

    // MARK: Disk locations

    nonisolated static var downloadsDir: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Cases", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    nonisolated static let devScansDir = URL(fileURLWithPath: "/Users/patliu/BodyMaps-website/scans", isDirectory: true)

    nonisolated static func listDirs(_ root: URL) -> [String] {
        let items = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return items.filter { name in
            var isDir: ObjCBool = false
            return !name.hasPrefix(".")
                && FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path, isDirectory: &isDir)
                && isDir.boolValue
        }
    }

    nonisolated static func idOrder(_ a: String, _ b: String) -> Bool {
        switch (idNumber(a), idNumber(b)) {
        case let (x?, y?) where x != y: return x < y
        default: return a < b
        }
    }

    // MARK: Download (URLSessionDownloadTask + KVO progress + resume data)

    nonisolated private static func resumeDataURL(for dest: URL) -> URL {
        dest.appendingPathExtension("resume")
    }

    nonisolated private static func download(_ url: URL, to dest: URL,
                                             progress: @escaping (Double) -> Void) async throws {
        let resumeURL = resumeDataURL(for: dest)
        let resumeData = try? Data(contentsOf: resumeURL)
        var attempt = 0
        var useResume = resumeData
        while true {
            attempt += 1
            do {
                try await downloadOnce(url, resumeData: useResume, to: dest, progress: progress)
                try? FileManager.default.removeItem(at: resumeURL)
                return
            } catch let e as NSError {
                if let rd = e.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
                    try? rd.write(to: resumeURL, options: .atomic)
                    useResume = rd
                } else if useResume != nil {
                    // Stale resume data — start clean next time.
                    try? FileManager.default.removeItem(at: resumeURL)
                    useResume = nil
                }
                let retriable: Bool = {
                    if case CatalogError.http(let c)? = (e as Error) as? CatalogError { return c == 429 || c >= 500 }
                    return e.domain == NSURLErrorDomain && e.code != NSURLErrorCancelled
                }()
                if Task.isCancelled || !retriable || attempt >= 4 { throw e }
                try await Task.sleep(nanoseconds: UInt64(pow(2.0, Double(attempt)) * 1e9))
            }
        }
    }

    nonisolated private static func downloadOnce(_ url: URL, resumeData: Data?, to dest: URL,
                                                 progress: @escaping (Double) -> Void) async throws {
        final class Box: @unchecked Sendable {
            var task: URLSessionDownloadTask?
            var observation: NSKeyValueObservation?
        }
        let box = Box()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let handler: @Sendable (URL?, URLResponse?, Error?) -> Void = { tmp, resp, err in
                    box.observation?.invalidate()
                    if let err { return cont.resume(throwing: err) }
                    guard let http = resp as? HTTPURLResponse, let tmp else {
                        return cont.resume(throwing: CatalogError.http(0))
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        return cont.resume(throwing: CatalogError.http(http.statusCode))
                    }
                    do {
                        let fm = FileManager.default
                        try? fm.removeItem(at: dest)
                        try fm.moveItem(at: tmp, to: dest)
                        cont.resume()
                    } catch { cont.resume(throwing: error) }
                }
                let task: URLSessionDownloadTask
                if let resumeData {
                    task = URLSession.shared.downloadTask(withResumeData: resumeData, completionHandler: handler)
                } else {
                    task = URLSession.shared.downloadTask(with: url, completionHandler: handler)
                }
                box.task = task
                box.observation = task.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
                    progress(min(max(p.fractionCompleted, 0), 1))
                }
                task.resume()
            }
        } onCancel: {
            box.task?.cancel(byProducingResumeData: { rd in
                if let rd { try? rd.write(to: resumeDataURL(for: dest), options: .atomic) }
            })
        }
    }
}

enum CatalogError: LocalizedError {
    case http(Int)
    case missingAfterDownload
    var errorDescription: String? {
        switch self {
        case .http(429): "HuggingFace is rate-limiting requests. Try again in a minute."
        case .http(let c): c == 0 ? "Network error." : "Server returned HTTP \(c)."
        case .missingAfterDownload: "Download finished but the CT file is missing."
        }
    }
}

extension CaseInfo {
    /// CT volume is on device (bundled, simulator dev scan, or downloaded).
    var isOnDevice: Bool { ctURL?.isFileURL == true }
}
