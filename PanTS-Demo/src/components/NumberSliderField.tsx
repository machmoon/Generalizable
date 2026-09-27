import { useEffect, useState } from "react";

interface NumberSliderFieldProps {
	label?: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step: number;
	unit?: string;
	ariaLabel?: string;
	/** Optional: fires true while the slider (not the text box) is actively
	 *  being dragged/focused, false when released — for tools like the
	 *  brush diameter that show a live preview only while adjusting. */
	onPreviewChange?: (active: boolean) => void;
}

/**
 * Slider + typable number box, shared by every panel that takes a numeric
 * parameter (margin mm, smoothing kernel, level-tracing tolerance, brush
 * diameter, ...).
 *
 * The number lives in exactly one place — the typable box — with its unit
 * printed right after it. The label above is just a static caption; it does
 * not repeat the value, so nothing is shown twice.
 *
 * The box owns its own draft string while focused, independent of the
 * committed value, and only parses/clamps on blur or Enter. That's what
 * makes decimals typable: clearing "3" to type "2.5" no longer round-trips
 * through `Number("")` → 0 and snaps back to a lone "0" mid-keystroke.
 */
export default function NumberSliderField({
	label, value, onChange, min, max, step, unit, ariaLabel, onPreviewChange,
}: NumberSliderFieldProps) {
	const [draft, setDraft] = useState(String(value));
	const [focused, setFocused] = useState(false);

	// Stay in sync with external changes (slider drags, resets) — but never
	// stomp on what the user is actively typing.
	useEffect(() => {
		if (!focused) setDraft(String(value));
	}, [value, focused]);

	const clamp = (v: number) => Math.min(max, Math.max(min, v));

	const commit = () => {
		const parsed = parseFloat(draft);
		if (Number.isNaN(parsed)) {
			setDraft(String(value));
			return;
		}
		const clamped = clamp(parsed);
		onChange(clamped);
		setDraft(String(clamped));
	};

	return (
		<div className="atb-flyout__section">
			{label && <span className="atb-flyout__label">{label}</span>}
			<div className="atb-flyout__slider-row">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					onPointerDown={() => onPreviewChange?.(true)}
					onPointerUp={() => onPreviewChange?.(false)}
					onFocus={() => onPreviewChange?.(true)}
					onBlur={() => onPreviewChange?.(false)}
					className="atb-flyout__range"
					aria-label={ariaLabel}
				/>
				<div className="atb-flyout__slider-readout">
					<input
						type="text"
						inputMode="decimal"
						className="seg-effect__number seg-effect__number--compact"
						value={draft}
						onFocus={() => setFocused(true)}
						onChange={(e) => {
							const v = e.target.value;
							// Let the user freely type a number-in-progress: digits, one
							// optional leading minus (only if the range allows negatives),
							// one decimal point. Reject anything else instead of coercing it.
							const pattern = min < 0 ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/;
							if (v === "" || pattern.test(v)) setDraft(v);
						}}
						onBlur={() => { setFocused(false); commit(); }}
						onKeyDown={(e) => {
							if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
							if (e.key === "Escape") { setDraft(String(value)); (e.target as HTMLInputElement).blur(); }
						}}
						aria-label={ariaLabel ? `${ariaLabel} exact value` : "Exact value"}
					/>
					{unit && <span className="seg-effect__unit">{unit}</span>}
				</div>
			</div>
		</div>
	);
}