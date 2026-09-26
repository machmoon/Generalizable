# RevenueCat for Generalizable: a fold-triggered paywall

> **Demo only.** Public research data. Not a diagnosis. Pro unlocks viewer features only. Nothing here sells medical advice.

This guide adds RevenueCat to the Duo app for the **Best RevenueCat creation** track. It's based on what RevenueCat's own judges have rewarded (§1), then applied to our product (§2–3), with code written against the app as it is today (`FoldScanView`, `FoldScanSession`, `onHingeChange`, `ArrangementView`).

---

## 1. What RevenueCat judges reward (research)

From RevenueCat's **Shipaton 2025** winners and its official **Shipaton prep codelab**:

| Signal | Evidence | What we take from it |
|---|---|---|
| **Monetization that fits the product** | The HAMM ("Help Apps Make Money") award looks for "a well-crafted paywall, thoughtful pricing and packaging, strong conversion, and monetization that genuinely fits the product". Entrants are asked to explain the business model, pricing, paywall and conversion. | Have a written business model. The paywall should feel like part of the Duo experience, not an add-on. |
| **Mission-aligned pricing** | HAMM winner **Vector Guard**: each $2.99 subscription funds 50 free accounts in high-risk ZIP codes. | Patients never pay. Clinicians and educators do, and each Pro seat can fund free student access. |
| **Hybrid models** | HAMM #2, **Napkinmatic**, mixed subscriptions with consumable credits. | Pro subscription, plus optional credits for AI slice descriptions (the app already has a Hugging Face analysis path, PRD A11). |
| **Personalized paywall copy** | Design Award #2, **SkillMe**, adapted the paywall copy to each user's goal. | Use RevenueCat **custom paywall variables** to put the current case and finding into the copy. |
| **Show the money moment** | Codelab: judges want to see "the paywall or purchase" working, and a "clear monetization model from day one, not bolted on at the end". | The demo video must show a purchase on the Duo. |
| **When the paywall appears matters more than its design** | RevenueCat's contextual-paywall research: top apps reach 4.6% download-to-paid against a 1.9% median. Wizz saw an 81% lift after cutting paywall prompts by about 50% and showing them only at high-intent moments. | Trigger the paywall from a **physical** high-intent moment, the fold into tabletop pose, and show it at most once per session. |
| **Test Store first** | Codelab: "use the RevenueCat Test Store… no store setup and… instant, deterministic results." | Use a `test_` key in DEBUG builds, so the purchase works on stage without App Store Connect. |

## 2. Our business model

**Who pays:** clinicians, educators and presenters who explain scans to someone else. **Patients never pay**; they're on the other side of the fold.

| Tier | Price (suggested) | What's included |
|---|---|---|
| **Free** | $0 | Bundled demo cases, fold-to-scrub (A12) and fold-to-tilt (A2), soft-tissue window |
| **Pro** (entitlement `pro`) | **$6.99/mo** or **$39.99/yr** (7-day trial on annual) | **Tabletop presenter mode**, **open your own CT scans** (NIfTI import), lung and bone windows plus layer peel, export annotated slices |
| **Explain credits** (consumable) | 10 for $2.99 | AI slice descriptions using the existing blind-prompted Hugging Face analysis (A11), for users who don't want a subscription |
| **Pay it forward** | Included with Pro | Each Pro subscription unlocks a free Pro seat for a student or teaching program, following Vector Guard's mission-aligned pricing |

We didn't pick lifetime pricing: new cases and data pipelines are ongoing work.

## 3. The Duo-native paywall: fold to present

**The moment:** a clinician is in the viewer, then folds the phone into **tabletop pose** to show the patient. That fold is the strongest intent signal the app gets: the user has decided to present.

1. `onHingeChange` reports `.partiallyOpen` and holds for about 0.8 s, so it isn't mid-motion.
2. If the user isn't Pro, fetch the offering for placement **`tabletop_present`**.
3. Show `PaywallView` on the **base** (lower) screen. The **lid keeps rendering the live scan**, so the value is right there while they decide.
4. Personalize the copy with custom variables, for example: "Present **Lung CT** to your patient, hands free."
5. Show it **once per session**. Other entry points each get their own placement: `import_scan`, `window_presets` and `export`.

That's something a regular iPhone can't do. The product stays visible on one screen while the other screen sells it, and the sale is triggered by folding the device.

## 4. Dashboard setup (about 10 minutes)

