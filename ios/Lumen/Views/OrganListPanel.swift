// Structure list: colour swatch, volume, visibility, tap to select + jump to centroid.
// Owned by agent shell. Plays the role of OHIF's segmentation side panel
// (extensions/cornerstone rightPanels: `cornerstone.segmentation` in modes/longitudinal/src/index.ts).
import SwiftUI

struct OrganCentroid: Sendable {
    var centroid: SIMD3<Float>
    var voxels: Int
}

/// Per-case organ centroids and voxel counts, computed once off the main thread.
@MainActor
enum OrganCentroids {
    private static var cache: [String: [Organ: OrganCentroid]] = [:]
    private static var inflight: [String: Task<[Organ: OrganCentroid], Never>] = [:]

    static func cached(_ id: String) -> [Organ: OrganCentroid]? { cache[id] }

    static func stats(for loaded: LoadedCase) async -> [Organ: OrganCentroid] {
        let id = loaded.info.id
        if let c = cache[id] { return c }
        if let t = inflight[id] { return await t.value }
        guard let labels = loaded.labels else { cache[id] = [:]; return [:] }
        let t = Task.detached(priority: .userInitiated) { compute(labels) }
        inflight[id] = t
        let r = await t.value
        cache[id] = r
        inflight[id] = nil
        return r
    }

    nonisolated private static func compute(_ labels: LabelVolume) -> [Organ: OrganCentroid] {
        let g = labels.geometry
        let nx = Int(g.dims.x), ny = Int(g.dims.y), nz = Int(g.dims.z)
        let chunks = max(1, min(nz, ProcessInfo.processInfo.activeProcessorCount * 2))
        // Per chunk: 256 × (count, sx, sy, sz)
        var partials = [[Double]](repeating: [], count: chunks)
        let lock = NSLock()
        labels.voxels.withUnsafeBufferPointer { buf in
            DispatchQueue.concurrentPerform(iterations: chunks) { c in
                let z0 = c * nz / chunks, z1 = (c + 1) * nz / chunks
                var acc = [Double](repeating: 0, count: 256 * 4)
                acc.withUnsafeMutableBufferPointer { a in
                    for z in z0..<z1 {
                        let zf = Double(z)
                        for y in 0..<ny {
                            let row = (z * ny + y) * nx
                            let yf = Double(y)
                            var x = 0
                            while x < nx {
                                let v = Int(buf[row + x])
                                if v != 0 {
                                    let o = v * 4
                                    a[o] += 1; a[o + 1] += Double(x); a[o + 2] += yf; a[o + 3] += zf
                                }
                                x += 1
                            }
                        }
                    }
                }
                lock.lock(); partials[c] = acc; lock.unlock()
            }
        }
        var out: [Organ: OrganCentroid] = [:]
        for organ in Organ.allCases {
            let o = Int(organ.rawValue) * 4
            var n = 0.0, sx = 0.0, sy = 0.0, sz = 0.0
            for p in partials where !p.isEmpty { n += p[o]; sx += p[o + 1]; sy += p[o + 2]; sz += p[o + 3] }
            if n > 0 {
                out[organ] = OrganCentroid(centroid: SIMD3<Float>(Float(sx / n), Float(sy / n), Float(sz / n)),
                                       voxels: Int(n))
            }
        }
        return out
    }
}

struct OrganListPanel: View {
    @Bindable var state: ViewerState
    @State private var stats: [Organ: OrganCentroid]?
    @Environment(\.dismiss) private var dismiss

