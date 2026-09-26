// Generalizable app entry. Owned by agent shell.
// The demo opens straight into the head CT (CaseCatalog.heroID). Launch with
// `-openCase PanTS_00008205` to open another case, or `-openCase library` to start at the
// library (launch arguments land in UserDefaults' argument domain).
import SwiftUI

@main
struct GeneralizableApp: App {
    private let autoOpen: String? = {
        let arg = UserDefaults.standard.string(forKey: "openCase") ?? CaseCatalog.heroID
        return arg == "library" ? nil : arg
    }()

    @State private var pro: ProStore

    init() {
        ProStore.configureSDK()   // RevenueCat, public key from Info.plist (docs/REVENUECAT.md)
        _pro = State(initialValue: ProStore())
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        UINavigationBar.appearance().standardAppearance = nav
    }

    var body: some Scene {
        WindowGroup {
            LibraryView(autoOpenID: autoOpen)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .environment(pro)
                .task { pro.start(); await pro.refresh() }
        }
    }
}
