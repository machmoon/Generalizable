// Case loading screen (download → decode). Owned by agent shell.
import SwiftUI

struct LoadingView: View {
    var info: CaseInfo
    var stage: String
    /// 0...1, or nil for indeterminate.
    var progress: Double?
    var error: String?
    var onCancel: () -> Void
    var onRetry: (() -> Void)? = nil

    @State private var spin = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            CaseThumbnail(url: info.thumbnailURL)
                .blur(radius: 40).opacity(0.35).ignoresSafeArea()
            LinearGradient(colors: [Theme.bg.opacity(0.2), Theme.bg], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: Theme.Space.xl) {
                Spacer()
                ring
                VStack(spacing: Theme.Space.s) {
                    Text(info.title).font(Theme.ui(20, .semibold)).foregroundStyle(Theme.text)
                        .multilineTextAlignment(.center)
                    Text(info.id).font(Theme.mono(12)).foregroundStyle(Theme.textSecondary)
                }
                if let error {
                    VStack(spacing: Theme.Space.m) {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(Theme.ui(13, .medium)).foregroundStyle(Theme.danger)
                            .multilineTextAlignment(.center).padding(.horizontal, Theme.Space.xl)
                        if let onRetry {
                            Button("Retry", action: onRetry).buttonStyle(.borderedProminent)
                        }
                    }
                } else {
                    Text(stage).font(Theme.ui(13, .medium)).foregroundStyle(Theme.textSecondary)
                        .contentTransition(.opacity)
                }
                Spacer()
                Button(action: onCancel) {
                    Text(error == nil ? "Cancel" : "Back")
                        .font(Theme.ui(15, .semibold)).foregroundStyle(Theme.text)
                        .frame(maxWidth: 220).frame(height: 44)
                        .background(Capsule().fill(Theme.surfaceHi))
                        .overlay(Capsule().strokeBorder(Theme.stroke))
                }
                .buttonStyle(.plain)
                .padding(.bottom, Theme.Space.l)
            }
        }
        .onAppear { spin = true }
    }

    private var ring: some View {
        ZStack {
            Circle().stroke(Theme.stroke, lineWidth: 6)
            if let p = progress {
                Circle().trim(from: 0, to: max(0.02, min(p, 1)))
                    .stroke(AngularGradient(colors: [Theme.accent.opacity(0.4), Theme.accent], center: .center),
                            style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.25), value: p)
                Text("\(Int((p * 100).rounded()))%")
                    .font(Theme.mono(22, .semibold)).foregroundStyle(Theme.text)
                    .contentTransition(.numericText())
            } else {
                Circle().trim(from: 0, to: 0.28)
                    .stroke(Theme.accent, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                    .rotationEffect(.degrees(spin ? 360 : 0))
                    .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: spin)
                Image(systemName: "lungs.fill").font(.system(size: 30)).foregroundStyle(Theme.accent)
            }
        }
        .frame(width: 120, height: 120)
    }
}

/// Loads a thumbnail from a local file URL off the main thread, or remotely via AsyncImage.
struct CaseThumbnail: View {
    var url: URL?
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let url, !url.isFileURL {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { placeholder }
            } else {
                placeholder
            }
        }
        .task(id: url) {
            guard let url, url.isFileURL else { return }
            image = await Task.detached(priority: .utility) { UIImage(contentsOfFile: url.path) }.value
        }
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(colors: [Theme.surfaceHi, Theme.surface], startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: "lungs").font(.system(size: 34, weight: .ultraLight))
                .foregroundStyle(Theme.textTertiary)
        }
    }
}
