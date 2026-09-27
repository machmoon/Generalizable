// helpers/viewer/usePolygonDraw.ts
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	type CinePane,
} from "../CornerstoneNifti2";
import type { Point3 } from "@cornerstonejs/core/types";

const CLOSE_CLICK_RADIUS_PX = 10;

interface UsePolygonDrawArgs {
	enabled: boolean;
	/** Called with the DENSE fill path (every pixel along every leg, including
	 *  any live-wire detours) once the shape is closed — this is what actually
	 *  gets rasterized/filled. Given as CURRENT-camera canvas points, freshly
	 *  reprojected from the stored world-space path, so a zoom/pan mid-draw
	 *  can't shift which voxels the commit lands on. */
	onClose: (pane: CinePane, points: Array<[number, number]>) => void;
	/** Optional "live wire" hook (e.g. the magnetic edge-snap tool). Given the
	 *  pane and the last fastening point + the current cursor point (both in
	 *  CURRENT canvas-pixel space), returns a dense path from `from` to `to`
	 *  (inclusive) that hugs nearby intensity edges — or null/undefined to
	 *  fall back to a straight line between the two points. Used both for the
	 *  live preview between clicks and to bake the actual leg in once the
	 *  user clicks to drop the next fastening point, exactly like Photoshop's
	 *  magnetic lasso: the cursor doesn't need to trace the boundary exactly,
	 *  the path snaps to it between clicks. */
	computeLivePath?: (
		pane: CinePane,
		from: [number, number],
		to: [number, number]
	) => Array<[number, number]> | null | undefined;
}

// Reproject a world-space path back into the CURRENT camera's canvas-pixel
// space. Called on every render (cheap — just a matrix multiply per point)
// so the drawn overlay and the eventual commit always reflect whatever
// zoom/pan is active right now, not whatever was active when each point was
// originally clicked.
function toCanvas(pane: CinePane, world: Point3[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const w of world) {
		const p = worldToCanvasPoint(pane, w);
		if (p) out.push(p);
	}
	return out;
}

