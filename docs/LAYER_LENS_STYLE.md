# Updating the app to the Layer Lens style

> **Demo only.** Public research data. Not a diagnosis.

This guide restyles the current app (`App/Scan/`: `FoldScanView`, `CTSliceCanvas`, `FoldScanInspector`, `ScanStyle`) to match **Layer Lens**, the clinical "fold to cut" design. The live reference is https://claude.ai/artifact/YTEMxzYeFh9Rv6eBdUGnuW: a 3D iPhone Duo with real CT, a hospital-viewer overlay on the lid, and a sagittal locator plus a slim control strip on the base.

Every step keeps the current behaviour (fold-to-scrub from A12, drag the locator, window presets, import, hinge handling). **Only presentation changes.** Work through the steps in order; each one builds and runs by itself.

---

## 1. Principles

1. **The image is sacred.** Scans sit on true black, full bleed. No cards, chips or pills on top of the image.
2. **It should read like a hospital image viewer.** Put text in the four corners in a small monospaced face, orientation letters on the edge midpoints, and a real **50 mm scale bar**.
3. **Two accent colors, each with one meaning.** **Blue `#3AA3FF` means the cut or current slice**, the line you move. **Amber `#FFA41C` means the finding.** Nothing else uses color.
4. **Lid and base have jobs.** On the Duo in tabletop pose, the **lid** shows the slice and the **base** shows where you are: the locator plus a slim control strip. Keep content about 14 pt clear of the fold.
5. **Text-heavy UI is light and clinical.** Sheets such as the inspector, About and Credits use a light palette. Only imaging surfaces are dark.
6. **The disclaimer is always visible,** as a quiet corner line, never a banner over the scan.

## 2. Tokens: replace `ScanStyle` (`App/Scan/CTSliceCanvas.swift`)

```swift
import SwiftUI

enum ScanStyle {
  // Imaging surfaces (dark)
  static let background = Color.black
  static let cut        = Color(red: 0.227, green: 0.639, blue: 1.0)      // #3AA3FF: cut / current slice
  static let finding    = Color(red: 1.0,   green: 0.643, blue: 0.110)    // #FFA41C: finding
  static let text1      = Color(red: 228/255, green: 234/255, blue: 240/255).opacity(0.92)
  static let text2      = Color(red: 170/255, green: 182/255, blue: 196/255).opacity(0.90)
  static let strip      = Color(red: 10/255,  green: 13/255,  blue: 18/255).opacity(0.88)
  static let hairline   = Color.white.opacity(0.08)
  static let calloutFill = Color(red: 12/255, green: 16/255, blue: 22/255).opacity(0.82)
  static let calloutText = Color(red: 1.0, green: 0.89, blue: 0.72)       // #FFE3B8

  // Clinical light sheets
  static let sheetBackground = Color(red: 0.953, green: 0.961, blue: 0.969) // #F3F5F7
  static let sheetSurface    = Color.white
  static let sheetInk        = Color(red: 0.059, green: 0.106, blue: 0.176) // #0F1B2D
  static let sheetMuted      = Color(red: 0.369, green: 0.431, blue: 0.510) // #5E6E82
  static let sheetAccent     = Color(red: 0.043, green: 0.431, blue: 0.600) // #0B6E99

  // Back-compat: existing call sites use `accent`
  static var accent: Color { cut }

  // Type
  static let corner1 = Font.system(size: 11, weight: .medium, design: .monospaced)
  static let corner2 = Font.system(size: 11, weight: .regular, design: .monospaced)
  static let orient  = Font.system(size: 15, weight: .semibold)
  static let stripText = Font.system(size: 13, weight: .medium)
}
```

`accent` now maps to the cut blue, so every existing `ScanStyle.accent` keeps compiling and picks up the new color.

## 3. Overlay pieces (`App/Scan/ScanOverlays.swift`, new)

