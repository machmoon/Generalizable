// Shared building blocks for every "click a tool icon -> settings flyout"
// surface in the annotation toolbar, plus the text-menu rows used inside
// those flyouts (Margin, Hollow, Islands, Scissors' operation picker,
// etc). Nothing tool-specific lives here — see GrowFromSeedFlyout.tsx,
// HollowFlyout.tsx, MarginPanel.tsx, etc. for the per-tool panels built
// out of these pieces.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconChevronRight, IconCheck } from "@tabler/icons-react";
import "../viewer/FlyoutPrimitives.css";

export interface FlyoutState {
	open: boolean;
	setOpen: React.Dispatch<React.SetStateAction<boolean>>;
	/** The element the panel is anchored to/positioned relative to. Also
	 *  used as the "click here doesn't count as outside" boundary. */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** The portaled panel's own root — also part of the outside-click
	 *  boundary, so clicking inside the open panel never closes it. */
	panelRef: React.RefObject<HTMLDivElement | null>;
}

// Every currently-mounted flyout registers itself here so opening one can
// close every other registered flyout within the same `scope`, keeping at
// most one panel open per scope at a time (e.g. one grandchild row open in
// Margin/Hollow/Islands/Logical Operators). Different scopes don't affect
// each other — this is what lets a top-level tool-settings flyout ("top")
// stay open while a grandchild option panel ("grandchild") opens inside
// it. Not used to detect outside clicks — see the
// `.atb-pop__panel`/`.atb-pop__overlay` class check below for that.
let flyoutIdCounter = 0;
const openFlyouts = new Set<{ id: number; scope: string; close: () => void }>();

/** One open/closed flyout's worth of state — anchor a MenuRow/tool icon to
 *  `anchorRef`, pass `open`/`panelRef` straight into a <FlyoutPanel>, and
 *  it closes itself on an outside click automatically.
 *
 *  `closeOnOutsideClick` (default true) can be set to false for a flyout
 *  whose content drives interaction OUT on the CT canvas itself (guided
 *  slice-anchor picks, grow-from-seeds scribbling, island picking) — for
 *  those, every click on the viewer is a legitimate "outside" click by
 *  position, but closing the flyout would unmount the very walkthrough
 *  state that click was meant to feed. Those tools close only in response
 *  to an explicit action (re-clicking the tool icon, Apply, Start over,
 *  cancel), never from an incidental outside click.
 *
 *  `scope` (default "default") groups flyouts for the "opening one closes
 *  its siblings" behavior — see the comment on `openFlyouts` above. Pass
 *  "top" for a tool's own top-level settings flyout and "grandchild" for
 *  any panel opened from a MenuRow inside it, so the two never fight. */

// eslint-disable-next-line react-refresh/only-export-components
export function useFlyout(initialOpen = false, options?: { closeOnOutsideClick?: boolean; scope?: string; onOutsideClose?: () => void }): FlyoutState {
	const closeOnOutsideClick = options?.closeOnOutsideClick ?? true;
	const scope = options?.scope ?? "default";
	const onOutsideClose = options?.onOutsideClose;
	const id = useRef(0);
	if (id.current === 0) id.current = ++flyoutIdCounter;
	const [open, setOpenState] = useState(initialOpen);
	const anchorRef = useRef<HTMLElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);

	const setOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
		setOpenState((prev) => {
			const next = typeof value === "function" ? (value as (p: boolean) => boolean)(prev) : value;
			if (next) {
				// Close every other flyout in the same scope, without
				// affecting a different-scope parent/ancestor flyout.
				openFlyouts.forEach((entry) => { if (entry.id !== id.current && entry.scope === scope) entry.close(); });
			}
			return next;
		});
	}, [scope]);

	useEffect(() => {
		const entry = { id: id.current, scope, close: () => setOpenState(false) };
		openFlyouts.add(entry);
		return () => { openFlyouts.delete(entry); };
	}, [scope]);

	useEffect(() => {
		if (!open || !closeOnOutsideClick) return;
		const onPointerDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
			// A grandchild panel is portaled to <body> as a DOM sibling of
			// this flyout's panelRef, not a descendant, so without this
			// check a click inside an open grandchild would register as an
			// outside click on the parent and close it before the row's
			// own onClick fires.
			if (t instanceof Element && (t.closest(".atb-pop__panel") || t.closest(".atb-pop__overlay"))) return;
			setOpenState(false);
			// Distinct from other ways this flyout closes (Apply, Exit,
			// re-clicking the tool icon, ...) — this is "clicked away from
			// it", which should also fully deselect the owning tool.
			// Callers wire that up here rather than this hook reaching
			// into tool-selection state itself.
			onOutsideClose?.();
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, closeOnOutsideClick]);

	return { open, setOpen, anchorRef, panelRef };
}

