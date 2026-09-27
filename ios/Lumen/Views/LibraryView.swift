// Case library (OHIF's "study list" / work list equivalent). Owned by agent shell.
// Tapping a case: CaseCatalog.ensureLocal → VolumeLoader.load (LoadingView) → ViewerView.
import SwiftUI

/// One open-case attempt: download, decode, then hand a ViewerState to the viewer.
@MainActor @Observable
final class CaseSession: Identifiable {
    enum Stage { case downloading, decoding, preparing, ready, failed }
    let id = UUID()
    private(set) var info: CaseInfo
    var stage: Stage = .downloading
    var decodeProgress: Double = 0
    var error: String?
    var viewer: ViewerState?
    private var task: Task<Void, Never>?

    init(info: CaseInfo) { self.info = info }

    func start() {
        task?.cancel()
        error = nil
        stage = .downloading
        decodeProgress = 0
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let local = try await CaseCatalog.shared.ensureLocal(info)
                try Task.checkCancellation()
                info = local
                stage = .decoding
                let loaded = try await VolumeLoader.load(local) { p in
                    Task { @MainActor [weak self] in self?.decodeProgress = p }
                }
                try Task.checkCancellation()
                stage = .preparing
                await Task.yield()
                viewer = ViewerState(loaded: loaded)
                stage = .ready
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
                stage = .failed
            }
        }
    }

    func cancel() { task?.cancel() }

    var stageText: String {
        switch stage {
        case .downloading: "Downloading scan"
        case .decoding: "Decoding volume"
        case .preparing: "Preparing viewer"
        case .ready: "Ready"
        case .failed: "Failed"
        }
    }

    var progress: Double? {
        switch stage {
        case .downloading: CaseCatalog.shared.downloads[info.id]
        case .decoding: decodeProgress > 0 ? decodeProgress : nil
        default: nil
        }
    }
}

struct LibraryView: View {
    var autoOpenID: String? = nil

    @State private var session: CaseSession?
    @State private var loaded = false
    @State private var didAutoOpen = false
    @State private var query = ""

    private var catalog: CaseCatalog { CaseCatalog.shared }

    private var filtered: [CaseInfo] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return catalog.cases }
        return catalog.cases.filter {
            $0.id.lowercased().contains(q) || $0.title.lowercased().contains(q)
                || $0.metadata.values.contains { $0.lowercased().contains(q) }
        }
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.l) {
                    header
                    searchField
                    content
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.bottom, Theme.Space.xxl)
            }
            .scrollIndicators(.hidden)
            .refreshable { await catalog.refresh() }
        }
        .task {
            await catalog.refresh()
            loaded = true
            autoOpenIfNeeded()
        }
        .fullScreenCover(item: $session) { s in
            CaseSessionView(session: s) { session = nil }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "circle.hexagongrid.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(LinearGradient(colors: [Theme.accent, Theme.volumeColor],
                                                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    Text("Lumen").font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.text)
                }
                Text("Abdominal CT · AI organ segmentation")
                    .font(Theme.ui(13, .medium)).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Text("\(catalog.cases.count)")
                .font(Theme.mono(13, .semibold)).foregroundStyle(Theme.textSecondary)
                + Text(" cases").font(Theme.ui(13)).foregroundStyle(Theme.textTertiary)
        }
        .padding(.top, Theme.Space.l)
    }

    private var searchField: some View {
        HStack(spacing: Theme.Space.s) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.textTertiary)
            TextField("Search cases", text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(Theme.ui(15))
        }
        .padding(.horizontal, Theme.Space.m).frame(height: 40)
        .lumenCard(radius: Theme.Radius.control + 3)
    }

    @ViewBuilder private var content: some View {
        if catalog.cases.isEmpty {
            VStack(spacing: Theme.Space.m) {
                if loaded {
                    Image(systemName: "tray").font(.system(size: 34, weight: .light))
                    Text("No cases available").font(Theme.ui(15, .medium))
                    Text("Pull to refresh").font(Theme.ui(12)).foregroundStyle(Theme.textTertiary)
                } else {
                    ProgressView().controlSize(.large)
                    Text("Loading catalog").font(Theme.ui(13))
                }
            }
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity).padding(.top, 120)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 158, maximum: 260), spacing: Theme.Space.m)],
                      spacing: Theme.Space.m) {
                ForEach(filtered) { c in
                    Button { open(c) } label: {
                        CaseCard(info: c, download: catalog.downloads[c.id])
                    }
                    .buttonStyle(PressableCardStyle())
                }
            }
        }
    }

    private func open(_ c: CaseInfo) {
        let s = CaseSession(info: c)
        session = s
        s.start()
    }

    private func autoOpenIfNeeded() {
        guard !didAutoOpen, let id = autoOpenID else { return }
        didAutoOpen = true
        if let c = catalog.cases.first(where: { $0.id == id || $0.id.hasSuffix(id) }) { open(c) }
    }
}

private struct PressableCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

private struct CaseCard: View {
    var info: CaseInfo
    var download: Double?

    private var chips: [String] {
        let preferred = ["sex", "age", "scanner", "phase", "manufacturer", "diagnosis"]
        var out: [String] = []
        for k in preferred { if let v = info.metadata[k], !v.isEmpty { out.append(k == "age" ? "\(v) y" : v) } }
        if out.isEmpty { out = info.metadata.keys.sorted().prefix(3).compactMap { info.metadata[$0] } }
        return Array(out.prefix(3))
    }

    private var isLocal: Bool { info.isBundled || info.ctURL?.isFileURL == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                CaseThumbnail(url: info.thumbnailURL)
                    .frame(height: 150).frame(maxWidth: .infinity)
                    .clipped()
                    .overlay(LinearGradient(colors: [.clear, Theme.surface.opacity(0.9)],
                                            startPoint: .center, endPoint: .bottom))
                Image(systemName: isLocal ? "checkmark.circle.fill" : "icloud.and.arrow.down")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isLocal ? Theme.success : Theme.textSecondary)
                    .padding(6).background(Circle().fill(.ultraThinMaterial))
                    .padding(8)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(info.title).font(Theme.ui(14, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(info.id).font(Theme.mono(10.5)).foregroundStyle(Theme.textTertiary).lineLimit(1)
                if !chips.isEmpty {
                    HStack(spacing: 4) { ForEach(chips, id: \.self) { LumenChip(text: $0) } }
                        .lineLimit(1)
                }
                if let d = download {
                    HStack(spacing: 6) {
                        ProgressView(value: d).tint(Theme.accent)
                        Text("\(Int(d * 100))%").font(Theme.mono(10)).foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            .padding(Theme.Space.m)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .lumenCard()
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
    }
}

/// Full-screen cover content: loading → viewer.
private struct CaseSessionView: View {
    @Bindable var session: CaseSession
    var close: () -> Void

    var body: some View {
        ZStack {
            if let v = session.viewer {
                ViewerView(state: v).transition(.opacity)
            } else {
                LoadingView(info: session.info, stage: session.stageText, progress: session.progress,
                            error: session.error,
                            onCancel: { session.cancel(); close() },
                            onRetry: { session.start() })
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: session.viewer != nil)
    }
}
