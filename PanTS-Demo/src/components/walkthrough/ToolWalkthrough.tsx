import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconRoute2, IconArrowLeft, IconArrowRight, IconX, IconBulb } from "@tabler/icons-react";
import "./ToolWalkthrough.css";

export interface WalkthroughShortcut {
	/** One or more key tokens rendered as <kbd> chips, e.g. ["Shift", "["]. */
	keys: string[];
	desc: string;
}

export interface WalkthroughStep {
	title: string;
	body: React.ReactNode;
	/** Live rect (from getBoundingClientRect) of whatever this step is
	 *  pointing at. Pass null/undefined for steps that aren't about a
	 *  specific bit of UI (e.g. a pure tips/shortcuts recap) — the card
	 *  centers itself on screen instead. Recomputed by the caller on every
	 *  render while the walkthrough is open, so it tracks draggable panels. */
	targetRect?: DOMRect | null;
	/** Shortcuts relevant to this specific step. Optional — most steps show
	 *  none, some show one, a final recap step can show several. */
	shortcuts?: WalkthroughShortcut[];
	/** An extra highlighted callout for context that isn't a shortcut — e.g.
	 *  "there's a live 3D rendering of every annotation" or "you can type
	 *  directly into the slice counter". */
	note?: React.ReactNode;
}

interface ToolWalkthroughProps {
	visible: boolean;
	/** Shown in the banner and used for the aria-label, e.g. "Brush walkthrough". */
	label: string;
	steps: WalkthroughStep[];
	onDismiss: () => void;
}

const GAP = 14;
const EDGE_MARGIN = 12;

/** Places the callout card beside its target rect (to the right if there's
 *  room, otherwise to the left, otherwise clamped under/over it), using the
 *  card's REAL measured width/height (from a ref, post-render) rather than a
 *  guessed height — that guess is what let tall cards (lots of shortcuts, a
 *  note, near a screen edge) render partly off-screen, e.g. the custom class
 *  walkthrough. Every branch below clamps against actual viewport size, so
 *  the card — and everything inside it, including the footer buttons — is
 *  always fully visible regardless of which corner the target sits in. */
function computeCardPos(rect: DOMRect | null | undefined, cardW: number, cardH: number) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const maxLeft = Math.max(EDGE_MARGIN, vw - cardW - EDGE_MARGIN);
	const maxTop = Math.max(EDGE_MARGIN, vh - cardH - EDGE_MARGIN);

	if (!rect) {
		return {
			top: Math.max(EDGE_MARGIN, (vh - cardH) / 2),
			left: Math.max(EDGE_MARGIN, (vw - cardW) / 2),
		};
	}

	// Prefer beside the target (right, then left). If neither side has room
	// (target spans most of the width), fall back to clamping horizontally
	// against the target's own left edge so the card at least stays on-screen.
	let left = rect.right + GAP;
	if (left + cardW > vw - EDGE_MARGIN) {
		left = rect.left - cardW - GAP;
	}
	if (left < EDGE_MARGIN) {
		left = rect.left;
	}
	left = Math.max(EDGE_MARGIN, Math.min(maxLeft, left));

	let top = rect.top;
	top = Math.max(EDGE_MARGIN, Math.min(maxTop, top));
	return { top, left };
}

function Kbd({ children }: { children: React.ReactNode }) {
	return <span className="twt__key">{children}</span>;
}

function ShortcutRow({ shortcut }: { shortcut: WalkthroughShortcut }) {
	return (
		<div className="twt__shortcut-row">
			<span className="twt__shortcut-keys">
				{shortcut.keys.map((k, i) => (
					<span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
						{i > 0 && <span style={{ opacity: 0.5 }}>+</span>}
						<Kbd>{k}</Kbd>
					</span>
				))}
			</span>
			<span className="twt__shortcut-desc">{shortcut.desc}</span>
		</div>
	);
}

/**
 * Generic, replayable walkthrough overlay. Used for EVERY walkthrough in the
 * app (overview, custom class, and every individual annotation tool) so they
 * all share one exact look/feel/behavior:
 *
 *   - Fully blocking: the scrim captures every click, so nothing underneath
 *     (canvas, panels, buttons) can be triggered by accident while a
 *     walkthrough is up. The ONLY interactive elements are this card's own
 *     Back / Next / Quit controls.
 *   - Quit is always available, always red, and is the only remaining
 *     control on the final step (Next disappears — there's nothing after it).
 *   - Replayable: callers own a boolean (e.g. `walkthroughOpen`) and a
 *     "Show walkthrough" launcher button that just sets it true again — see
 *     `WalkthroughLauncherButton` below. Reopening always restarts at step 1.
 */
