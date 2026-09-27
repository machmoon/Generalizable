// Structured report screen. Layout follows BodyMaps
// PanTS-Demo/src/components/ReportScreen/ReportScreen.tsx: flagged findings first, then the
// organ list (>5 cc filter from src/helpers/reportFindings.ts `splitOrgans`), then the
// Impression. Numbers come from Analysis/OrganStats.swift (port of
// flask-server/services/nifti_processor.py `calculate_metrics`); the impression is
// deterministic text, no LLM. Export: plain text + a PDF rendered with ImageRenderer.

import SwiftUI

@MainActor
private enum ReportCache {
    static var reports: [String: CaseReport] = [:]
}

struct ReportPanel: View {
    @Bindable var state: ViewerState
    @State private var report: CaseReport?
    @State private var pdfURL: URL?

    var body: some View {
        Group {
            if let report {
                content(report)
            } else if state.loaded.labels == nil {
                ContentUnavailableView("No segmentation", systemImage: "square.dashed",
                                       description: Text("This case has no label volume to report on."))
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Measuring organs…").font(.footnote).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: state.loaded.info.id) { await load() }
    }

    private func load() async {
        let id = state.loaded.info.id
        if let cached = ReportCache.reports[id] { report = cached; pdfURL = makePDF(cached); return }
        let loaded = state.loaded
        let r = await Task.detached(priority: .userInitiated) {
            Analysis.compute(loaded, norms: Analysis.loadBundledNorms())
        }.value
        ReportCache.reports[id] = r
        report = r
        pdfURL = makePDF(r)
    }

    // MARK: Layout

    @ViewBuilder private func content(_ r: CaseReport) -> some View {
        List {
            Section {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(state.loaded.info.title).font(.headline)
                        Text(metaLine).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    shareMenu(r)
                }
            }

            Section("Findings") {
                if r.lesions.isEmpty {
                    Label("No segmented lesions", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                }
                ForEach(r.lesions) { l in lesionRow(l) }
            }

            Section {
                ForEach(Analysis.tableRows(r)) { s in organRow(s) }
            } header: {
                HStack {
                    Text("Organs")
                    Spacer()
                    Text("Volume").frame(width: 72, alignment: .trailing)
                    Text("HU").frame(width: 64, alignment: .trailing)
                    if r.normsBasis != nil { Text("Pctl").frame(width: 40, alignment: .trailing) }
                }
            }

            Section("Impression") {
                ForEach(Analysis.impression(r), id: \.self) { line in
                    Text(line).font(.callout)
                }
                Text("Generated from the segmentation by fixed rules. Not a diagnosis.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
    }

    private var metaLine: String {
        let m = state.loaded.info.metadata
        var parts = [state.loaded.info.id]
        for k in ["sex", "age", "scanner"] { if let v = m[k], !v.isEmpty { parts.append(v) } }
        let g = state.geometry
        parts.append(String(format: "%d×%d×%d @ %.2f×%.2f×%.2f mm", g.dims.x, g.dims.y, g.dims.z,
                            g.spacing.x, g.spacing.y, g.spacing.z))
        return parts.joined(separator: " · ")
    }

    private func lesionRow(_ l: LesionFinding) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(l.kind.color).frame(width: 10, height: 10)
                Text(l.kind.displayName).font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    jump(to: l.centroidVoxel, organ: l.kind)
                } label: {
                    Label("Jump to", systemImage: "scope").font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
            }
            Text(Analysis.findingSentence(l)).font(.callout)
            HStack(spacing: 14) {
                metric("Long axis", String(format: "%.1f mm", l.longAxisMM))
                metric("Short axis", String(format: "%.1f mm", l.shortAxisMM))
                metric("Volume", String(format: "%.2f mL", l.volumeML))
                metric("HU", String(format: "%.0f ± %.0f", l.meanHU, l.stdHU))
            }
        }
        .padding(.vertical, 4)
    }

    private func metric(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            Text(v).font(.caption.monospacedDigit())
        }
    }

    private func organRow(_ s: OrganStat) -> some View {
        Button {
            jump(to: s.centroidVoxel, organ: s.organ)
        } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 3).fill(s.organ.color).frame(width: 12, height: 12)
                Text(s.organ.displayName).lineLimit(1)
                if s.truncated {
                    Image(systemName: "scissors").font(.caption2).foregroundStyle(.orange)
                        .accessibilityLabel("Clipped by scan range")
                }
                Spacer()
                Text(String(format: "%.1f mL", s.volumeML)).frame(width: 72, alignment: .trailing)
                Text(String(format: "%.0f", s.meanHU)).frame(width: 64, alignment: .trailing)
                if report?.normsBasis != nil {
                    Text(s.percentile.map { String(format: "p%.0f", $0) } ?? "—")
                        .frame(width: 40, alignment: .trailing)
                        .foregroundStyle((s.percentile ?? 50) < 5 || (s.percentile ?? 50) > 95 ? .orange : .secondary)
                }
            }
            .font(.callout.monospacedDigit())
            .foregroundStyle(.primary)
        }
        .listRowBackground(state.selectedOrgan == s.organ ? Color.accentColor.opacity(0.12) : nil)
    }

    private func jump(to voxel: SIMD3<Float>, organ: Organ) {
        state.cursor = state.geometry.clamp(voxel.rounded(.toNearestOrAwayFromZero))
        state.selectedOrgan = organ
        state.visibleOrgans.insert(organ)
    }

    // MARK: Export

    @ViewBuilder private func shareMenu(_ r: CaseReport) -> some View {
        let text = Analysis.plainText(r, info: state.loaded.info)
        Menu {
            ShareLink(item: text, subject: Text("Lumen report \(r.caseID)")) {
                Label("Share as Text", systemImage: "doc.plaintext")
            }
            if let pdfURL {
                ShareLink(item: pdfURL) { Label("Share as PDF", systemImage: "doc.richtext") }
            }
        } label: {
            Label("Share", systemImage: "square.and.arrow.up")
        }
    }

    private func makePDF(_ r: CaseReport) -> URL? {
        let info = state.loaded.info
        let page = ReportPrintView(report: r, info: info)
            .frame(width: 612).padding(0)
        let renderer = ImageRenderer(content: page)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("Lumen-Report-\(info.id).pdf")
        var ok = false
        renderer.render { size, draw in
            var box = CGRect(x: 0, y: 0, width: 612, height: max(792, size.height))
            guard let ctx = CGContext(url as CFURL, mediaBox: &box, nil) else { return }
            ctx.beginPDFPage(nil)
            ctx.translateBy(x: 0, y: box.height - size.height)
            draw(ctx)
            ctx.endPDFPage()
            ctx.closePDF()
            ok = true
        }
        return ok ? url : nil
    }
}

