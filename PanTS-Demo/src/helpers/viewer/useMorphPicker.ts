import { useEffect, useState, type MouseEvent } from "react";
import { canvasPointToVoxel, type CinePane } from "../CornerstoneNifti2";

interface UseMorphPickerArgs {
	/** Reset the picker whenever the owning panel closes. */
	panelOpen: boolean;
	onLog?: (detail: string) => void;
}

/**
 * "Pick an island" targeting for morphological mask edits (dilate/erode).
 * `scope` selects whether the op applies to the whole segment or just the
 * connected island under the picked voxel; `seedVoxel` is that voxel once
 * a pick has been made.
 */
export function useMorphPicker({ panelOpen, onLog }: UseMorphPickerArgs) {
	const [scope, setScope] = useState<"segment" | "island">("segment");
	const [picking, setPicking] = useState(false);
	const [seedVoxel, setSeedVoxel] = useState<[number, number, number] | null>(null);

	// The edit panel is a shared right-side slot with other tools — closing it
	// (or switching away from it) should always cancel an in-progress pick.
	useEffect(() => {
		if (!panelOpen) {
			setPicking(false);
			setSeedVoxel(null);
		}
	}, [panelOpen]);

	const startPicking = () => {
		setSeedVoxel(null);
		setPicking(true);
	};

	const handlePaneClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!picking) return;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const voxel = canvasPointToVoxel(pane, [e.clientX - rect.left, e.clientY - rect.top]);
		if (!voxel) return;
		setSeedVoxel(voxel);
		setPicking(false);
		onLog?.("Picked an island for morphology");
	};

	return { scope, setScope, picking, startPicking, seedVoxel, handlePaneClick };
}