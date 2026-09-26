# AI overlay on the 2D slice panes (cc-ai-overlay-polish)

Scope: `ios/Generalizable/Views/SliceView.swift`, `ios/Generalizable/Shaders/Slice.metal`,
`ios/Generalizable/AI/*`, `ios/Generalizable/Rendering/*` (heatmap only). Case: `CQ500_CT_243`.

## Bug: "solid bright-yellow vertical bar at the right edge of the skull" (axial only)

**Root cause: not a heatmap sampling/geometry bug.** Verified directly:
- `ct.nii.gz` and `ai_heatmap.nii.gz` for CQ500_CT_243 have byte-identical dims (225×256×216),
  spacing (0.8mm) and sform affine, so `VolumeLoader.decode` (shared code path, `.label` kind)
  reorients both into the exact same canonical grid — no dims/affine mismatch.
- `Slice.metal`'s `heatAt` already returns `0` for any voxel outside `dims` (no clamp-to-edge;
  that's only used for CT's `huAt` background sampling, which is correct/desired there).
- Decoding the raw heatmap bytes directly and rendering the actual peak slices as ASCII shows
  an anatomically correct crescent hugging the inner skull table plus a blob — the expected
  look of a subdural bleed, not a rectangle.

**Actual cause:** `AIProbabilityTrack` (a per-axial-slice probability mini-graph drawn beside
the slice scrubber in `SliceInteractionLayer.swift`, axial-only) has no background/track, so a
run of consecutive high-probability slices (71 of 216 slices > 90% for this case — a bleed
usually spans many slices) drew as a tall, near-full-width, saturated inferno-yellow block with
nothing to mark it as a UI legend rather than image content. Sitting flush at the pane's right
edge, right where the skull also reaches, it read exactly like a broken/misaligned heatmap.

**Fix** (`ios/Generalizable/AI/AIProbabilityTrack.swift`): gave the track its own rounded
background + border (matching `SliceScrubber`'s capsule track) and rounded the probability bars,
so it now reads as a distinct mini-graph beside the scrubber, not an overlay glitch on the CT.
No change was needed to `Slice.metal`, `AILoader.swift`, or `VolumeTextures.swift` — the
volumetric heatmap was already correctly bounded and aligned.

## AI pill (task 2)

Replaced the top-left `AICard` (covered the brain, jargon-heavy: "✦ Subdural 99.7% ⌖ 👁") with
a compact bottom-left pill in `AICard.swift`: **"AI: subdural bleed 99.7%"** (plain-language
mapping for the model's ICH classes: subdural/epidural/subarachnoid → "… bleed",
intraparenchymal → "brain bleed", intraventricular → "bleed in the ventricles"), the
scope (jump-to-peak) and eye (heatmap on/off) buttons, and "research model · not a diagnosis"
in 8pt secondary text. Moved in `SliceView.swift` from top-left to bottom-left so it no longer
sits over the brain. `AICard.jumpToPeak(state:ai:)` stays a static func — `ReportPanel.swift`
(another lane) calls it directly and is untouched.

## Per-plane heatmap verification (task 3)

`Slice.metal`'s `sliceFragment` heat-overlay block (`U.hasAI`/`heatAt`) has no plane-specific
gating — it runs identically for axial, coronal and sagittal, only `toVoxel(plane, …)` changes
which volume axis is u/v/slice. `SliceView.params` sets `showAI` the same way for every plane
(only the `AICard` pill and `AIProbabilityTrack` widgets are intentionally axial-only, since
that's where the per-slice detection detail belongs). **Heatmap renders on axial: yes. Sagittal:
yes. Coronal: yes.**

Build: `xcodegen generate && xcodebuild … build` → `BUILD SUCCEEDED`.