1. **Project → App.** Add an Apple App Store app with the bundle ID from `Project.json`. For the hackathon, also create the **Test Store** app and copy its `test_…` key.
2. **Products:** `gz_pro_monthly`, `gz_pro_annual` (with a 7-day intro trial) and `gz_explain_10` (consumable).
3. **Entitlement:** `pro`, attached to the two subscriptions.
4. **Offerings:**
   - `default`, containing `$rc_monthly` and `$rc_annual`;
   - `present`, with the same packages and presenter-focused paywall copy;
   - `credits`, containing `gz_explain_10`.
5. **Placements (Targeting):**
   - `tabletop_present` shows the `present` offering;
   - `import_scan`, `window_presets` and `export` show `default`;
   - `explain` shows `credits`.
6. **Paywalls V2:** attach a template to each offering. Use `{{ custom.case_name }}` and `{{ custom.finding }}` in the headline.
7. **Experiments (after launch):** A/B test paywall copy and trial length on `tabletop_present`.

## 5. Add the SDK

**Bitrig / XcodeGen (`Project.json`):**

```json
"packages": {
  "RevenueCat": { "url": "https://github.com/RevenueCat/purchases-ios-spm", "from": "5.0.0" }
},
"targets": {
  "Generalizable": {
    "dependencies": [
      { "package": "RevenueCat", "product": "RevenueCat" },
      { "package": "RevenueCat", "product": "RevenueCatUI" }
    ]
  }
}
```

**Xcode:** File → Add Package Dependencies → `https://github.com/RevenueCat/purchases-ios-spm`, then add **RevenueCat** and **RevenueCatUI**.

## 6. Code

### 6.1 Configure at launch (`App/App.swift`)

```swift
import SwiftUI
import RevenueCat

@main
struct AppDefinition: App {
  @State private var store = ProStore()

  init() {
    #if DEBUG
    Purchases.configure(withAPIKey: "test_YOUR_TEST_STORE_KEY")   // Test Store: deterministic on stage
    #else
    Purchases.configure(withAPIKey: "appl_YOUR_PUBLIC_KEY")
    #endif
  }

  var body: some Scene {
    WindowGroup {
      FoldScanView()
        .environment(store)
        .task { await store.observe() }
    }
  }
}
```

### 6.2 One source of truth (`App/Store/ProStore.swift`, new)

```swift
import Foundation
import Observation
import RevenueCat

@MainActor @Observable
final class ProStore {
  private(set) var isPro = false
  var paywallOffering: Offering?          // non-nil means show the paywall
  private var shownPlacements = Set<String>()

  func observe() async {
    for await info in Purchases.shared.customerInfoStream {
      isPro = info.entitlements["pro"]?.isActive == true
      if isPro { paywallOffering = nil }
    }
  }

  /// Gate a Pro feature. Returns true if the caller can proceed right now.
  @discardableResult
  func require(_ placement: String, oncePerSession: Bool = false) async -> Bool {
    if isPro { return true }
    if oncePerSession, shownPlacements.contains(placement) { return false }
    shownPlacements.insert(placement)
    let offerings = try? await Purchases.shared.offerings()
    paywallOffering = offerings?.currentOffering(forPlacement: placement) ?? offerings?.current
    return false
  }
}
```

### 6.3 Fold-triggered paywall (`App/Scan/FoldScanView.swift`)

The view already reads the hinge with `.onHingeChange`. Add a debounced tabletop trigger:

```swift
@Environment(ProStore.self) private var store
@State private var tabletopTask: Task<Void, Never>?

// In the existing iOS 27.1 branch:
workspace.onHingeChange { _, context in
  session.updateHinge(angle: context.hinge?.angle.degrees, isClosed: context.hinge?.status == .closed)
  tabletopTask?.cancel()
  if context.hinge?.status == .partiallyOpen {
    tabletopTask = Task {
      try? await Task.sleep(for: .milliseconds(800))       // wait for the fold to settle
      guard !Task.isCancelled else { return }
      await store.require("tabletop_present", oncePerSession: true)
    }
  }
}
```

### 6.4 Paywall on the base screen, scan stays on the lid

```swift
import RevenueCatUI

// Regular-width / Duo branch of `workspace`:
ArrangementView {
  mainPane                                              // lid: live scan keeps rendering
} secondary: {
  if let offering = store.paywallOffering {
    PaywallView(offering: offering)
      .customPaywallVariables([
        "case_name": .string(session.studyName),
        "finding": .string("your patient")
      ])
      .onPurchaseCompleted { _ in store.paywallOffering = nil }
      .onRestoreCompleted { _ in store.paywallOffering = nil }
  } else {
    VStack(spacing: 0) { studyHeader; locatorCanvas }  // existing base content
  }
}
.arrangementViewStyle(.split)
```

