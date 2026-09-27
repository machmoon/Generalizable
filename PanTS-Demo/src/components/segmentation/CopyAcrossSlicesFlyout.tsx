import { useEffect, useState } from "react";
import "./SegmentEffectPanel.css"
import { copySegmentAcrossSlices, setPaneSliceIndex, pickSliceAnchorAtClientPoint } from "../../helpers/CornerstoneNifti2";import type { MaskFilter, CinePane } from "../../helpers/CornerstoneNifti2";
import { useSliceAnchorPicker } from "../../helpers/viewer/useSliceAnchorPicker";
import { GuidedStepModal, PickErrorHint, formatAnchor, type GuidedFlowControls } from "./SliceAnchorPickerUI";

interface Props {
	pane: CinePane;
	totalSlices: number;
	segmentIndex: number;
	maskFilter: MaskFilter;
	onLog?: (detail: string) => void;
	onApplied?: () => void;
	onCloseSettings?: () => void;
	onGuidedControlsChange?: (controls: GuidedFlowControls | null) => void;
}

export default function CopyAcrossSlicesFlyout({ segmentIndex, maskFilter, onLog, onApplied, onCloseSettings, onGuidedControlsChange }: Props) {
	const [pickError, setPickError] = useState<string | null>(null);
	const [errorPos, setErrorPos] = useState<{ x: number; y: number } | null>(null);
	const [ackFirst, setAckFirst] = useState(false);
	const [ackLast, setAckLast] = useState(false);
	// True while a commit is in flight, so the step-1 modal can't briefly
	// re-render between picker.reset() and the success overlay showing.
	const [finishing, setFinishing] = useState(false);
	// Confirmation overlay shown once the copy commits, instead of the
	// tool silently closing after Apply.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const picker = useSliceAnchorPicker({
		segmentIndex,
		lastRequiresSegment: false,
		onError: (d) => { setPickError(d); onLog?.(d); },
	});
	const { phase, step, first, last } = picker;

	useEffect(() => {
		setPickError(null);
		setErrorPos(null);
	}, [phase, step, first, last]);

	useEffect(() => {
		if (phase === "idle") picker.startPicking();
		onCloseSettings?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const waitingForClick = !finishing && ((step === "first" && ackFirst && !first) || (step === "last" && ackLast && !last));

	useEffect(() => {
		if (!waitingForClick) return;
		const onDown = (e: PointerEvent) => {
			// Only show/reposition the error hint for clicks that land on a
			// pane; a click outside every viewport dismisses any stale hint.
			const hit = pickSliceAnchorAtClientPoint(e.clientX, e.clientY);
			if (!hit) {
				setPickError(null);
				setErrorPos(null);
				return;
			}
			setErrorPos({ x: e.clientX, y: e.clientY });
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, [waitingForClick]);

	const run = () => {
		if (!first || !last) return;
		setFinishing(true);
		const result = copySegmentAcrossSlices(first.pane, first.sliceIndex, last.sliceIndex, segmentIndex, maskFilter);
		if (result?.changedVoxels) {
			onLog?.(`Copied across ${result.slicesWritten} slices (${result.changedVoxels.toLocaleString()} vox)`);
			setPaneSliceIndex(last.pane, last.sliceIndex);
			picker.reset();
			setAckFirst(false);
			setAckLast(false);
			setSuccessMessage("Operation completed successfully");
		} else {
			onLog?.("Copy failed — draw the shape fully on the first slice first.");
			// Nothing committed — stay on the "ready to copy" step so they
			// can retry without re-picking the range.
			setFinishing(false);
		}
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		setFinishing(false);
		onApplied?.();
	};

	const exit = () => {
		picker.cancelPicking();
		picker.reset();
		setAckFirst(false);
		setAckLast(false);
		onApplied?.();
	};

	const startOver = () => {
		picker.reset();
		setAckFirst(false);
		setAckLast(false);
		setPickError(null);
		if (picker.phase !== "picking") picker.startPicking();
	};
	useEffect(() => {
		onGuidedControlsChange?.({ label: "Copy across slices", onExit: exit, onStartOver: startOver, busy: finishing });
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, first, last, finishing]);

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

	if (finishing) return null;

	return (
		<>
			{step === "first" && !ackFirst && (
				<GuidedStepModal
					title="Copy across slices"
					instruction="Click the shape to copy FROM."
					onPrimary={() => setAckFirst(true)}
				/>
			)}
			{step === "last" && first && !ackLast && (
				<GuidedStepModal
					title="Copy across slices"
					instruction="Click the slice to copy UP TO."
					onPrimary={() => setAckLast(true)}
				/>
			)}
			{phase === "ready" && first && last && (
				<GuidedStepModal
					title="Ready to copy"
					instruction={`Copying the shape from ${formatAnchor(first)} across to ${formatAnchor(last)}.`}
					primaryLabel="Copy across slices"
					onPrimary={run}
				/>
			)}
			{pickError && errorPos && waitingForClick && (
				<PickErrorHint message={pickError} x={errorPos.x} y={errorPos.y} />
			)}
		</>
	);
}