# BodyMaps branding — how to style this app

The visual identity comes from the BodyMaps brand pack (v1.0, July 2026). The
tokens live in `PanTS-Demo/src/styles/brand.css` and are available globally —
use them instead of hex literals for any app-chrome color or font.

> **Colors reverted, 2026-08-14.** The brand pack's color rollout (ink primary
> + orange accent) was reverted app-wide back to the pre-pack palette (JHU
> blue `#002d72` primary, blue accents in the viewer). Typography (IBM Plex),
> the logo, favicon/OG assets, and the site footer were **not** reverted and
> stay as shipped. `scripts/brand-guard.mjs` and its CI workflow were removed
> since they specifically enforced the now-reverted colors and would otherwise
> fail every future PR. `brand.css`'s token *values* are unchanged (still used
> by the footer and some viewer surfaces) — most app-chrome components were
> switched back to hardcoded pre-pack hex instead of consuming those tokens.
> The color rows below describe `brand.css` as authored, not what most of the
> app currently renders.

CI no longer runs a dedicated brand-color guard. `src/test/brand.test.ts`
still checks the surviving invariants (fonts, logo, favicon/OG metadata).

## Colors

| Token | Value | Use for |
|---|---|---|
| `--ink` / `--ink-2` / `--ink-3` | `#0F172A` / `#1B2436` / `#2A344A` | **The main color.** Headings, body text, primary button fills, active nav states, focus borders, toggles-on; `--ink-2/3` for hover/elevation on ink fills |
| `--paper` / `--paper-2` / `--paper-3` | `#FFFFFF` / `#F7F7F4` / `#ECEBE5` | Page ground, off-white bands, cards |
| `--rule` | `#E2E1DA` | Hairline dividers, card borders (instead of shadows) |
| `--accent` | `#E76F51` | Vivid orange: decorative bands/graphics, accents and CTA fills on **dark** surfaces (pair with ink text) |
| `--accent-deep` | `#C2532F` | Orange **text only** on light: links, eyebrow numbers, stat values. AA on `--paper` (#FFFFFF) **only** — on `paper-2`/`paper-3`/`#fafafa` use `--accent-deep-hover` instead. Not for button fills — primary fills are ink |
| `--accent-tint` | `#F08A6F` | Small orange text on **dark** (7.3:1 on ink) |
| `--muted` / `--muted-2` | `#5A6175` / `#6B7285` | Secondary / tertiary text on light |
| `--accent-deep-hover` | `#A8431F` | Hover state for accent-deep fills/links (app-local, not a pack token) |
| `--teal` | `#0B4F6C` | **Reserved — do not use** |

Ink is the main color; orange is strictly an accent and scarce by design: one
accent word per heading, one band per composition, small highlights only.
Never vivid `--accent` for normal-size text on white, and never orange as the
dominant fill color of a page.

Functional colors are **not** brand colors: segmentation palettes, organ mesh
colors, CT windowing grays, success/error states stay as they are.

## Typography

IBM Plex Sans 400/500/600 for everything; IBM Plex Mono 400/500 for labels,
eyebrows, and numeric metadata. Self-hosted from `PanTS-Demo/public/fonts/`
via `@font-face` in `brand.css` — never load fonts from an external host.
Use `var(--font-sans)` / `var(--font-mono)`. Weights above 600 are not shipped
(`font-synthesis: none` means they silently render as the nearest real weight,
so don't declare them). The viewer's `--vp-font` / `--vp-mono` alias these
tokens.

## Logo

`PanTS-Demo/public/bodymaps-logo.svg` is the adopted mark (two ink bars +
orange agreement band) and the only sanctioned mark. Never rotate, stretch,
recolor, round, clip, or add effects to it; minimum size 16px; keep roughly one
bar-height of clear space. Favicons (`favicon.svg`, PNG fallbacks,
`apple-touch-icon.png`) and the OG share image are the brand-pack exports —
replace them only with new pack exports.

## Naming

"BodyMaps" is the product/company; "PanTS" and "CancerVerse" name datasets and
case IDs only. Title format: `BodyMaps — <descriptor>` (em dash).

## Deferred surfaces (do not copy their style)

These files still carry pre-brand colors/fonts and are explicitly allowlisted
in `scripts/brand-guard.mjs` because they are under active development in
open PRs — they get migrated in a follow-up, not piecemeal:
`UploadPage.css/.tsx`, `VisualizationPage.css/.tsx`, `AnnotationToolbar.*`,
`FlyoutPrimitives.css`, the `segmentation/` components, `ToolWalkthrough.css`,
`MeasurementPanel.css`, `AISidebar.css`, `Preview.tsx`, and (pre-registered
for an in-flight branch) `SharePatientCard.tsx`. Their "Space Grotesk" /
"JetBrains Mono" declarations render as IBM Plex via an alias `@font-face`
shim in `brand.css` until migrated. Don't add files to an allowlist to
silence the guard — use the tokens.

The guard's scan scope is `PanTS-Demo/` only, by decision: repo-root apps
(`analytics/`) and `flask-server/` are out of scope for now. The Flask PDF
report (`flask-server/api/utils.py` header drawing plus its template) is a
known deferred brand surface *outside* the guard's reach — migrate it when
that file's in-flight PRs land.