    private var present: [Organ] { stats.map { Array($0.keys) } ?? [] }
    private var lesions: [Organ] { present.filter(\.isLesion).sorted { $0.displayName < $1.displayName } }
    private var organs: [Organ] { present.filter { !$0.isLesion }.sorted { $0.displayName < $1.displayName } }
    private var voxelML: Double {
        let s = state.geometry.spacing
        return Double(s.x * s.y * s.z) / 1000
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if stats == nil {
                VStack(spacing: Theme.Space.m) {
                    ProgressView()
                    Text("Measuring structures").font(Theme.ui(13)).foregroundStyle(Theme.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if present.isEmpty {
                Text("No segmentation for this case").font(Theme.ui(14))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        if !lesions.isEmpty {
                            sectionTitle("Findings", count: lesions.count, tint: Theme.danger)
                            ForEach(lesions) { row($0) }
                        }
                        sectionTitle("Organs", count: organs.count, tint: Theme.textTertiary)
                        ForEach(organs) { row($0) }
                    }
                    .padding(.horizontal, Theme.Space.m)
                    .padding(.bottom, Theme.Space.xl)
                }
                .scrollIndicators(.hidden)
            }
        }
        .task {
            if let c = OrganCentroids.cached(state.loaded.info.id) { stats = c; return }
            stats = await OrganCentroids.stats(for: state.loaded)
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Structures").font(Theme.ui(18, .bold)).foregroundStyle(Theme.text)
                Text("\(state.visibleOrgans.intersection(present).count) of \(present.count) visible")
                    .font(Theme.mono(11)).foregroundStyle(Theme.textTertiary)
            }
            Spacer()
            let allOn = !present.isEmpty && Set(present).isSubset(of: state.visibleOrgans)
            Button(allOn ? "Hide all" : "Show all") {
                withAnimation(.snappy) {
                    if allOn { state.visibleOrgans.subtract(present) } else { state.visibleOrgans.formUnion(present) }
                }
            }
            .font(Theme.ui(13, .semibold))
            .disabled(present.isEmpty)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 28, height: 28).background(Circle().fill(Theme.surfaceHi))
            }
            .buttonStyle(.plain)
            .padding(.leading, Theme.Space.s)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.top, Theme.Space.l)
        .padding(.bottom, Theme.Space.s)
    }

    private func sectionTitle(_ t: String, count: Int, tint: Color) -> some View {
        HStack(spacing: 6) {
            Text(t.uppercased()).font(Theme.ui(11, .bold)).tracking(0.8)
            Text("\(count)").font(Theme.mono(10.5))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, Theme.Space.s)
        .padding(.top, Theme.Space.m).padding(.bottom, Theme.Space.xs)
    }

    private func row(_ o: Organ) -> some View {
        let visible = state.visibleOrgans.contains(o)
        let selected = state.selectedOrgan == o
        let ml = Double(stats?[o]?.voxels ?? 0) * voxelML
        return HStack(spacing: Theme.Space.m) {
            Circle().fill(o.color)
                .frame(width: 12, height: 12)
                .shadow(color: o.color.opacity(0.7), radius: selected ? 5 : 0)
                .opacity(visible ? 1 : 0.3)
            VStack(alignment: .leading, spacing: 1) {
                Text(o.displayName).font(Theme.ui(14, selected ? .semibold : .medium))
                    .foregroundStyle(visible ? Theme.text : Theme.textTertiary)
                Text(ml >= 10 ? String(format: "%.0f mL", ml) : String(format: "%.1f mL", ml))
                    .font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary)
            }
            Spacer()
            if selected {
                Image(systemName: "scope").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.accent)
            }
            Button {
                withAnimation(.snappy(duration: 0.2)) {
                    if visible { state.visibleOrgans.remove(o) } else { state.visibleOrgans.insert(o) }
                }
            } label: {
                Image(systemName: visible ? "eye" : "eye.slash")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(visible ? Theme.textSecondary : Theme.textTertiary)
                    .frame(width: 36, height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, Theme.Space.m).padding(.trailing, Theme.Space.xs)
        .frame(minHeight: 48)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(selected ? Theme.accentSoft : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture { select(o) }
        .sensoryFeedback(.selection, trigger: selected)
    }

    private func select(_ o: Organ) {
        withAnimation(.snappy(duration: 0.25)) {
            if state.selectedOrgan == o { state.selectedOrgan = nil; return }
            state.selectedOrgan = o
            state.visibleOrgans.insert(o)
            state.showLabels = true
            if let c = stats?[o]?.centroid {
                state.cursor = state.geometry.clamp(c.rounded(.toNearestOrAwayFromZero))
            }
        }
    }
}
