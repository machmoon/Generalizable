import { useCallback, useRef } from "react";
import { setReferenceLinesEnabled, type CinePane } from "../CornerstoneNifti2";

type ViewMode = "mpr" | "axial" | "sagittal" | "coronal" | "3d";

interface UseFocusedPaneArgs {
	viewMode: ViewMode;
	referenceLinesOn: boolean;
	onInteraction?: () => void;
}

/**
 * Tracks which MPR pane is "focused": the fullscreen pane in a single 2D
 * view, or whichever of the three panes was most recently scrolled/clicked
 * while in MPR grid view. Used by every single-pane tool: reference lines'
 * source, cine playback, flip, rotate.
 */
export function useFocusedPane({ viewMode, referenceLinesOn, onInteraction }: UseFocusedPaneArgs) {
	// A ref, not state: a wheel tick shouldn't force a re-render, and reading
	// .current at call time is always fresh regardless of when the enclosing
	// closure was created.
	const activePaneRef = useRef<CinePane>("axial");

	// Memoized so callers (e.g. VisualizationPage's toggleCine useCallback) can
	// safely list it in a dependency array without it changing identity every
	// render — only viewMode changes actually need to invalidate it.
	const getFocusedPane = useCallback((): CinePane => {
		return viewMode === "axial" || viewMode === "sagittal" || viewMode === "coronal"
			? viewMode
			: activePaneRef.current;
	}, [viewMode]);

	// Guarded on the pane actually changing: a wheel gesture fires this once
	// per slice (dozens of times while scrolling the SAME pane), and
	// re-running setReferenceLinesEnabled on every tick — a full disable/
	// enable + re-render of all three viewports — for a source that hasn't
	// changed shows up as the dotted lines flickering during a normal scroll.
	const handleFocus = useCallback(
		(pane: CinePane) => {
			const paneChanged = activePaneRef.current !== pane;
			activePaneRef.current = pane;
			if (referenceLinesOn && paneChanged) setReferenceLinesEnabled(true, pane);
		},
		[referenceLinesOn]
	);

	const handleWheel = useCallback((pane: CinePane) => () => {
		onInteraction?.();
		handleFocus(pane);
	}, [handleFocus, onInteraction]);
	const handleMouseDown = useCallback((pane: CinePane) => () => {
		onInteraction?.();
		handleFocus(pane);
	}, [handleFocus, onInteraction]);

	return { activePaneRef, getFocusedPane, handleFocus, handleWheel, handleMouseDown };
}