/** The small standalone downward-chevron trigger that sits directly next to
 *  a tool icon in the ribbon (paint/erase/scissors/level-tracing — the
 *  "equip and use" tools that keep a separate settings arrow). Every other
 *  tool opens its settings straight from the icon click, so this is only
 *  ever used for that one group. */
export function FlyoutArrow({
	open, onClick, label,
}: {
	open: boolean;
	onClick: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			className={`atb-pop__arrow ${open ? "is-open" : ""}`}
			onClick={onClick}
			// The panel this arrow toggles anchors to the tool's ICON, not the
			// arrow itself (so the flyout centers under the icon rather than
			// the wider icon+arrow wrapper) — so the arrow sits outside the
			// anchorRef/panelRef boundary useFlyout's outside-click listener
			// checks. Without this, pressing the arrow to CLOSE an open
			// flyout raced with that listener: its `mousedown` handler fired
			// first (mousedown bubbles to `document` before `click` fires),
			// saw the arrow wasn't inside the boundary, and closed the panel
			// right there — then this button's own `onClick` ran a beat
			// later against an already-`open:false` render and reopened it,
			// so the arrow appeared to do nothing on the second press.
			// Stopping propagation here keeps that mousedown from ever
			// reaching the document listener, so this button's own toggle
			// logic is the only thing that decides open/closed.
			onMouseDown={(e) => e.stopPropagation()}
			aria-label={label}
			aria-expanded={open}
		>
			<IconChevronDown size={14} stroke={2.25} />
		</button>
	);
}

/** The portaled popup rectangle itself — positioned against `anchorRef`,
 *  either directly below it (a tool's top-level settings flyout) or to its
 *  right (a grandchild opened from a MenuRow inside another flyout).
 *  Closes/repositions are the caller's job via `useFlyout`; this component
 *  only handles "where does the box go" + "render it above everything". */
