// helpers/viewer/useLevelTracing.ts
import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToVoxel,
	computeLevelTraceMask,
	commitLevelTraceMask,
	levelTraceMaskToCanvasPath,
	type LevelTraceMask,
	type LevelTraceOperation,
	type MaskFilter,
	type CinePane,
} from "../CornerstoneNifti2";

interface UseLevelTracingArgs {
	enabled: boolean;
	/** Sensitivity in HU — how far from the cursor's own intensity a neighboring
	 *  pixel can be and still count as "the same region". Fed straight into
	 *  computeLevelTraceMask, so dragging the slider actually changes the traced
	 *  area (previously this was ignored in favor of a fixed internal constant). */
	toleranceHu: number;
	operation: LevelTraceOperation;
	activeSegmentIndex: number | null;
	maskFilter: MaskFilter;
	/** Bump this (e.g. pass the toolbar's zoom slider value) whenever the
	 *  pane's camera changes. The traced mask itself is voxel-space and
	 *  camera-independent, but its cached preview OUTLINE is a canvas-pixel
	 *  path computed the moment the mouse last moved — without this, zooming
	 *  without also moving the mouse leaves that outline drawn at the old
	 *  zoom level (visually detached from the anatomy) until the next
	 *  mousemove happens to refresh it. Re-deriving the outline from the
	 *  still-valid traced mask on every camera change keeps it pinned. */
	cameraVersion?: number;
	onLog?: (detail: string) => void;
}

/** Slicer-style level tracing: on hover, flood-fill the connected same-intensity
 *  region under the cursor on the current slice and preview its outline; on
 *  click, commit it into (or out of) the active segment per `operation`. */
export function useLevelTracing({
	enabled, toleranceHu, operation, activeSegmentIndex, maskFilter, cameraVersion, onLog,
}: UseLevelTracingArgs) {
	const [previewPane, setPreviewPane] = useState<CinePane | null>(null);
	const [previewPath, setPreviewPath] = useState<Array<[number, number]> | null>(null);
	// Last computed trace, kept alongside the preview state so a click can reuse
	// it without recomputing when the click point maps to the same voxel.
	const tracedRef = useRef<{ pane: CinePane; mask: LevelTraceMask } | null>(null);

	const clearPreview = () => {
		tracedRef.current = null;
		setPreviewPane(null);
		setPreviewPath(null);
	};

	const computeAt = (pane: CinePane, canvasPos: [number, number]): LevelTraceMask | null => {
		const seed = canvasPointToVoxel(pane, canvasPos);
		if (!seed) return null;
		return computeLevelTraceMask(pane, seed, toleranceHu);
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const traced = computeAt(pane, canvasPos);
		if (!traced) { clearPreview(); return; }
		tracedRef.current = { pane, mask: traced };
		setPreviewPane(pane);
		setPreviewPath(levelTraceMaskToCanvasPath(pane, traced));
	};

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		if (activeSegmentIndex == null) {
			onLog?.("Level tracing: no target segment selected.");
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		// Recompute fresh off the click point rather than trusting a possibly
		// stale hover preview (e.g. a click with no preceding mousemove).
		const traced = computeAt(pane, canvasPos) ?? (tracedRef.current?.pane === pane ? tracedRef.current.mask : null);
		if (!traced) {
			onLog?.("Level tracing: no traceable region under the cursor.");
			return;
		}
		const result = commitLevelTraceMask(pane, traced, activeSegmentIndex, operation, maskFilter);
		onLog?.(
			result?.filledVoxels
				? `Level trace ${operation} (${result.filledVoxels.toLocaleString()} vox)`
				: "Level tracing: no voxels changed — try a different spot or higher sensitivity."
		);
	};

	// Re-derive the outline from the still-valid (voxel-space) traced mask
	// whenever the camera changes, instead of leaving it drawn at whatever
	// canvas pixels it happened to occupy at the last mousemove.
	useEffect(() => {
		const traced = tracedRef.current;
		if (!traced) return;
		setPreviewPath(levelTraceMaskToCanvasPath(traced.pane, traced.mask));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cameraVersion]);

	return {
		handleClick,
		handleMouseMove,
		previewPane,
		previewPath,
	};
}