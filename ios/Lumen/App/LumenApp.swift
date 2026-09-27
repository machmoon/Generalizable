// Lumen app entry. Owned by agent shell.
// Launch with `-openCase PanTS_00008205` to skip the library and open a case directly
// (launch arguments land in UserDefaults' argument domain).
import SwiftUI

@main
struct LumenApp: App {
    private let autoOpen = UserDefaults.standard.string(forKey: "openCase")

    init() {
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        UINavigationBar.appearance().standardAppearance = nav
    }

    var body: some Scene {
        WindowGroup {
            LibraryView(autoOpenID: autoOpen)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