export default function ToolWalkthrough({ visible, label, steps, onDismiss }: ToolWalkthroughProps) {
	const [stepIdx, setStepIdx] = useState(0);
	const cardRef = useRef<HTMLDivElement>(null);
	// Starts off-screen (rather than at a guessed spot) so there's never a
	// visible flash at the wrong position — useLayoutEffect below corrects it
	// using the card's real dimensions before the browser paints.
	const [cardPos, setCardPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

	useEffect(() => {
		if (visible) setStepIdx(0);
	}, [visible]);

	useEffect(() => {
		if (!visible) return;
		const onKey = (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === "Escape") { onDismiss(); return; }
			if (e.key === "ArrowRight") setStepIdx((s) => Math.min(steps.length - 1, s + 1));
			if (e.key === "ArrowLeft") setStepIdx((s) => Math.max(0, s - 1));
		};
		// Capture phase so this wins over the app's own global shortcut
		// listeners (undo, tool hotkeys, etc.) while a walkthrough is up.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [visible, onDismiss, steps.length]);

	const total = steps.length;
	const step = steps[Math.min(stepIdx, total - 1)];
	const isLast = stepIdx >= total - 1;
	const targetRect = step?.targetRect;

	// Re-measures the card's actual rendered size (content varies a lot step
	// to step — shortcuts list, note callout, body length — so a fixed guess
	// was never going to be right) and repositions it fully on-screen.
	// Runs before paint, and again on window resize while a walkthrough is up.
	useLayoutEffect(() => {
		if (!visible || !cardRef.current) return;
		const recompute = () => {
			const el = cardRef.current;
			if (!el) return;
			setCardPos(computeCardPos(targetRect, el.offsetWidth, el.offsetHeight));
		};
		recompute();
		window.addEventListener("resize", recompute);
		return () => window.removeEventListener("resize", recompute);
	}, [visible, stepIdx, targetRect?.top, targetRect?.left, targetRect?.width, targetRect?.height, step?.shortcuts, step?.note, step?.body]);

	if (!visible || total === 0) return null;

	// Swallow every pointer event on the scrim so nothing underneath (canvas,
	// panels) reacts — this is what makes the walkthrough non-destructive.
	const blockEvent = (e: React.SyntheticEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};

	return createPortal(
		<div
			className="twt"
			role="dialog"
			aria-label={label}
			onMouseDown={blockEvent}
			onClick={blockEvent}
			onWheel={blockEvent}
			onContextMenu={blockEvent}
		>
			<div className="twt__scrim" />

			<div className="twt__banner">
				<IconRoute2 size={15} />
				{label}
			</div>

			{step.targetRect && (
				<div
					className="twt__spotlight"
					style={{
						top: step.targetRect.top - 8,
						left: step.targetRect.left - 8,
						width: step.targetRect.width + 16,
						height: step.targetRect.height + 16,
					}}
				/>
			)}

			<div ref={cardRef} className="twt__card" style={{ top: cardPos.top, left: cardPos.left }}>
				<div className="twt__eyebrow">Step {stepIdx + 1} of {total}</div>
				<div className="twt__title">{step.title}</div>
				<div className="twt__body">{step.body}</div>

				{step.note && (
					<div className="twt__note">
						<span className="twt__note-icon"><IconBulb size={14} /></span>
						<span>{step.note}</span>
					</div>
				)}

				{step.shortcuts && step.shortcuts.length > 0 && (
					<div className="twt__shortcut-list">
						<div className="twt__shortcut-heading">Shortcuts</div>
						{step.shortcuts.map((s, i) => <ShortcutRow key={i} shortcut={s} />)}
					</div>
				)}

				<div className="twt__footer">
					<div className="twt__dots">
						{steps.map((_, i) => (
							<span key={i} className={`twt__dot ${stepIdx === i ? "is-active" : ""}`} />
						))}
					</div>
					<div className="twt__nav">
						{!isLast && (
							<button type="button" className="twt__btn twt__btn--quit" onClick={onDismiss}>
								<IconX size={13} />
								Quit
							</button>
						)}
						{/* Back is available on every step after the first, including the
						    last one — quitting shouldn't be the only way off the final step. */}
						{stepIdx > 0 && (
							<button type="button" className="twt__btn" onClick={() => setStepIdx((s) => s - 1)}>
								<IconArrowLeft size={13} />
								Back
							</button>
						)}
						{!isLast && (
							<button type="button" className="twt__btn twt__btn--primary" onClick={() => setStepIdx((s) => s + 1)}>
								Next
								<IconArrowRight size={13} />
							</button>
						)}
						{isLast && (
							<button type="button" className="twt__btn twt__btn--quit twt__btn--quit-final" onClick={onDismiss}>
								<IconX size={14} />
								Quit walkthrough
							</button>
						)}
					</div>
				</div>
			</div>
		</div>,
		document.body
	);
}

/** Small "See demo" trigger, styled identically everywhere it's
 *  dropped in (brush panel, every other tool panel, the dock, the segments
 *  popup) — clicking it again after dismissal is how every walkthrough gets
 *  replayed; there's no separate replay control anywhere. */
export function WalkthroughLauncherButton({
	onClick, iconOnly, label = "See demo", title,
}: {
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	iconOnly?: boolean;
	label?: string;
	title?: string;
}) {
	return (
		<button
			type="button"
			className={`twt-launcher ${iconOnly ? "twt-launcher--icon-only" : ""}`}
			onClick={onClick}
			title={title ?? label}
			aria-label={label}
		>
			<IconRoute2 size={13} />
			{!iconOnly && label}
		</button>
	);
}