```swift
import SwiftUI

/// Corner annotation: first line primary, the rest secondary.
struct ScanCorner: View {
  let lines: [String]
  var alignment: HorizontalAlignment = .leading
  var body: some View {
    VStack(alignment: alignment, spacing: 3) {
      ForEach(Array(lines.enumerated()), id: \.offset) { i, s in
        Text(s).font(i == 0 ? ScanStyle.corner1 : ScanStyle.corner2)
          .foregroundStyle(i == 0 ? ScanStyle.text1 : ScanStyle.text2)
      }
    }
  }
}

/// Orientation letters on the edge midpoints.
struct ScanOrientation: View {
  let top: String, bottom: String, left: String, right: String
  var body: some View {
    ZStack {
      VStack { Text(top); Spacer(); Text(bottom) }.padding(.vertical, 6)
      HStack { Text(left); Spacer(); Text(right) }.padding(.horizontal, 8)
    }
    .font(ScanStyle.orient).foregroundStyle(Color.white.opacity(0.8))
    .accessibilityHidden(true)
  }
}

/// A real 50 mm bar. pointsPerMM = displayed image width ÷ (pixel width × mm per pixel).
struct ScanScaleBar: View {
  let pointsPerMM: CGFloat
  var body: some View {
    let len = 50 * pointsPerMM
    VStack(alignment: .leading, spacing: 3) {
      Text("50 mm").font(.system(size: 10, design: .monospaced)).foregroundStyle(ScanStyle.text2)
      Path { p in
        p.move(to: .init(x: 0, y: 5)); p.addLine(to: .init(x: len, y: 5))
        p.move(to: .init(x: 0, y: 0)); p.addLine(to: .init(x: 0, y: 10))
        p.move(to: .init(x: len, y: 0)); p.addLine(to: .init(x: len, y: 10))
      }
      .stroke(ScanStyle.text1, lineWidth: 1.5)
      .frame(width: len, height: 10)
    }
    .accessibilityHidden(true)
  }
}
```

## 4. The slice canvas (`CTSliceCanvas`)

Replace the current header, footer and letters block (the `VStack` with `AXIAL` / `003 / 256` / `mm spacing` / `W · L`, plus the two orientation stacks) with the hospital-viewer layout below. The image, the drag gesture and the accessibility modifiers stay the same.

```swift
// Inside the `if let frame` branch, after the Image:
if !overview {
  ZStack {
    ScanOrientation(top: axis.topLabel, bottom: axis.bottomLabel, left: axis.leftLabel, right: axis.rightLabel)
    VStack {
      HStack(alignment: .top) {
        ScanCorner(lines: [studyName, "CT · W \(Int(frame.key.window.width)) L \(Int(frame.key.window.level))"])
        Spacer()
        ScanCorner(lines: [axis.title.uppercased(), String(format: "Layer %03d / %03d", frame.key.index + 1, frame.count)],
                   alignment: .trailing)
      }
      Spacer()
      HStack(alignment: .bottom) {
        VStack(alignment: .leading, spacing: 4) {
          ScanScaleBar(pointsPerMM: width / CGFloat(frame.imageWidthMM))
          Text("\(frame.spacing.formatted(.number.precision(.fractionLength(1)))) mm slices")
            .font(ScanStyle.corner2).foregroundStyle(ScanStyle.text2)
        }
        Spacer()
        Text("Research · not for diagnosis").font(ScanStyle.corner2).foregroundStyle(ScanStyle.text2)
      }
    }
    .padding(.horizontal, 26).padding(.vertical, 22)
  }
  .allowsHitTesting(false)
}
```

**Supporting changes:**
- Add `studyName: String` as a parameter of `CTSliceCanvas`, and pass `session.studyName` from `FoldScanView`.
- Add `imageWidthMM` to `ScanFrame` in `FoldScanSession.requestRender()`:
  ```swift
  imageWidthMM: Double(volume.dimensions[key.axis.horizontalAxis]) * volume.spacing[key.axis.horizontalAxis]
  ```
  This is the physical width of the displayed slice, so the 50 mm bar is true to scale.
- Keep `.clipped()` on the canvas so nothing draws outside its half of the Duo.

**Locator (overview) canvas:**
- The current-slice line becomes **`ScanStyle.cut`, 2 pt, with no shadow**.
- The end handle becomes a **12 pt blue dot with a 1 pt black ring**.
- Remove the `"… LOCATOR"` header. The strip text below (§5) explains the locator instead.
- If a finding exists (a future case), draw its pivot as a 12 pt **amber** dot with a black ring. Amber always means the finding.

## 5. The control strip (`FoldScanView.sliceControl`)

Replace `sliceControl` with a slim strip, and move the window picker out of the inspector and into it:

```swift
private var sliceControl: some View {
  HStack(spacing: 12) {
    VStack(alignment: .leading, spacing: 2) {
      Text(session.followsFold ? "Fold to move through the scan" : "Drag the blue line to choose a layer")
        .font(ScanStyle.stripText).foregroundStyle(ScanStyle.text1)
      Text(String(format: "Layer %d / %d", session.sliceIndex + 1, session.sliceCount)
           + (session.hingeAngle.map { " · Hinge \(Int($0))°" } ?? ""))
        .font(ScanStyle.corner2).monospacedDigit().foregroundStyle(ScanStyle.text2)
    }
    Spacer(minLength: 8)
    Picker("Window", selection: $session.window) {
      ForEach(ScanWindow.allCases) { Text($0 == .tissue ? "Soft" : $0.rawValue).tag($0) }
    }
    .pickerStyle(.segmented).frame(maxWidth: 220)
    Toggle("Follow fold", isOn: Binding(get: { session.followsFold }, set: session.setFollowsFold))
      .toggleStyle(.button).font(.caption.weight(.medium))
  }
  .padding(.horizontal, 14).padding(.vertical, 10)
  .background(ScanStyle.strip)
  .overlay(alignment: .top) { Rectangle().fill(ScanStyle.hairline).frame(height: 1) }
}
```

## 6. Layout on the Duo (`FoldScanView.workspace`)

In tabletop pose, the **lid** gets the slice with no header, and the **base** gets the locator and the strip:

```swift
ArrangementView {
  CTSliceCanvas(frame: session.frame, studyName: session.studyName)      // lid: image only
} secondary: {
  VStack(spacing: 0) {
    locatorCanvas                                                          // base: where you are
    sliceControl                                                           // slim strip, bottom
  }
}
.arrangementViewStyle(.split)
```

**Other changes:**
- **`studyHeader`:** delete it. The study name now lives in the top-left corner of the slice.
- **`axisPicker`:** keep it, but move it into the toolbar as a `Menu` (`Label("Plane", systemImage: "square.3.layers.3d")`) so the image stays full bleed.
- **Compact iPhone:** stack slice, locator and strip vertically, with the same pieces.
- **Background:** use `.background(ScanStyle.background)` (true black) in place of the old navy.

## 7. Clinical light sheets (inspector, About, Credits)

```swift
.sheet(isPresented: $showsSettings) {
  FoldScanInspector(session: session)
    .scrollContentBackground(.hidden)
    .background(ScanStyle.sheetBackground)
    .tint(ScanStyle.sheetAccent)
    .preferredColorScheme(.light)
}
```

Inside `FoldScanInspector`:

- **Section headers:** `.font(.system(size: 11, weight: .medium, design: .monospaced)).textCase(.uppercase)` with `sheetMuted`.
- **Numbers:** right-aligned `.monospacedDigit()`, for example slice spacing and dimensions.
- **Scan section:** add a **Finding** card when the case has one (title, volume, extent, location, and how it was outlined) with an amber swatch.

## 8. Optional: finding callout

When a case has a finding, add a callout on the slice: an amber 1.5 pt leader line from the finding's upper-right edge to a label box reading `Tumor · 95 mm` (`calloutFill` background, 1 pt amber border, 13 pt semibold `calloutText`). Draw it only on the lid slice, never on the locator.

## 9. Accessibility and motion

- Keep the existing `accessibilityLabel`, `accessibilityValue` and `accessibilityAdjustableAction` on both canvases unchanged.
- Hide the corner and orientation overlays from VoiceOver (`.accessibilityHidden(true)`). The canvas's value already says the plane, the layer and the window.
- **Dynamic Type:** only the strip text scales. Keep the corner labels at a fixed 11 pt, like a hospital viewer, and at accessibility sizes turn the window picker into a `Menu` (the pattern `axisPicker` already uses).
- **Reduce Motion:** apply hinge-driven changes without animation.

## 10. Before / after checklist

- [ ] The slice is full bleed on true black, with no header above it.
- [ ] Four corners: study and window; plane and layer; 50 mm bar and slice spacing; disclaimer.
- [ ] Orientation letters are on the edge midpoints, not in a stack.
- [ ] The locator line is blue 2 pt with no shadow; amber is used only for findings.
- [ ] The strip shows the hint, `Layer n / N · Hinge θ°`, Soft/Lung/Bone, and Follow fold.
- [ ] Duo tabletop pose puts the slice on the lid and the locator plus strip on the base, clear of the fold.
- [ ] Sheets use the light clinical palette.
- [ ] Fold-to-scrub, drag-to-scrub, import and the inspector all behave exactly as before.

Files touched: `App/Scan/CTSliceCanvas.swift`, `App/Scan/FoldScanView.swift`, `App/Scan/FoldScanSession.swift` (`imageWidthMM`), `App/Scan/FoldScanInspector.swift`, plus the new `App/Scan/ScanOverlays.swift`. Nothing in `App/Core/` changes.