export function usePolygonDraw({ enabled, onClose, computeLivePath }: UsePolygonDrawArgs) {
	// Dense fill path — every pixel along every committed leg (corners plus,
	// when computeLivePath is active, whatever detour the live wire took to
	// hug an edge between two corners) — stored in WORLD space so it stays
	// anchored to the same anatomy across zoom/pan. Reprojected to canvas
	// pixels on demand via `points` below.
	const [pointsWorld, setPointsWorld] = useState<Point3[]>([]);
	// Just the clicked "fastening points" — used for the corner dots and for
	// close-click detection, independent of any live-wire detour. Also
	// world-space for the same reason.
	const [cornersWorld, setCornersWorld] = useState<Point3[]>([]);
	// How many dense points each leg (ending at corners[i+1]) contributed to
	// `pointsWorld`, so undo() can pop exactly one leg's worth back off.
	const legLengthsRef = useRef<number[]>([]);
	const [livePreview, setLivePreview] = useState<[number, number] | null>(null);
	const [livePreviewPath, setLivePreviewPath] = useState<Array<[number, number]> | null>(null);
	// True when the cursor is currently within closing range of the first point —
	// drives the "click here to close" highlight on the start anchor.
	const [nearClose, setNearClose] = useState(false);
	const paneRef = useRef<CinePane | null>(null);

	const reset = useCallback(() => {
		setPointsWorld([]);
		setCornersWorld([]);
		legLengthsRef.current = [];
		setLivePreview(null);
		setLivePreviewPath(null);
		setNearClose(false);
		paneRef.current = null;
	}, []);

	useEffect(() => {
		if (!enabled) reset();
	}, [enabled, reset]);

	// Canvas-space views of the world-space state, reprojected against
	// whatever camera (zoom/pan) is active on THIS render. This is what
	// drives the overlay, so it visually tracks the anatomy through any
	// zoom/pan instead of staying pinned to old pixel coordinates.
	const pane = paneRef.current;
	const points = pane ? toCanvas(pane, pointsWorld) : [];
	const corners = pane ? toCanvas(pane, cornersWorld) : [];

	const close = useCallback(() => {
		const pane = paneRef.current;
		if (!pane || cornersWorld.length < 3) return;
		// Reproject the stored world-space corners/path to CURRENT canvas
		// pixels right before committing — so if the user zoomed/panned
		// partway through drawing, the polygon handed to the commit (and the
		// canvasPointToVoxel conversion it does internally) is consistent
		// with itself, rather than a mix of old and new camera pixels.
		const currentCorners = toCanvas(pane, cornersWorld);
		const currentPoints = toCanvas(pane, pointsWorld);
		const last = currentCorners[currentCorners.length - 1];
		const first = currentCorners[0];
		const closingLeg = computeLivePath?.(pane, last, first);
		const closingPoints = closingLeg && closingLeg.length >= 2 ? closingLeg.slice(1) : [first];
		onClose(pane, [...currentPoints, ...closingPoints]);
		reset();
	}, [pointsWorld, cornersWorld, computeLivePath, onClose, reset]);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const rawPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const rawWorld = canvasPointToWorld(pane, rawPos);
		if (!rawWorld) return;

		if (!paneRef.current) {
			paneRef.current = pane;
			setPointsWorld([rawWorld]);
			setCornersWorld([rawWorld]);
			legLengthsRef.current = [];
			return;
		}
		if (paneRef.current !== pane) return;

		// Close-click detection always uses the raw cursor position against the
		// start corner reprojected to CURRENT canvas space — a live-wire detour
		// (or an intervening zoom) shouldn't change where "click here to close"
		// actually is on screen right now.
		if (cornersWorld.length >= 3) {
			const first = worldToCanvasPoint(pane, cornersWorld[0]);
			if (first && Math.hypot(rawPos[0] - first[0], rawPos[1] - first[1]) < CLOSE_CLICK_RADIUS_PX) {
				close();
				return;
			}
		}

		const lastCanvas = worldToCanvasPoint(pane, cornersWorld[cornersWorld.length - 1]);
		const leg = lastCanvas ? computeLivePath?.(pane, lastCanvas, rawPos) : undefined;
		const legPointsCanvas = leg && leg.length >= 2 ? leg.slice(1) : [rawPos];
		const legPointsWorld = legPointsCanvas
			.map((cp) => canvasPointToWorld(pane, cp))
			.filter((w): w is Point3 => !!w);
		legLengthsRef.current = [...legLengthsRef.current, legPointsWorld.length];
		setPointsWorld((prev) => [...prev, ...legPointsWorld]);
		setCornersWorld((prev) => [...prev, rawWorld]);
	};

	const handleDoubleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || paneRef.current !== pane) return;
		e.preventDefault();
		close();
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || paneRef.current !== pane || !cornersWorld.length) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const rawPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		setLivePreview(rawPos);

		const lastCanvas = worldToCanvasPoint(pane, cornersWorld[cornersWorld.length - 1]);
		const preview = lastCanvas ? computeLivePath?.(pane, lastCanvas, rawPos) : undefined;
		setLivePreviewPath(preview && preview.length >= 2 ? preview : (lastCanvas ? [lastCanvas, rawPos] : null));

		if (cornersWorld.length >= 3) {
			const first = worldToCanvasPoint(pane, cornersWorld[0]);
			setNearClose(!!first && Math.hypot(rawPos[0] - first[0], rawPos[1] - first[1]) < CLOSE_CLICK_RADIUS_PX);
		}
	};

	const undo = () => {
		if (cornersWorld.length <= 1) { reset(); return; }
		const lastLegLen = legLengthsRef.current[legLengthsRef.current.length - 1] ?? 0;
		legLengthsRef.current = legLengthsRef.current.slice(0, -1);
		setPointsWorld((prev) => prev.slice(0, prev.length - lastLegLen));
		setCornersWorld((prev) => prev.slice(0, -1));
	};

	useEffect(() => {
		if (!enabled) return;
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			if (e.key === "Escape" && cornersWorld.length) { e.preventDefault(); reset(); }
			else if (e.key === "Enter" && cornersWorld.length >= 3) { e.preventDefault(); close(); }
			// Ctrl/Cmd+Z removes the last placed point, one at a time — replaces
			// the old "Undo point" button in the flyout with the shortcut users
			// actually reach for. stopImmediatePropagation() (not just
			// preventDefault) is the important part: this listener is on
			// `window`, same target as whatever global shortcut undoes the
			// last committed brush/voxel edit — plain stopPropagation() does
			// NOT stop a sibling listener registered on that same target, only
			// propagation to OTHER elements, so without stopImmediatePropagation
			// a single Ctrl+Z while mid-polygon fired BOTH: this popped the
			// last placed point AND the global handler undid the last brush
			// stroke, as if two Ctrl+Z presses had happened. Placing a
			// scissors point isn't a committed edit yet (nothing touches the
			// labelmap until the shape closes), so it needs to be its own,
			// separate undo step — not bundled into the same history entry as
			// an actual brush stroke.
			else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && cornersWorld.length) {
				e.preventDefault();
				e.stopImmediatePropagation();
				undo();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled, cornersWorld, reset, close]);

	return {
		pane: paneRef.current,
		points,
		corners,
		livePreview,
		livePreviewPath,
		nearClose,
		handleClick,
		handleDoubleClick,
		handleMouseMove,
		undo,
		cancel: reset,
		reset,
	};
}