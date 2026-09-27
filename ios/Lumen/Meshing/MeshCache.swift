// In-memory cache of extracted organ meshes, keyed by case id, so leaving and
// re-entering the 3D pane (or switching layouts) is instant.

import Foundation
import simd

final class MeshCache: @unchecked Sendable {
    static let shared = MeshCache()

    struct Entry {
        var meshes: [Organ: OrganMesh] = [:]
        var boxes: [UInt8: LabelBox]? = nil
        var complete = false
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func entry(_ caseID: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return entries[caseID]
    }
    func setBoxes(_ boxes: [UInt8: LabelBox], for caseID: String) {
        lock.lock(); defer { lock.unlock() }
        entries[caseID, default: Entry()].boxes = boxes
    }
    func add(_ mesh: OrganMesh, for caseID: String) {
        lock.lock(); defer { lock.unlock() }
        entries[caseID, default: Entry()].meshes[mesh.organ] = mesh
    }
    func markComplete(_ caseID: String) {
        lock.lock(); defer { lock.unlock() }
        entries[caseID, default: Entry()].complete = true
    }
    func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
    }

    /// Streams meshes for every label present, one background task per organ, yielding
    /// each as it finishes. Cached meshes are yielded first and not recomputed.
    func meshes(for loaded: LoadedCase) -> AsyncStream<OrganMesh> {
        let id = loaded.info.id
        return AsyncStream { cont in
            let task = Task.detached(priority: .userInitiated) {
                guard let labels = loaded.labels else { cont.finish(); return }
                let cached = self.entry(id)
                for m in cached?.meshes.values.map({ $0 }) ?? [] { cont.yield(m) }
                if cached?.complete == true { cont.finish(); return }
                let boxes: [UInt8: LabelBox]
                if let b = cached?.boxes { boxes = b } else {
                    boxes = SurfaceNets.boundingBoxes(labels)
                    self.setBoxes(boxes, for: id)
                }
                let done = Set(cached?.meshes.keys.map { $0 } ?? [])
                // Small structures first so something appears immediately; lesions first of all.
                let todo = boxes.compactMap { (k, b) -> (Organ, LabelBox)? in
                    guard let o = Organ(rawValue: k), !done.contains(o) else { return nil }
                    return (o, b)
                }.sorted { a, b in
                    if a.0.isLesion != b.0.isLesion { return a.0.isLesion }
                    return a.1.voxelCount < b.1.voxelCount
                }
                await withTaskGroup(of: OrganMesh?.self) { group in
                    for (organ, box) in todo {
                        group.addTask(priority: .userInitiated) {
                            if Task.isCancelled { return nil }
                            return SurfaceNets.extract(labels, organ: organ, box: box)
                        }
                    }
                    for await m in group {
                        guard let m else { continue }
                        self.add(m, for: id)
                        cont.yield(m)
                    }
                }
                if !Task.isCancelled { self.markComplete(id) }
                cont.finish()
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    /// Centre of the union of all label boxes, in scene space (camera orbit target).
    static func focus(of boxes: [UInt8: LabelBox], _ g: VolumeGeometry) -> SIMD3<Float> {
        guard !boxes.isEmpty else { return .zero }
        var lo = SIMD3<Int32>(repeating: .max), hi = SIMD3<Int32>(repeating: .min)
        for b in boxes.values { lo = pointwiseMin(lo, b.lo); hi = pointwiseMax(hi, b.hi) }
        return SurfaceNets.sceneFromVoxel((SIMD3<Float>(lo) + SIMD3<Float>(hi)) / 2, g)
    }
}
