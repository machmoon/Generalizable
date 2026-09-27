// MaskingSelect.tsx
import { useState } from "react";
import { createPortal } from "react-dom";
import { useRef, useEffect } from "react";
import {
	IconWorld,
	IconStack2,
	IconStack2Filled,
	IconFocus2,
	IconStackBack,
	IconStackPop,
	IconTarget,
	IconChevronDown,
} from "@tabler/icons-react";
import "./MaskingSelect.css";

export type MaskingArea =
	| "everywhere"
	| "insideAllSegments"
	| "insideVisibleSegments"
	| "insideSegment"
	| "outsideAllSegments"
	| "outsideVisibleSegments"
	| "outsideSegment";

interface MaskingOption {
	value: MaskingArea;
	label: string;
	Icon: typeof IconWorld;
}

// Icons are chosen to read as a small family: filled/layered = "inside", outlined/
// crossed = "outside", globe = no restriction, target = just the active segment.
const OPTIONS: MaskingOption[] = [
	{ value: "everywhere", label: "Everywhere", Icon: IconWorld },
	{ value: "insideAllSegments", label: "Inside all classes", Icon: IconStack2Filled },
	{ value: "insideVisibleSegments", label: "Inside visible classes", Icon: IconStack2 },
	{ value: "insideSegment", label: "Inside this class", Icon: IconTarget },
	{ value: "outsideAllSegments", label: "Outside all classes", Icon: IconStackBack },
	{ value: "outsideVisibleSegments", label: "Outside visible classes", Icon: IconStackPop },
	{ value: "outsideSegment", label: "Outside this class", Icon: IconFocus2 },
];

interface MaskingSelectProps {
	value: MaskingArea;
	onChange: (v: MaskingArea) => void;
	hasActiveSegment: boolean;
	hasAnySegments: boolean; // NEW — checkBoxData.length > 0
	/** True when the active target is a static catalog organ (baked into the local
	 *  nifti's ground-truth labelmap). Those only ever exist in full, so scope has
	 *  nothing to restrict — render a plain, non-interactive "Everywhere" readout
	 *  instead of the dropdown. Custom classes keep the full picker. */
	locked?: boolean;
}

/** Global "where is this tool allowed to act" control — shared by every tool in the
 *  annotation corner panel instead of each one having its own scope toggle. */
export default function MaskingSelect({ value, onChange, hasActiveSegment, hasAnySegments, locked }: MaskingSelectProps) {
	const [open, setOpen] = useState(false);
	// Lags one animation frame behind `open` so the menu can mount in its
	// closed (scaled-down/transparent) state first, then transition to
	// "open" on the next frame — and lags behind on the way out so it stays
	// mounted long enough to play the closing transition instead of
	// vanishing instantly. Mirrors the color popover's open/closing pattern.
	const [visible, setVisible] = useState(false);
	const closeTimerRef = useRef<number | null>(null);
	// Anchored by the button's RIGHT edge (not left) — this control sits at
	// the far right of the ribbon, and menu items are `white-space: nowrap`
	// with no max-width, so a left-anchored menu would grow off the right
	// side of the viewport as soon as any option label was longer than the
	// trigger button itself. Growing leftward from a fixed right edge keeps
	// it on-screen regardless of content width.
	const [pos, setPos] = useState<{ top: number; right: number; width: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const active = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];
	const everywhere = OPTIONS[0];

	// How long the menu's open/close transition runs — kept in one place so
	// the JS unmount timer and the CSS transition duration (MaskingSelect.css)
	// stay in sync.
	const MENU_ANIM_MS = 160;

	const closeMenu = () => {
		if (closeTimerRef.current != null) return;
		setOpen(false);
		closeTimerRef.current = window.setTimeout(() => {
			setVisible(false);
			closeTimerRef.current = null;
		}, MENU_ANIM_MS);
	};

	const toggle = () => {
		if (open) { closeMenu(); return; }
		if (closeTimerRef.current != null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		if (btnRef.current) {
			const r = btnRef.current.getBoundingClientRect();
			setPos({ top: r.bottom + 6, right: window.innerWidth - r.right, width: r.width });
		}
		setVisible(true);
		// Mount closed first, then flip to "open" on the next frame so the
		// scale/opacity transition actually has something to animate from.
		requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
	};

	useEffect(() => () => {
		if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
	}, []);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
			closeMenu();
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	// NOTE: catalog organs used to force a non-interactive "Everywhere" readout
	// here via `locked`. That's no longer necessary — checkBoxData already
	// includes catalog organs at load, so insideSegment/insideAllSegments/etc.
	// resolve for them exactly the same way they do for custom classes. The
	// `locked` prop is kept for any future case that genuinely has no scope
	// concept, but nothing currently sets it to true.
	if (locked) {
		return (
			<div className="masking-select">
				<span className="masking-select__label">Applies to</span>
				<div
					className="masking-select__trigger masking-select__trigger--locked"
					style={{ cursor: "default", opacity: 0.75 }}
					title="Existing catalog classes come from the local nifti's ground-truth mask and always apply everywhere"
				>
					<everywhere.Icon size={16} stroke={1.75} />
					<span>{everywhere.label}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="masking-select">
			<span className="masking-select__label">Applies to</span>
			<button
				ref={btnRef}
				type="button"
				className="masking-select__trigger"
				onClick={toggle}
				aria-haspopup="listbox"
				aria-expanded={open}
			>
				<active.Icon size={16} stroke={1.75} />
				<span>{active.label}</span>
				<IconChevronDown
					size={14}
					stroke={1.75}
					className="masking-select__chevron"
					style={{
						marginLeft: "auto",
						opacity: 0.6,
						transition: "transform 0.12s",
						transform: open ? "rotate(180deg)" : "rotate(0deg)",
					}}
				/>
			</button>
			{visible && pos &&
				createPortal(
					<div
						ref={menuRef}
						className={`masking-select__menu ${open ? "is-open" : "is-closing"}`}
						role="listbox"
						style={{ position: "fixed", top: pos.top, right: pos.right, minWidth: pos.width }}
					>
							{OPTIONS.map((o) => {
                                const needsActiveSegment = o.value === "insideSegment" || o.value === "outsideSegment";
                                const needsAnySegments =
                                    o.value === "insideAllSegments" ||
                                    o.value === "outsideAllSegments" ||
                                    o.value === "insideVisibleSegments" ||
                                    o.value === "outsideVisibleSegments";
                                const disabled =
                                    (needsActiveSegment && !hasActiveSegment) ||
                                    (needsAnySegments && !hasAnySegments);
                                return (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="option"
                                        aria-selected={value === o.value}
                                        aria-disabled={disabled}
                                        disabled={disabled}
                                        className={`masking-select__item ${value === o.value ? "is-active" : ""} ${disabled ? "is-disabled" : ""}`}
                                        title={
                                            disabled
                                                ? needsActiveSegment
                                                    ? "Pick or create a class first"
                                                    : "Create at least one class first"
                                                : undefined
                                        }
                                        onClick={() => { if (disabled) return; onChange(o.value); closeMenu(); }}
                                    >
                                        <o.Icon size={16} stroke={1.75} />
                                        <span>{o.label}</span>
                                    </button>
                                );
                            })}
					</div>,
					document.body
				)}
		</div>
	);
}