export function FlyoutPanel({
	open,
	anchorRef,
	panelRef,
	placement = "below",
	minWidth,
	children,
	keepMounted = false,
	anchorKey,
}: {
	open: boolean;
	anchorRef: React.RefObject<HTMLElement | null>;
	panelRef: React.RefObject<HTMLDivElement | null>;
	placement?: "below" | "right";
	minWidth?: number;
	children: React.ReactNode;
	/** Bump this (e.g. pass the active tool's id) whenever `anchorRef.current`
	 *  is swapped to point at a DIFFERENT element while the panel is already
	 *  open. `anchorRef` is a plain ref — mutating `.current` doesn't change
	 *  its identity, so the position effect below (keyed on `[open, anchorRef,
	 *  placement]`) would never re-run and the panel would stay glued to the
	 *  OLD icon's position (e.g. Hollow's flyout appearing to open under
	 *  Brush after switching tools without ever closing first). Including
	 *  `anchorKey` in the effect's dependencies forces a reposition any time
	 *  the caller tells us the anchor target actually changed. */
	anchorKey?: string | number | null;
	/** When true, children stay MOUNTED in the DOM (just visually hidden via
	 *  `display:none`) instead of being torn down whenever `open` goes
	 *  false. Required for any flyout whose content owns state/portals that
	 *  must survive a settings-close — GrowFromSeeds, CopyAcrossSlices,
	 *  FillBetweenSlices, and Islands all call `onCloseSettings` (which sets
	 *  `open` false) the INSTANT their guided full-screen overlay takes
	 *  over. Without `keepMounted`, that close was unmounting the component
	 *  (and its portaled overlay, and its picker hook state) before the
	 *  overlay ever had a chance to render — the overlay simply never
	 *  appeared. With `keepMounted`, the panel box hides but the component
	 *  tree — and the overlay it portals to <body> — stays alive. */
	keepMounted?: boolean;
}) {
	// `pointer` is the offset (along the panel's top edge for "below", or
	// its left edge for "right") of the little blue-bordered arrow that
	// connects the panel back to the ribbon icon it opened from — see
	// .atb-pop__pointer. Computed off the anchor's own center, same
	// approach as SegmentsPopup's FormFlyout arrowLeft.
	const [pos, setPos] = useState<{ top: number; left: number; pointer: number } | null>(null);

	// How long the panel's grow-in/shrink-out transition takes — mirrors the
	// entrance animation's own duration (see .atb-pop__panel's
	// atb-pop-grow-in keyframes) so opening and closing feel symmetric.
	const PANEL_ANIM_MS = 160;
	// Lags one tick behind `open` on the way out so a non-keepMounted panel
	// stays mounted long enough to play its shrink/fade-out transition
	// instead of snapping straight to unmounted the instant a tool
	// deselects or an outside click lands.
	const [closing, setClosing] = useState(false);
	const closeTimerRef = useRef<number | null>(null);
	const [everOpened, setEverOpened] = useState(open);

	useEffect(() => {
		if (open) {
			if (closeTimerRef.current != null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
			setClosing(false);
			setEverOpened(true);
			return;
		}
		if (!everOpened) return; // never shown yet — nothing to animate out
		setClosing(true);
		closeTimerRef.current = window.setTimeout(() => {
			setClosing(false);
			closeTimerRef.current = null;
			if (!keepMounted) setPos(null);
		}, PANEL_ANIM_MS);
		return () => { if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		if (!open) {
			// Position is now cleared by the close-timer above (once the
			// shrink/fade-out transition finishes) rather than instantly here,
			// so a non-keepMounted panel keeps rendering at its correct spot
			// for the duration of that transition instead of jumping to
			// top:-9999 the instant `open` flips false.
			return;
		}
		const compute = () => {
			const el = anchorRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const margin = 8;
			const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
			const vh = typeof window !== "undefined" ? window.innerHeight : 768;
			// Panel isn't mounted yet on this pass, so we don't have its real
			// rendered width — estimate from minWidth (every caller passes one
			// for panels that could realistically hit an edge) so the clamp
			// still keeps the panel on-screen instead of letting it run off
			// the right edge, which is what was happening for grandchildren
			// anchored to icons/rows near the right side of the ribbon.
			const estWidth = minWidth ?? 240;
			let left: number;
			let top: number;
			if (placement === "right") {
				left = r.right + margin;
				top = r.top;
				if (left + estWidth > vw - margin) {
					// Not enough room to the right of the anchor — flip to its left.
					left = Math.max(margin, r.left - estWidth - margin);
				}
			} else {
				left = r.left;
				top = r.bottom + margin;
				if (left + estWidth > vw - margin) left = Math.max(margin, vw - estWidth - margin);
			}
			left = Math.max(margin, left);
			top = Math.min(top, vh - margin - 40);
			// Point the arrow at the anchor's own center, clamped to stay
			// within the panel's (estimated) bounds — same clamping idea as
			// SegmentsPopup's FormFlyout arrowLeft, just axis-swapped for
			// "right" panels (offset down their left edge instead of across
			// their top edge).
			const pointer = placement === "right"
				? Math.max(14, Math.min(r.top + r.height / 2 - top, (panelRef.current?.offsetHeight ?? 200) - 14))
				: Math.max(14, Math.min(r.left + r.width / 2 - left, estWidth - 14));
			setPos({ top, left, pointer });
		};
		compute();
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [open, anchorRef, placement, anchorKey]);

	// Non-persistent flyouts: stay mounted through `closing` so the
	// shrink/fade-out transition can play, and unmount once it's done (pos
	// gets cleared by the timer above at that point).
	if (!keepMounted && (!(open || closing) || !pos || typeof document === "undefined")) return null;
	// Persistent flyouts: nothing to portal yet if it's never been opened
	// (no anchor position computed) — still fine to unmount in that case,
	// there's no state to lose.
	if (keepMounted && (!pos || typeof document === "undefined")) return null;
	if (!pos || typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={panelRef}
			className={`atb-pop__panel ${placement === "right" ? "atb-pop__panel--right" : "atb-pop__panel--below"} ${!open ? "is-closing" : ""}`}
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				minWidth,
				// Keep-mounted panels fade/scale out via the is-closing CSS
				// class instead of vanishing behind display:none — but once
				// that transition has actually finished (closing === false
				// and still not open), fall back to display:none so the
				// invisible box can't intercept clicks meant for the canvas
				// underneath it.
				display: keepMounted && !open && !closing ? "none" : undefined,
			}}
		>
			{/* Blue-bordered pointer connecting this panel back to the
			 *  ribbon icon (or row) it opened from — same rotated-square
			 *  technique as SegmentsPopup's .segpop__form-flyout-arrow,
			 *  but with a Hopkins-blue border so it doubles as a clear
			 *  "this panel belongs to that button" cue. Sits on the top
			 *  edge for a "below" panel, the left edge for a "right" one. */}
			<span
				className={`atb-pop__pointer ${placement === "right" ? "atb-pop__pointer--left" : "atb-pop__pointer--top"}`}
				style={placement === "right" ? { top: pos.pointer } : { left: pos.pointer }}
			/>
			{children}
		</div>,
		document.body
	);
}

/** A vertical stack of MenuRows — the Google-Docs-style column layout used
 *  by Margin, Hollow, Islands, and the Scissors operation picker. */
export function MenuColumn({ children }: { children: React.ReactNode }) {
	return <div className="atb-menu-col">{children}</div>;
}

/** One row of plain text inside a MenuColumn. Two roles, distinguished by
 *  whether `rowRef` is passed:
 *   - with `rowRef`: this row opens a grandchild flyout to its right
 *     (`open` = whether that grandchild is currently open) — gets a
 *     trailing chevron.
 *   - without `rowRef`: a direct one-shot action row (e.g. Islands' "Keep
 *     largest", a Scissors operation choice) — `open` just marks it as the
 *     current selection, no chevron since there's nothing to open. */
export function MenuRow({
	label,
	onClick,
	onHover,
	onLeave,
	open,
	rowRef,
	disabled,
	expandIcon,
}: {
	label: string;
	onClick?: () => void;
	/** Called on mouseenter — for rows that open a grandchild, pass
	 *  `() => grandchild.setOpen(true)` so hovering (not just clicking)
	 *  opens it, matching how Google Docs' own nested menus behave. */
	onHover?: () => void;
	/** Called on mouseleave — paired with `onHover` for rows whose
	 *  grandchild should close again once the pointer isn't over the row
	 *  (or the grandchild panel itself) anymore, instead of staying open
	 *  indefinitely after a single hover. See `GrandchildRow` below, which
	 *  wires this up for you. */
	onLeave?: () => void;
	open?: boolean;
	rowRef?: React.Ref<HTMLButtonElement>;
	disabled?: boolean;
	/** This row expands its own extra settings as a card that opens to its
	 *  RIGHT (see GrandchildRow / .atb-menu-expand__body), not an inline
	 *  accordion — the chevron reflects that: it points right at rest (the
	 *  direction the card will open) and rotates to point left once
	 *  expanded, echoing "this is where it opened from, click to send it
	 *  back". Rendered inside its own small rounded chip (see
	 *  `.atb-menu-row__expand-chip`) rather than a bare inline glyph — that
	 *  chip is what keeps this reading as a distinct "opens a panel"
	 *  affordance instead of being mistaken for ActionButton's plain
	 *  trailing arrow (Islands' "Remove picked" etc.), which performs an
	 *  edit immediately and never rotates. */
	expandIcon?: boolean;
}) {
	return (
		<button
			ref={rowRef}
			type="button"
			className={`atb-menu-row ${open ? "is-active" : ""}`}
			onClick={onClick}
			onMouseEnter={onHover}
			onMouseLeave={onLeave}
			disabled={disabled}
			aria-expanded={expandIcon ? !!open : undefined}
		>
			<span className="atb-menu-row__label">{label}</span>
			{expandIcon ? (
				<span className={`atb-menu-row__expand-chip ${open ? "is-open" : ""}`} aria-hidden="true">
					<IconChevronRight
						size={12}
						stroke={2.25}
						className={`atb-menu-row__expand-chevron ${open ? "is-open" : ""}`}
					/>
				</span>
			) : (
				<>
					{/* Leaf rows (no rowRef) show a check when selected; rows that
					 *  open a further grandchild show a chevron instead. */}
					{!rowRef && open && <IconCheck size={14} stroke={2.5} className="atb-menu-row__check" style={{ color: 'cyan' }} />}
					{rowRef && <IconChevronRight size={13} stroke={2.25} className="atb-menu-row__chevron" />}
				</>
			)}
		</button>
	);
}

/** A MenuRow that reveals its extra settings INLINE, directly beneath
 *  itself in the same column — a plain accordion, like a nested item in a
 *  Google Docs / Notion menu, rather than a second floating rectangle
 *  popped out to the side. Click to expand/collapse; only ever one flat
 *  surface on screen, indented and rail-marked so the hierarchy still
 *  reads clearly without needing its own box, border, or shadow.
 *
 *  This used to portal a separate `.atb-pop__panel` off to the right,
 *  independently positioned via `getBoundingClientRect`. That's what
 *  produced the "rectangle inside a rectangle" look, and — since its
 *  position was computed from a live anchor element — was also the thing
 *  that ended up stranded in the top-left corner if that anchor ever
 *  unmounted (e.g. the whole toolbar closing) while it was open. Going
 *  fully inline removes both problems: there's no separate position to
 *  compute, and nothing to get orphaned. */
export function GrandchildRow({
	label,
	children,
	expanded: expandedProp,
	onToggle,
}: {
	label: string;
	children: React.ReactNode;
	/** Controlled mode — pass both together. Lets a parent coordinate
	 *  several GrandchildRows so opening one closes any other that's
	 *  already open (see LogicalOperatorsPanel, which has one row per
	 *  operation). When omitted, the row falls back to managing its own
	 *  open/closed state internally, as before — fine for a lone row
	 *  like Islands' "Remove small". */
	expanded?: boolean;
	onToggle?: () => void;
	/** @deprecated no longer used now that this renders inline — kept so
	 *  existing call sites don't need to change. */
	minWidth?: number;
}) {
	const [internalExpanded, setInternalExpanded] = useState(false);
	const isControlled = expandedProp !== undefined && !!onToggle;
	const expanded = isControlled ? expandedProp : internalExpanded;
	const toggle = isControlled ? onToggle! : () => setInternalExpanded((v) => !v);

	return (
		<div className="atb-menu-expand">
			<MenuRow
				label={label}
				open={expanded}
				expandIcon
				onClick={toggle}
			/>
			{expanded && <div className="atb-menu-expand__body">{children}</div>}
		</div>
	);
}
/** A thin horizontal rule for separating a slider from the button/row
 *  group beneath it inside a flyout — the one line every flyout with both
 *  a numeric field and a set of actions should carry between them, so the
 *  two groups read as distinct steps instead of running together. */
export function MenuDivider() {
	return <div className="atb-menu-divider" role="separator" />;
}

/** A vertical stack of ActionButtons — same column shape as MenuColumn,
 *  used specifically for one-shot "do this now" actions (Margin's Grow/
 *  Shrink, Smoothing's Smooth, Islands' direct/pick operations, Grow-from-
 *  Seeds' scope pick) so they're visually distinct from a MenuColumn of
 *  MODE rows (Scissors' operation, Level Tracing's mode) even though both
 *  are plain vertical lists. */
export function ActionList({ children }: { children: React.ReactNode }) {
	return <div className="atb-action-list">{children}</div>;
}

/** A one-shot action row styled like ApplyButton (solid white pill, black
 *  text) rather than a plain menu row — used for anything that PERFORMS an
 *  edit immediately when clicked (Margin's Grow/Shrink, Smoothing's Smooth,
 *  Islands' operations, Grow-from-Seeds' scope pick), as opposed to picking
 *  a persistent MODE (Scissors' operation, Level Tracing's mode — those stay
 *  MenuRow with a trailing check). A trailing arrow marks it as "runs the
 *  action", swapping for a small spinner while `busy` is true — the same
 *  affordance ApplyButton uses, just laid out to sit naturally in a column
 *  instead of standing alone. */
export function ActionButton({
	label,
	runningLabel,
	busy,
	success,
	successLabel,
	disabled,
	onClick,
	title,
}: {
	label: string;
	/** Shown instead of `label` while `busy` is true — e.g. "Growing…". */
	runningLabel?: string;
	busy?: boolean;
	/** True for a brief beat right after the action commits — swaps the
	 *  trailing arrow/spinner for a Hopkins-blue checkmark and the label
	 *  for `successLabel` (falls back to "Done"), so the person sees an
	 *  explicit confirmation instead of the button just quietly vanishing
	 *  as the flyout closes underneath it. Caller owns the timing: flip
	 *  this true once the op resolves, hold it for ~500-700ms, THEN call
	 *  onApplied — the flyout's own close transition (see FlyoutPanel's
	 *  `closing` state) takes it from there, so the checkmark is visibly
	 *  on screen for a beat before the whole panel fades/shrinks away
	 *  instead of the two happening in the same instant. */
	success?: boolean;
	successLabel?: string;
	disabled?: boolean;
	onClick: () => void;
	/** Optional native hover tooltip — for a longer explanation that
	 *  doesn't fit in the button's own (short, verb-first) label. */
	title?: string;
}) {
	return (
		<button
			type="button"
			className={`atb-action-btn ${success ? "is-success" : ""}`}
			onClick={onClick}
			disabled={disabled || busy || success}
			title={title}
		>
			<span className="atb-action-btn__label">
				{success ? (successLabel ?? "Done") : busy ? (runningLabel ?? label) : label}
			</span>
			{success ? (
				<IconCheck size={14} stroke={3} className="atb-action-btn__check" />
			) : busy ? (
				<span className="atb-action-btn__spinner" aria-hidden="true" />
			) : (
				<IconChevronRight size={14} stroke={2.5} className="atb-action-btn__arrow" />
			)}
		</button>
	);
}