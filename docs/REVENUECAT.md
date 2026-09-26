# Generalizable Pro (RevenueCat)

> Demo only · not a diagnosis · Pro unlocks viewer features only.
> Built on public open-source research CT data. Pro never gates findings, safety text, or anything that reads as medical advice.

## What Pro unlocks

| Feature | Free | Pro | Where |
|---|---|---|---|
| Window presets Soft Tissue, Brain, Subdural (case defaults) | yes | yes | `Views/ViewerToolbar.swift` |
| Window presets Abdomen, Liver, Lung, Bone | lock icon, opens paywall | yes | `WindowLevel.requiresPro` in `Store/ProPaywall.swift` |
| Structures panel **Peel** (layer-by-layer) | lock badge, opens paywall | yes | `Views/OrganListPanel.swift` |
| **Presenter** mode on the folded Duo (lid shows the cross-section + a finding card for the person across the table; controls stay on the base) | lock badge, opens paywall | yes | `Duo/DuoSupport.swift`, `PresenterToggle` |
| Free-drag window/level, all views, findings, report | yes | yes | |

"Import your own scan" is not gated because the app has no import feature.

**Duo-native paywall:** when the iPhone Duo is folded, the paywall opens in the flat base half while the lid keeps showing the cross-section (`ProStore.showsBasePaywall`, rendered in `DuoAdaptiveViewer.foldedLayout` at `split.second`). Flat or on a regular iPhone it is a sheet (`.proPaywallSheet()`). Folding or unfolding while it is open moves it between the two.

## Code map

- `ios/Generalizable/Store/ProStore.swift`: `@MainActor @Observable` store. It configures the SDK, listens to `customerInfoStream`, and provides `refresh()`, `restore()`, and `require()` (returns true if Pro, otherwise opens the paywall). Entitlement id `pro`.
- `ios/Generalizable/Store/ProPaywall.swift`: `RevenueCatUI.PaywallView(displayCloseButton: true)` plus the sheet/base hosts, lock badge, restore section, and presenter views.
- `ios/Generalizable/App/GeneralizableApp.swift`: `ProStore.configureSDK()` at launch; `.environment(pro)`.
- Restore purchases: the paywall's own restore button, and the **Generalizable Pro** section at the bottom of the Report panel.

## Dashboard setup (app.revenuecat.com)

1. Create a project and add an **App Store** app with bundle id `dev.patliu.generalizable`.
2. **Products:** add `gz_pro_monthly` ($4.99 / month) and `gz_pro_yearly` ($29.99 / year). In App Store Connect, put both in one subscription group, "Generalizable Pro".
3. **Entitlement:** create `pro` and attach both products.
4. **Offering:** create `default` (mark it current) with packages `$rc_monthly` → `gz_pro_monthly` and `$rc_annual` → `gz_pro_yearly`.
5. **Paywall:** on the `default` offering, create a paywall from a template (e.g. a two-package template). Title "Generalizable Pro". Add the footer line "Demo only · not a diagnosis · Pro unlocks viewer features only". The app also shows this line under the paywall.
6. **API key:** Project settings → API keys → copy the **public Apple SDK key** (`appl_…`).

## Where the key goes

`ios/project.yml` → target `Generalizable` → `settings.base.REVENUECAT_API_KEY` (currently the placeholder `appl_REPLACE_WITH_PUBLIC_KEY`). It reaches the app through the Info.plist key `RevenueCatAPIKey = $(REVENUECAT_API_KEY)`. Run `xcodegen generate` after changing it. You can also override it per build: `xcodebuild … REVENUECAT_API_KEY=appl_xxx`.

**Only ever use the public SDK key.** Never put a secret key (`sk_…`) in the app or the repo. When the placeholder is in place, the app still configures the SDK (so StoreKit testing works) and logs a warning.

## Testing

- **Force Pro for demos and screenshots:** launch with `-gzPro YES` (Xcode scheme → Run → Arguments, or `simctl launch … -gzPro YES`). This skips every gate and hides the lock badges.
- **StoreKit local testing:** `ios/Generalizable/Generalizable.storekit` holds both subscriptions. XcodeGen wires it into the `Generalizable` scheme (`scheme.storeKitConfiguration` in `project.yml`), so Run from Xcode uses it. Manage and expire transactions with Debug → StoreKit → Manage Transactions.
- **Full RevenueCat flow** (the paywall template and offerings come from the backend): set the real public key. Then use a sandbox Apple ID on device, or keep StoreKit config testing: open the `.storekit` file in Xcode, choose Editor → Save Public Certificate, and upload that certificate in the RevenueCat app settings so RevenueCat accepts locally signed receipts. Without a real key the PaywallView cannot load an offering and shows its error or fallback state. Use `-gzPro YES` for the demo in that case.
- **Restore:** Report panel → Generalizable Pro → Restore purchases, or the paywall's restore link.

## Devpost checklist ("Best RevenueCat creation")

- [ ] Real public `appl_` key set in `project.yml` (not committed if the repo is public: pass it with `REVENUECAT_API_KEY=` at build time instead).
- [ ] Entitlement `pro`, offering `default` with `$rc_monthly` / `$rc_annual`, both products attached.
- [ ] Paywall template published on the `default` offering.
- [ ] Demo video shows: a lock badge → tapping a Pro window preset → the paywall (sheet on flat), then fold the Duo → the paywall on the base half with the cross-section on the lid → purchase (sandbox/StoreKit) → the gate unlocks live through `customerInfoStream` → Restore purchases.
- [ ] Presenter mode shown on the folded Duo.
- [ ] Screenshots taken with `-gzPro YES` where a clean UI is needed.
- [ ] Write-up states: Demo only · not a diagnosis · Pro unlocks viewer features only · public research data.