On a compact iPhone, fall back to a sheet:

```swift
.sheet(item: Binding(get: { store.paywallOffering }, set: { store.paywallOffering = $0 })) { offering in
  PaywallView(offering: offering)
}
```

For `.sheet(item:)`, `Offering` must be `Identifiable` (it has an `identifier`). Add `extension Offering: @retroactive Identifiable { public var id: String { identifier } }` if the compiler asks for it.

### 6.5 Other entry points

```swift
// Toolbar: open your own scan
Button("Open CT scan", systemImage: "folder") {
  Task { if await store.require("import_scan") { showsImport = true } }
}

// FoldScanInspector: lung and bone windows are Pro
if newWindow != .tissue { Task { if await store.require("window_presets") { session.window = newWindow } } }
```

Show `Image(systemName: "lock.fill")` next to Pro controls when `!store.isPro`, so the upsell is visible before the tap.

### 6.6 Manage and restore (Customer Center)

```swift
@State private var showsCustomerCenter = false
Button("Subscription", systemImage: "person.crop.circle") { showsCustomerCenter = true }
  .presentCustomerCenter(isPresented: $showsCustomerCenter) { showsCustomerCenter = false }
```

## 7. Testing and the demo beat

1. Configure the DEBUG build with the `test_` key. Test Store products appear with no App Store Connect setup.
2. Run it on the **iPhone Duo** simulator (Xcode 27.1). Open the device into tabletop pose in **Device Hub**.
3. **Demo video, about 20 seconds:**
   - open a case flat;
   - fold into tabletop pose;
   - the paywall slides onto the base while the tumor stays on the lid;
   - tap **Annual**; the purchase completes;
   - presenter mode unlocks.
   - Say: "The fold is the upgrade moment."
4. Relaunch the app: `isPro` should stay true (`customerInfoStream`). Then check restore through the Customer Center.
5. Before a real launch, verify in the App Store sandbox (TestFlight). The Test Store answers "does my code work?", and the sandbox answers "is my real integration ready to ship?"

## 8. Devpost write-up blurb (RevenueCat track)

> **Business model.** Patients never pay. Clinicians and educators subscribe to **Generalizable Pro** ($6.99/mo or $39.99/yr with a 7-day trial) for tabletop presenter mode, their own scans, advanced windows and export. Optional **Explain credits** cover AI slice descriptions. Every Pro seat unlocks a free seat for a student program.
> **Paywall.** Built with RevenueCat Paywalls V2. It's triggered by the **fold**: when the iPhone Duo settles into tabletop pose, the paywall appears on the lower screen while the live scan stays on the lid. Copy is personalized with custom variables, shown at most once per session, and separate placements (`tabletop_present`, `import_scan`, `window_presets`, `export`) let us measure which moment converts.
> **Stack.** RevenueCat SDK + RevenueCatUI (`PaywallView`, Customer Center), entitlement `pro`, Test Store for the demo.

## 9. Checklist

- [ ] SDK configured (`test_` key in DEBUG, `appl_` key in release)
- [ ] Entitlement `pro`; offerings `default`, `present` and `credits`; the five placements
- [ ] Fold-triggered paywall on the base screen with the scan on the lid, once per session
- [ ] Custom paywall variables (`case_name`, `finding`)
- [ ] Gates on import, window presets and export, with lock badges
- [ ] Customer Center for manage and restore
- [ ] Demo video shows the purchase on the Duo
- [ ] Opt in to **Best RevenueCat creation** on Devpost

## Sources

- [Shipaton 2025 winners (RevenueCat)](https://www.revenuecat.com/blog/company/shipaton-2025-winners)
- [Shipaton 2026 prep codelab](https://revenuecat.github.io/codelabs/shipaton-2026-prep.html)
- [Shipaton judging and HAMM award (Devpost)](https://revenuecat-shipaton-2025.devpost.com/)
- [Contextual paywall targeting](https://www.revenuecat.com/blog/growth/contextual-paywall-targeting/)
- [Displaying paywalls (iOS)](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls)
- [Customer Center on iOS](https://www.revenuecat.com/docs/tools/customer-center/customer-center-integration-ios)
- [RevenueCat Test Store](https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store)
- [RevenueCat Experiments](https://www.revenuecat.com/feature/experiments)
