import { useEffect, useRef, useState } from "react";
import ApplyButton from "../ApplyButton";
import { ActionButton, ActionList, GrandchildRow, MenuColumn, MenuDivider } from "../viewer/FlyoutPrimitives";
import NumberSliderField from "../NumberSliderField";
import type { IslandsOperation } from "../../helpers/CornerstoneNifti2";
import { GuidedStepModal, PickErrorHint, type GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";
import "../viewer/FlyoutPrimitives.css";

interface IslandsPanelProps {
	onApply: (operation: IslandsOperation, minimumSize: number) => void;
	pickingSelectedIsland: boolean;
	onPickSelectedIsland: () => void;
	/** Forgets whatever voxel was previously picked. Called whenever the operation
	 * changes or the target segment/organ changes, since a pick made for one
	 * doesn't carry any guaranteed meaning for another. */
	onResetPick: () => void;
	hasSelectedIsland: boolean;
	/** A voxel was clicked, but it isn't part of the segment this operation runs on. */
	pickedInvalid: boolean;
	/** Identifies the current target segment/organ — watched only to trigger a reset when it changes. */
	targetKey: number | null;
	/** Called right after an operation commits — tells the toolbar to close
	 *  this tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Closes just the small settings flyout (without deselecting the
	 *  Islands tool) the instant a pick-dependent operation starts, so it
	 *  doesn't linger empty behind the full-screen picking overlay. */
	onCloseSettings?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while a
	 *  direct (non-picking) operation is in flight. */
	onBusyChange?: (busy: boolean) => void;
	/** Publishes Exit / Start over for the "keep/remove picked island" flow
	 *  up to the annotation toolbar, exactly like Copy/Fill-across-slices
	 *  and Grow-from-seeds — so all four guided flows share one fixed
	 *  control location in the ribbon instead of each floating its own
	 *  Exit button over the canvas. Publish `null` when not picking. */
	onGuidedControlsChange?: (controls: GuidedFlowControls | null) => void;
}

const MIN_SIZE_VOXELS = 1;
const MAX_SIZE_VOXELS = 20000;

const DIRECT_OPS: { value: IslandsOperation; label: string }[] = [
	{ value: "keepLargest", label: "Keep largest" },
	{ value: "splitToSegments", label: "Split to classes" },
];

const PICK_OPS: { value: IslandsOperation; label: string }[] = [
	{ value: "keepSelected", label: "Keep only picked" },
	{ value: "removeSelected", label: "Remove picked" },
];

const PICK_INSTRUCTION: Record<string, string> = {
	keepSelected: "Click the island to keep. Everything else in this class is removed.",
	removeSelected: "Click the island to remove.",
};

const PICK_STEP_LABEL: Record<string, string> = {
	keepSelected: "Keep only picked island",
	removeSelected: "Remove picked island",
};

export default function IslandsPanel({
	onApply,
	pickingSelectedIsland: _pickingSelectedIsland,
	onPickSelectedIsland,
	onResetPick,
	hasSelectedIsland,
	pickedInvalid,
	targetKey,
	onApplied,
	onCloseSettings,
	onBusyChange,
	onGuidedControlsChange,
}: IslandsPanelProps) {
	const [minimumSize, setMinimumSize] = useState(1000);

	// The Apply button's label shows this instead of `minimumSize` directly,
	// so scrubbing the slider doesn't make the number jump around in the
	// button on every pixel of drag — it eases toward the real value over a
	// few frames instead, and only stops chasing once it's essentially
	// there, so it always settles on the exact number.
	const [displayedSize, setDisplayedSize] = useState(minimumSize);
	useEffect(() => {
		let raf: number;
		const tick = () => {
			setDisplayedSize((prev) => {
				const delta = minimumSize - prev;
				if (Math.abs(delta) < 1) return minimumSize;
				raf = requestAnimationFrame(tick);
				// Ease by a fixed fraction of the remaining distance each
				// frame — fast when far off, gentle as it converges, and
				// never so slow it feels laggy behind a fast slider drag.
				return prev + delta * 0.25;
			});
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [minimumSize]);

	// Which pick-dependent operation is being picked for (keep vs. remove).
	const [pickingFor, setPickingFor] = useState<IslandsOperation | null>(null);

	// Whether the current pick's instruction modal has been dismissed yet.
	// The picker (onPickSelectedIsland) is only armed once acked, so
	// nothing can be picked before "Got it" is pressed.
	const [acked, setAcked] = useState(false);

	// True for the brief window between a valid pick landing and
	// onApplied() firing, so the ribbon doesn't flash back to "waiting for
	// a click" while the tool is mid-deselect.
	const [committing, setCommitting] = useState(false);

	// Position of the most recent click while a pick is live, so an
	// invalid pick's error hint can be pinned right next to it.
	const [errorPos, setErrorPos] = useState<{ x: number; y: number } | null>(null);

	// Confirmation overlay shown once a keep/remove-picked commit lands.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	// Which direct (non-picking) operation is running — drives each
	// ActionButton's own spinner, independent of the ribbon's busy dot.
	const [runningOp, setRunningOp] = useState<IslandsOperation | null>(null);
	const [removingSmall, setRemovingSmall] = useState(false);
	// Which direct op just finished — held briefly to show its checkmark
	// before onApplied fires and the flyout closes.
	const [successOp, setSuccessOp] = useState<IslandsOperation | null>(null);

	// A pick only makes sense for the operation + target segment it was
	// made for — switching either forces a fresh pick.
	const prevTargetRef = useRef(targetKey);
	useEffect(() => {
		if (prevTargetRef.current !== targetKey) {
			onResetPick();
			setPickingFor(null);
			setAcked(false);
		}
		prevTargetRef.current = targetKey;
	}, [targetKey, onResetPick]);

	// Once a valid pick lands mid-flow, commit immediately — the click
	// itself is the commit, there's no separate Apply step. Deliberately
	// doesn't call onBusyChange: `committing` is already published as
	// `busy` via onGuidedControlsChange, and calling both would light up
	// two "something is happening" indicators for one commit. Direct
	// (non-picking) ops below have no guided-flow label, so they're the
	// only ones that still use onBusyChange.
	useEffect(() => {
		if (!pickingFor || !acked) return;
		if (hasSelectedIsland) {
			setCommitting(true);
			onApply(pickingFor, minimumSize);
			onResetPick();
			window.setTimeout(() => {
				setPickingFor(null);
				setAcked(false);
				setCommitting(false);
				setSuccessMessage("Operation completed successfully");
			}, 750);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasSelectedIsland, pickingFor, acked]);

	// Track click position only while genuinely waiting on a pick, to
	// place the inline error hint next to the rejected click.
	const waitingForClick = !!pickingFor && acked && !committing && !hasSelectedIsland;
	useEffect(() => {
		if (!waitingForClick) return;
		const onDown = (e: PointerEvent) => setErrorPos({ x: e.clientX, y: e.clientY });
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, [waitingForClick]);

	useEffect(() => {
		if (!waitingForClick) setErrorPos(null);
	}, [waitingForClick]);

	const startPicking = (op: IslandsOperation) => {
		onResetPick();
		setPickingFor(op);
		setAcked(false);
		setErrorPos(null);
		// Close the settings flyout so it doesn't linger empty behind the
		// full-screen guided modal.
		onCloseSettings?.();
	};

	const acknowledgeStep = () => {
		setAcked(true);
		onPickSelectedIsland();
	};

	// Cancels the pick and fully deselects the tool. Published to the
	// toolbar's fixed Exit button rather than rendered here.
	const exitPicking = () => {
		onResetPick();
		setPickingFor(null);
		setAcked(false);
		setErrorPos(null);
		onApplied?.();
	};

	// Clears whatever's been picked and drops back into "waiting for a
	// click" — this flow has only one step, so there's no modal to re-show.
	const startOver = () => {
		onResetPick();
		setErrorPos(null);
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		onApplied?.();
	};

	useEffect(() => {
		if (!pickingFor || successMessage) {
			onGuidedControlsChange?.(null);
			return;
		}
		onGuidedControlsChange?.({
			label: PICK_STEP_LABEL[pickingFor] ?? "Pick an island",
			onExit: exitPicking,
			onStartOver: startOver,
			busy: committing,
		});
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pickingFor, committing, successMessage]);

	const runDirect = (op: IslandsOperation) => {
		if (runningOp || removingSmall || successOp) return;
		setRunningOp(op);
		onBusyChange?.(true);
		onApply(op, minimumSize);
		window.setTimeout(() => {
			setRunningOp(null);
			setSuccessOp(op);
			window.setTimeout(() => {
				setSuccessOp(null);
				onBusyChange?.(false);
				onApplied?.();
			}, 650);
		}, 750);
	};

	const runRemoveSmall = () => {
		if (runningOp || removingSmall) return;
		setRemovingSmall(true);
		onBusyChange?.(true);
		onApply("removeSmall", minimumSize);
		setRemovingSmall(false);
	};

	// Fires once ApplyButton's success checkmark has had its beat on
	// screen — clears the ribbon's busy dot and deselects.
	const finishRemoveSmall = () => {
		onBusyChange?.(false);
		onApplied?.();
	};

	const DIRECT_LABELS: Record<string, string> = { keepLargest: "Keeping largest…", splitToSegments: "Splitting…" };
	const DIRECT_SUCCESS_LABELS: Record<string, string> = { keepLargest: "Kept largest", splitToSegments: "Split" };
	const PICK_LABELS: Record<string, string> = { keepSelected: "Keep only picked", removeSelected: "Remove picked" };

	if (successMessage) {
		return (
			<GuidedStepModal
				title="Success"
				instruction={successMessage}
				primaryLabel="Got it"
				onPrimary={dismissSuccess}
			/>
		);
	}

	return (
		<>
			<MenuColumn>
				<ActionList>
					{DIRECT_OPS.map((o) => (
						<ActionButton
							key={o.value}
							label={o.label}
							runningLabel={DIRECT_LABELS[o.value]}
							busy={runningOp === o.value}
							success={successOp === o.value}
							successLabel={DIRECT_SUCCESS_LABELS[o.value]}
							disabled={!!runningOp || removingSmall || !!successOp}
							onClick={() => runDirect(o.value)}
						/>
					))}
				</ActionList>

				{/* Pick-dependent operations start the shared guided-flow modal
				    rather than applying instantly — still one-shot actions
				    (ActionButton), just with the actual edit deferred until a
				    valid island is clicked on the canvas. */}
				<ActionList>
					{PICK_OPS.map((o) => (
						<ActionButton
							key={o.value}
							label={PICK_LABELS[o.value] ?? o.label}
							disabled={!!pickingFor}
							onClick={() => startPicking(o.value)}
						/>
					))}
				</ActionList>

				<MenuDivider />

				{/* "Remove small" sits last — it needs its own size threshold,
				    so it stays an expandable row (slider + Apply) rather than a
				    single-click action like everything above it. */}
				<GrandchildRow label="Remove small">
					<NumberSliderField
						label="Min size"
						value={minimumSize}
						onChange={setMinimumSize}
						min={MIN_SIZE_VOXELS}
						max={MAX_SIZE_VOXELS}
						step={50}
						unit="voxels"
						ariaLabel="Minimum island size"
					/>
					<MenuDivider />
					<ApplyButton
					onApply={runRemoveSmall}
					onDone={finishRemoveSmall}
					disabled={removingSmall}
					label={`Remove islands smaller than ${Math.round(displayedSize)} voxels`}
					applyingLabel="Removing…"
					successLabel="Removed"
				/>
				</GrandchildRow>
			</MenuColumn>

			{/* Same "Got it" instruction modal used by Copy/Fill-across-slices
			    and Grow-from-seeds: blocks every canvas click until dismissed,
			    then gets out of the way and lets a real pick land. Exit /
			    Start over now live as fixed buttons in the toolbar ribbon
			    (via onGuidedControlsChange) instead of floating here. */}
			{pickingFor && !acked && (
				<GuidedStepModal
					title={PICK_STEP_LABEL[pickingFor] ?? "Pick an island"}
					instruction={PICK_INSTRUCTION[pickingFor] ?? "Click the island on the canvas."}
					onPrimary={acknowledgeStep}
				/>
			)}

			{pickingFor && acked && pickedInvalid && errorPos && waitingForClick && (
				<PickErrorHint
					message="That voxel isn't part of this class — click inside the class's own island instead."
					x={errorPos.x}
					y={errorPos.y}
				/>
			)}
		</>
	);
}