// Generalizable Pro UI pieces. Owned by cc-revenuecat. Shared views only call into these so
// their own diffs stay one-liners: a lock badge, a paywall slot, a restore row.
import RevenueCat
import RevenueCatUI
import SwiftUI

/// RevenueCat paywall (remote template from the dashboard's `default` offering) wired to the store.
struct ProPaywall: View {
    @Environment(ProStore.self) private var store

    var body: some View {
        PaywallView(displayCloseButton: true)
            .onPurchaseCompleted { info in store.apply(info) }
            .onRestoreCompleted { info in store.apply(info) }
            .onRequestedDismissal { store.dismissPaywall() }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Text("Demo only · not a diagnosis · Pro unlocks viewer features only")
                    .font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                    .background(.bar)
            }
    }
}

/// Duo-native: the paywall sits in the flat base half while the lid keeps the cross-section.
struct ProBasePaywall: View {
    var body: some View {
        ProPaywall()
            .background(Theme.bg)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

extension View {
    /// Presents the paywall as a sheet when a Pro control was tapped and the Duo is not folded
    /// (folded: the base half shows it instead). `enabled` lets a host step aside while one of
    /// its own sheets is up, so only one presenter is ever bound at a time.
    func proPaywallSheet(enabled: Bool = true) -> some View {
        modifier(ProPaywallSheet(enabled: enabled))
    }
}

private struct ProPaywallSheet: ViewModifier {
    var enabled: Bool
    @Environment(ProStore.self) private var store

    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(
            get: { enabled && store.showsSheetPaywall },
            set: { if !$0 { store.dismissPaywall() } }
        )) {
            ProPaywall()
        }
    }
}

/// Small lock shown on Pro controls while not subscribed, so the upsell is visible before tapping.
struct ProLockBadge: View {
    @Environment(ProStore.self) private var store
    var body: some View {
        if !store.isPro {
            Image(systemName: "lock.fill")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Theme.accent)
                .accessibilityLabel("Pro")
        }
    }
}

extension WindowLevel {
    /// Soft tissue, brain and subdural (the case defaults) stay free; the rest are Pro.
    var requiresPro: Bool { ![WindowLevel.softTissue, .brain, .subdural].contains(self) }
}

/// "Generalizable Pro" row for a settings-like list (ReportPanel footer): status + restore.
struct ProAccountSection: View {
    @Environment(ProStore.self) private var store
    @State private var restoring = false

    var body: some View {
        Section {
            HStack {
                Label(store.isPro ? "Generalizable Pro active" : "Generalizable Pro",
                      systemImage: store.isPro ? "checkmark.seal.fill" : "lock.fill")
                Spacer()
                if !store.isPro {
                    Button("Upgrade") { store.require() }.font(.callout.weight(.semibold))
                }
            }
            Button {
                restoring = true
                Task { await store.restore(); restoring = false }
            } label: {
                HStack {
                    Text("Restore purchases")
                    if restoring { Spacer(); ProgressView() }
                }
            }
            .disabled(restoring)
        } footer: {
            Text("Pro unlocks viewer features only (extra CT windows, layer peel, presenter mode). Demo only · not a diagnosis.")
        }
    }
}

// MARK: - Presenter mode (folded Duo)

/// Pro toggle on the base half: when on, the lid faces the other person with a clean view.
struct PresenterToggle: View {
    @Environment(ProStore.self) private var store

    var body: some View {
        Button {
            guard store.require() else { return }
            withAnimation(.snappy) { store.presenterMode.toggle() }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: store.presenterMode ? "person.2.fill" : "person.2")
                    .font(.system(size: 11, weight: .semibold))
                Text("Presenter").font(.system(size: 11, weight: .semibold))
                ProLockBadge()
            }
            .foregroundStyle(store.presenterMode ? Theme.accent : .white.opacity(0.9))
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(Capsule().fill(.black.opacity(0.6)))
        }
        .buttonStyle(.plain)
    }
}

/// Presenter lid overlay: a plain finding card for the person across the table, over the
/// cross-section (the base's operator hints are hidden while presenting).
struct PresenterLidCard: View {
    var title: String
    var finding: CaseFinding?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(finding?.title ?? "Cross-section").font(.headline)
            Text(title).font(.caption).foregroundStyle(.secondary)
            if let e = finding?.explanation {
                Text(e).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            Text("Demo only · not a diagnosis").font(.caption2).foregroundStyle(.tertiary)
        }
        .foregroundStyle(.white)
        .padding(12)
        .frame(maxWidth: 420, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(12)
        .allowsHitTesting(false)
    }
}