/// Print layout used for the PDF export (light, letter width).
private struct ReportPrintView: View {
    let report: CaseReport
    let info: CaseInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Structured CT Report").font(.title2.bold())
            Text(info.id).font(.subheadline).foregroundStyle(.gray)
            Divider()
            Text("FINDINGS").font(.caption.bold())
            if report.lesions.isEmpty { Text("No segmented lesions.") }
            ForEach(Array(report.lesions.enumerated()), id: \.offset) { i, l in
                Text("\(i + 1). \(l.kind.displayName): \(Analysis.findingSentence(l))").font(.callout)
            }
            Text("ORGANS").font(.caption.bold())
            ForEach(Analysis.tableRows(report)) { s in
                HStack {
                    Rectangle().fill(s.organ.color).frame(width: 10, height: 10)
                    Text(s.organ.displayName)
                    Spacer()
                    Text(String(format: "%.1f mL", s.volumeML)).frame(width: 90, alignment: .trailing)
                    Text(String(format: "%.0f ± %.0f HU", s.meanHU, s.stdHU)).frame(width: 110, alignment: .trailing)
                }
                .font(.caption.monospacedDigit())
            }
            Text("IMPRESSION").font(.caption.bold())
            ForEach(Analysis.impression(report), id: \.self) { Text($0).font(.callout) }
            Text("Generated from the segmentation by fixed rules. Not a diagnosis.")
                .font(.caption2).foregroundStyle(.gray)
        }
        .padding(40)
        .foregroundStyle(.black)
        .background(.white)
        .environment(\.colorScheme, .light)
    }
}
