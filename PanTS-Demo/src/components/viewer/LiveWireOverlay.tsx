import type { CinePane } from "../../helpers/CornerstoneNifti2";

type Props = {
	pane: CinePane;
	anchorPointsCanvas: Array<[number, number]>; // dense — used for the fill path only
	cornerPointsCanvas: Array<[number, number]>; // one per click — used for the dots
	livePreviewPath: Array<[number, number]> | null;
	/** True when the cursor is currently within closing range of the start point —
	 *  grows/highlights that point so it's obvious where to click to close the shape. */
	nearClose?: boolean;
};


function pathToD(points: Array<[number, number]>, close: boolean): string {
	if (!points.length) return "";
	const d = `M ${points[0][0]} ${points[0][1]} ` + points.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(" ");
	return close ? `${d} Z` : d;
}


function LiveWireOverlay({ anchorPointsCanvas, cornerPointsCanvas, livePreviewPath, nearClose }: Props) {
	return (
		<svg
			className="vp-livewire-overlay"
			style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 30, transform: "translateZ(0)" }}
		>
			{anchorPointsCanvas.length > 1 && (
				<path d={pathToD(anchorPointsCanvas, false)} fill="rgba(34, 211, 238, 0.10)" stroke="#22d3ee" strokeWidth={2} />
			)}
			{livePreviewPath && livePreviewPath.length > 1 && (
				<path d={pathToD(livePreviewPath, false)} fill="none" stroke="#67e8f9" strokeWidth={1.5} strokeDasharray="3,3" />
			)}
			{cornerPointsCanvas.length > 2 && (
				<line
					x1={cornerPointsCanvas[cornerPointsCanvas.length - 1][0]}
					y1={cornerPointsCanvas[cornerPointsCanvas.length - 1][1]}
					x2={cornerPointsCanvas[0][0]}
					y2={cornerPointsCanvas[0][1]}
					stroke="#67e8f9"
					strokeWidth={1}
					strokeDasharray="2,4"
					opacity={0.6}
				/>
			)}
			{/* Pulsing halo behind the start point once the cursor is close enough to close —
			    makes "click here to finish" obvious without any text. */}
			{nearClose && cornerPointsCanvas.length > 2 && (
				<circle
					cx={cornerPointsCanvas[0][0]}
					cy={cornerPointsCanvas[0][1]}
					r={12}
					fill="none"
					stroke="#f43f5e"
					strokeWidth={2}
					opacity={0.55}
					className="vp-livewire-close-pulse"
				/>
			)}
			{cornerPointsCanvas.map((p, i) => {
				const isStart = i === 0;
				const highlightStart = isStart && nearClose && cornerPointsCanvas.length > 2;
				return (
					<circle
						key={`corner-${i}`}
						cx={p[0]}
						cy={p[1]}
						r={highlightStart ? 8 : 4}
						fill={isStart ? "#f43f5e" : "#22d3ee"}
						stroke="#08090b"
						strokeWidth={1.5}
						style={{ transition: "r 0.1s ease" }}
					/>
				);
			})}
		</svg>
	);
}
export default LiveWireOverlay;