import { cutSegmentWithPolygon, computeLiveWirePath, type ScissorsOperation, type MaskFilter } from "../CornerstoneNifti2";
import { usePolygonDraw } from "./usePolygonDraw";

interface UseScissorsToolArgs {
	enabled: boolean;
	operation: ScissorsOperation;
	applyToVisibleSegments: boolean;
	visibleSegmentIndices: number[];
	activeSegmentIndex: number | null;
	maskFilter: MaskFilter; // <-- was missing
	/** When true, every placed point (and the live preview point) snaps onto
	 *  the nearest strong intensity edge within a small radius — the "magnet"
	 *  helper, like Photoshop's magnetic lasso. */
	magnetEnabled?: boolean;
	onLog?: (detail: string) => void;
}

/** Draw a closed shape, cut with it: erase/fill inside or outside, on the drawn slice only. */
export function useScissorsTool({
	enabled, operation, applyToVisibleSegments, visibleSegmentIndices, activeSegmentIndex, maskFilter, magnetEnabled, onLog,
}: UseScissorsToolArgs) {
	const draw = usePolygonDraw({
		enabled,
		// Real Photoshop-style magnetic lasso behavior: between fastening
		// points, the path is the lowest-cost route (Mortensen & Barrett
		// "live wire", via Dijkstra over gradient/Laplacian/direction cost)
		// hugging nearby intensity edges, instead of snapping each raw click
		// onto the nearest edge pixel (which is what made it feel like it was
		// "going wherever it wants" — a single point snap has no notion of a
		// path between points, so it could jump to an unrelated nearby edge).
		computeLivePath: magnetEnabled
			? (pane, from, to) => computeLiveWirePath(pane, from, to)
			: undefined,
		onClose: (pane, points) => {
			if (activeSegmentIndex == null) {
				onLog?.("Scissors: no target segment selected.");
				return;
			}
			const result = cutSegmentWithPolygon(
				pane,
				points,
				{ operation, sliceCut: "unlimited", sliceCutDepthMm: 0, applyToVisibleSegments, visibleSegmentIndices },
				activeSegmentIndex,
				maskFilter // <-- was missing, so it always defaulted to () => true ("everywhere")
			);
			onLog?.(
				result?.changedVoxels
					? `Scissors ${operation} (${result.changedVoxels.toLocaleString()} vox)`
					: "Scissors: no voxels changed — try repositioning the shape."
			);
		},
	});

	return {
		pane: draw.pane,
		anchorsCanvas: draw.points,
		cornersCanvas: draw.corners,
		livePreview: draw.livePreview,
		livePreviewPath: draw.livePreviewPath,
		nearClose: draw.nearClose,
		handleClick: draw.handleClick,
		handleDoubleClick: draw.handleDoubleClick,
		handleMouseMove: draw.handleMouseMove,
		undo: draw.undo,
		cancel: draw.cancel,
		reset: draw.reset,
	};
}