# UI/UX polish — 3D pane, report AI section, structures list

Agent: `cc-ux-3dpane` (one of 5 parallel UI/UX polish agents). Scope: exactly
`Views/MeshView.swift`, `Views/VolumeView.swift`, `Views/ReportPanel.swift`,
`Views/OrganListPanel.swift`. No other files touched.

**Lane-overlap note:** `coordination/agents/cc-lumen-ux.json` claims broad ownership of
`ios/Generalizable/Views/` (status `active`, working directly on `main`). This task was assigned
as a narrow 4-file slice of a 5-way parallel split, in an isolated worktree. Flagging for the
Commander to reconcile at integration/merge time — did not block on it given the explicit,
narrow scope.

## Changes

1. **MeshView.swift — context shell for lesion-only views.** When every organ in
   `state.visibleOrgans` is a lesion (the head CT default: skin/skull/brain hidden, hemorrhage
   shown), a bare bleed floating in black space had no spatial meaning. Added `contextOrgan`
   (skin, else skull, else brain — whichever mesh exists) that always renders at a fixed low
   alpha (0.06), unclipped, non-interactive (excluded from tap-to-select), regardless of the
   Structures panel's visibility toggles. Cases with no such mesh (e.g. abdominal organs) are
   unaffected. The lesion itself is untouched — still emissive, full opacity, always on top.

2. **MeshView.swift — simplified bottom capsule.** Smaller capsule (padding/font down a step),
   slider narrowed (160pt to 96pt) and scaled down 0.8x with a dim tint to shave down the default
   white knob, a hairline divider separating the slider from the two icon buttons, and
   accessibility labels/values added to the opacity slider, plane toggle, and reset-camera button
   (all three previously had none).

3. **ReportPanel.swift — AI section hierarchy.** Restructured `aiSection`: larger headline
   class name + probability pair labeled "blind detection", a "Research model · not a
   diagnosis" pill (always shown, in addition to the case's own `ai.disclaimer` text in the
   footer), plain-language labels for peak slice and Dice agreement ("Strongest signal on...",
   "Agrees with the expert-drawn mask..."), a divider before the heatmap toggle, and a
   full-width "Jump to peak slice" button. Confirmed the section only renders `if let ai =
   state.loaded.ai`, i.e. only for cases that ship AI output (head CT case) — no ai present means
   no section, no crash.

4. **OrganListPanel.swift — accessibility polish.** Title "Structures" and plain organ names
   were already in place; added accessibility labels to the eye (show/hide) button, the close
   button, and an accessibility hint on the Peel button (kept intact, per instructions).

## AI section contents when `loaded.ai` is present (head CT case)

- Sparkles icon + headline class name (e.g. "Subdural") + probability, labeled "blind detection"
- "Research model · not a diagnosis" pill
- Peak axial slice line (if `peakSlice` present)
- Dice-vs-expert-mask line (if `diceVsExpert` present)
- "Also checked: <other classes + %>" line (if any)
- "Show heatmap on scan" toggle bound to `state.showAI`
- "Jump to peak slice" button (disabled if no peak slice)
- Model/license/runtime line (`aiModelLine`)
- The case's own disclaimer string

## Build

`xcodegen generate --quiet && xcodebuild ... build` → **BUILD SUCCEEDED**. Simulator not
installed/launched, per instructions.
