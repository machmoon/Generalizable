// Generalizable Pro (RevenueCat). Owned by cc-revenuecat.
// Demo only · not a diagnosis · Pro unlocks viewer features only (extra CT windows, layer peel,
// presenter mode). It never gates findings, safety text, or anything that reads as medical advice.
//
// Launch with `-gzPro YES` (UserDefaults argument domain) to force Pro on for demos/screenshots.
import Foundation
import Observation
import OSLog
import RevenueCat

@MainActor @Observable
final class ProStore {
    static let entitlementID = "pro"
    static let placeholderKey = "appl_REPLACE_WITH_PUBLIC_KEY"
    private static let log = Logger(subsystem: "dev.patliu.generalizable", category: "ProStore")

    /// Entitlement state from RevenueCat, or forced on by `-gzPro YES`.
    private(set) var isPro: Bool
    /// Someone tapped a Pro control. The folded Duo shows the paywall on the base half;
    /// otherwise it is a sheet (see ProPaywall.swift).
    var showsPaywall = false
    /// The Duo is folded, so the paywall goes on the base half instead of a sheet.
    var foldedBaseAvailable = false
    /// Pro presenter mode: the lid shows a clean cross-section + finding card for the person
    /// across the table while the base keeps the controls.
    var presenterMode = false

    private let forced: Bool
    private var listener: Task<Void, Never>?

    var showsSheetPaywall: Bool { showsPaywall && !isPro && !foldedBaseAvailable }
    var showsBasePaywall: Bool { showsPaywall && !isPro && foldedBaseAvailable }

    init() {
        forced = UserDefaults.standard.bool(forKey: "gzPro")
        isPro = forced
    }

    /// Call once at launch. The key is the PUBLIC Apple SDK key from Info.plist (`RevenueCatAPIKey`,
    /// fed by the `REVENUECAT_API_KEY` build setting). Never a secret key.
    static func configureSDK() {
        let key = (Bundle.main.object(forInfoDictionaryKey: "RevenueCatAPIKey") as? String) ?? placeholderKey
        if key.isEmpty || key == placeholderKey || key.hasPrefix("$(") {
            log.warning("RevenueCat API key is the placeholder; set REVENUECAT_API_KEY (see docs/REVENUECAT.md). Configuring anyway for StoreKit testing.")
        }
        Purchases.logLevel = .warn
        Purchases.configure(withAPIKey: key.isEmpty || key.hasPrefix("$(") ? placeholderKey : key)
    }

    /// Start listening for entitlement changes (purchases, restores, renewals, expiry).
    func start() {
        guard listener == nil, Purchases.isConfigured else { return }
        listener = Task { [weak self] in
            for await info in Purchases.shared.customerInfoStream {
                self?.apply(info)
            }
        }
    }

    func refresh() async {
        guard Purchases.isConfigured else { return }
        do { apply(try await Purchases.shared.customerInfo()) } catch {
            Self.log.warning("customerInfo failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func restore() async {
        guard Purchases.isConfigured else { return }
        do { apply(try await Purchases.shared.restorePurchases()) } catch {
            Self.log.warning("restorePurchases failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func apply(_ info: CustomerInfo) {
        isPro = forced || info.entitlements[Self.entitlementID]?.isActive == true
        if isPro { showsPaywall = false } else { presenterMode = false }
    }

    /// Gate for a Pro control: true if the user may use it; otherwise opens the paywall.
    @discardableResult
    func require() -> Bool {
        if isPro { return true }
        showsPaywall = true
        return false
    }

    func dismissPaywall() { showsPaywall = false }
}
