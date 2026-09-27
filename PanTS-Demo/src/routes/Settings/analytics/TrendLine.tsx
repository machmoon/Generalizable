import { useState } from "react";
import { count, shortDay } from "./format";

// Activity over the range: one series, one line, hover for the day's numbers.
//
// A line rather than bars because the question is the shape of the trend, not
// the comparison of individual days. Single series, so no legend — the panel
// heading names it.

type Point = { day: string; events: number; people: number };

const W = 720;
const H = 160;
const PAD = { top: 12, right: 12, bottom: 22, left: 12 };

const TrendLine: React.FC<{ points: Point[] }> = ({ points }) => {
	const [hover, setHover] = useState<number | null>(null);

	if (points.length < 2) {
		return <p className="dash-empty">Not enough days in this range to draw a trend.</p>;
	}

	const max = Math.max(...points.map((p) => p.events), 1);
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const x = (i: number) => PAD.left + (i / (points.length - 1)) * innerW;
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

	const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.events)}`).join(" ");
	const area = `${line} L${x(points.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;

	// Only the ends are labelled: a date under every point collides as soon as
	// the range is longer than a fortnight.
	const active = hover !== null ? points[hover] : null;

	return (
		<div className="dash-trend">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="dash-trend-svg"
				role="img"
				aria-label={`Events per day, ${shortDay(points[0].day)} to ${shortDay(points[points.length - 1].day)}`}
				onMouseLeave={() => setHover(null)}
			>
				<path d={area} className="dash-trend-area" />
				<path d={line} className="dash-trend-line" />

				{active && (
					<line
						x1={x(hover!)} x2={x(hover!)}
						y1={PAD.top} y2={PAD.top + innerH}
						className="dash-trend-crosshair"
					/>
				)}
				{points.map((p, i) => (
					<circle
						key={p.day}
						cx={x(i)}
						cy={y(p.events)}
						r={hover === i ? 4.5 : 0}
						className="dash-trend-dot"
					/>
				))}

				{/* Hit areas: a full-height column per point, so the line doesn't
				    have to be hit precisely. */}
				{points.map((p, i) => (
					<rect
						key={`hit-${p.day}`}
						x={x(i) - innerW / (points.length - 1) / 2}
						y={PAD.top}
						width={innerW / (points.length - 1)}
						height={innerH}
						fill="transparent"
						onMouseEnter={() => setHover(i)}
					/>
				))}

				<text x={PAD.left} y={H - 6} className="dash-trend-axis">
					{shortDay(points[0].day)}
				</text>
				<text x={W - PAD.right} y={H - 6} textAnchor="end" className="dash-trend-axis">
					{shortDay(points[points.length - 1].day)}
				</text>
			</svg>

			<div className="dash-trend-readout" aria-live="polite">
				{active ? (
					<>
						<strong>{shortDay(active.day)}</strong> · {count(active.events)} events ·{" "}
						{count(active.people)} {active.people === 1 ? "person" : "people"}
					</>
				) : (
					<span className="dash-trend-hint">Hover a day for its numbers</span>
				)}
			</div>
		</div>
	);
};

export default TrendLine;
