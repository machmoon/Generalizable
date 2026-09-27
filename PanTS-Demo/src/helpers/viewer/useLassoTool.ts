import { lassoCommitPolygon, type MaskFilter } from "../CornerstoneNifti2";
import { usePolygonDraw } from "./usePolygonDraw";

interface UseLassoToolArgs {
	enabled: boolean;
	maskFilter: MaskFilter;
	onLog?: (detail: string) => void;
}

export function useLassoTool({ enabled, maskFilter, onLog }: UseLassoToolArgs) {
	const draw = usePolygonDraw({
		enabled,
		onClose: (pane, points) => {
			const result = lassoCommitPolygon(pane, points, undefined, maskFilter);
			onLog?.(
				result?.filledVoxels
					? `Lasso fill (${result.filledVoxels.toLocaleString()} vox)`
					: "Lasso: no voxels filled — try a larger loop."
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