import { useState } from "react";
import "./SegmentEffectPanel.css";
import NumberSliderField from "../NumberSliderField";
import { ActionButton, ActionList, MenuDivider } from "../viewer/FlyoutPrimitives";
import "../viewer/FlyoutPrimitives.css";

export type MarginOperation = "grow" | "shrink";
export type EditableArea = "everywhere" | "insideAllSegments" | "insideVisibleSegments" | "insideSegment" | "outsideAllSegments" | "outsideVisibleSegments";

interface MarginPanelProps {
	onApply: (operation: MarginOperation, marginMm: number) => void;
	actualMm: [number, number, number] | null;
	actualVoxels: [number, number, number] | null;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight, since Margin is a
	 *  one-shot tool rather than an equip-and-use one. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const MAX_MARGIN_MM = 3;
const MIN_MARGIN_MM = 0;
const STEP_MM = 0.1;
const DEFAULT_MARGIN_MM = 1.5;

// Same shape as other one-shot flyouts (Hollow, Smoothing, Islands): one
// slider shared by both directions, then Grow/Shrink as ActionButtons that
// apply immediately rather than picking a persistent mode.
export default function MarginPanel({ onApply, onApplied, onBusyChange }: MarginPanelProps) {
	const [marginMm, setMarginMm] = useState(DEFAULT_MARGIN_MM);
	const [runningOp, setRunningOp] = useState<MarginOperation | null>(null);
	// Which op just finished — held briefly to show its checkmark before
	// onApplied fires and the flyout closes.
	const [successOp, setSuccessOp] = useState<MarginOperation | null>(null);

	const run = (operation: MarginOperation) => {
		if (runningOp || successOp) return;
		setRunningOp(operation);
		onBusyChange?.(true);
		onApply(operation, marginMm);
		// Brief beat before deselecting so Apply doesn't feel instant.
		window.setTimeout(() => {
			setRunningOp(null);
			setSuccessOp(operation);
			window.setTimeout(() => {
				setSuccessOp(null);
				onBusyChange?.(false);
				onApplied?.();
			}, 650);
		}, 750);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 220 }}>
			<NumberSliderField
				label="Margin Size"
				value={marginMm}
				onChange={setMarginMm}
				min={MIN_MARGIN_MM}
				max={MAX_MARGIN_MM}
				step={STEP_MM}
				unit="mm"
				ariaLabel="Margin size in millimeters"
			/>

			<MenuDivider />

			<ActionList>
				{/* Labels track the slider live ("Grow by 1.5mm"); tabular-nums
				    (see .atb-action-btn__label) keeps digits from jittering
				    the button width as the value changes. */}
				<ActionButton
					label={`Grow by ${marginMm.toFixed(1)}mm`}
					runningLabel="Growing…"
					busy={runningOp === "grow"}
					success={successOp === "grow"}
					successLabel="Grown"
					disabled={!!runningOp || !!successOp}
					onClick={() => run("grow")}
				/>
				<ActionButton
					label={`Shrink by ${marginMm.toFixed(1)}mm`}
					runningLabel="Shrinking…"
					busy={runningOp === "shrink"}
					success={successOp === "shrink"}
					successLabel="Shrunk"
					disabled={!!runningOp || !!successOp}
					onClick={() => run("shrink")}
				/>
			</ActionList>
		</div>
	);
}