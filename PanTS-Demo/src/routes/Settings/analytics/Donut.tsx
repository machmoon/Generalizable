import { useId } from "react";
import { count } from "./format";

// A ring chart, for the two splits Wix draws as rings: device, and new vs
// returning. Both are two or three parts of one whole, which is the only shape
// a ring is actually good at — the moment there are eight slices this would be
// the wrong component and a bar list would be the right one.
//
// Hand-drawn with stroke-dasharray rather than arc paths: for a ring of uniform
// thickness the circumference IS the axis, so each slice is one circle with a
// dash pattern and an offset. No path maths, and no charting dependency.
//
// The legend carries the numbers. A ring alone tells you which slice is bigger
// and roughly by how much; the question underneath is usually "how many", and
// reading that off an arc is guesswork.

const SIZE = 132;
const THICKNESS = 18;
const RADIUS = (SIZE - THICKNESS) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Steps of the brand blue, ordered largest-slice-first. Same hue throughout:
// these are parts of one quantity, not different quantities, and hue would
// imply otherwise.
const SHADES = [
	"rgba(0, 45, 114, 0.92)",
	"rgba(0, 45, 114, 0.58)",
	"rgba(0, 45, 114, 0.30)",
	"rgba(0, 45, 114, 0.15)",
];

export type Slice = { label: string; value: number };

const Donut: React.FC<{ slices: Slice[]; empty?: string }> = ({
	slices, empty = "Nothing recorded in this range.",
}) => {
	const titleId = useId();
	const ordered = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
	const total = ordered.reduce((sum, s) => sum + s.value, 0);

	if (!total) return <p className="dash-empty">{empty}</p>;

	// Running offset, so each slice starts where the last one ended. Negative
	// because dashoffset runs backwards around the circle.
	let consumed = 0;

	return (
		<div className="dash-donut">
			<svg
				viewBox={`0 0 ${SIZE} ${SIZE}`}
				className="dash-donut-svg"
				role="img"
				aria-labelledby={titleId}
			>
				<title id={titleId}>
					{ordered.map((s) => `${s.label}: ${count(s.value)}`).join(", ")}
				</title>
				{/* The track, so a single-slice ring still reads as a ring. */}
				<circle
					cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}
					fill="none" stroke="rgba(0, 0, 0, 0.05)" strokeWidth={THICKNESS}
				/>
				{ordered.map((slice, i) => {
					const length = (slice.value / total) * CIRCUMFERENCE;
					const offset = -consumed;
					consumed += length;
					return (
						<circle
							key={slice.label}
							cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}
							fill="none"
							stroke={SHADES[i % SHADES.length]}
							strokeWidth={THICKNESS}
							strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
							strokeDashoffset={offset}
							// Start at twelve o'clock rather than three, which is
							// where every ring chart people have seen starts.
							transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
						/>
					);
				})}
			</svg>

			<ul className="dash-donut-key">
				{ordered.map((slice, i) => (
					<li key={slice.label} className="dash-donut-key-row">
						<span
							className="dash-donut-swatch"
							style={{ background: SHADES[i % SHADES.length] }}
							aria-hidden="true"
						/>
						<span className="dash-donut-label">{slice.label}</span>
						<span className="dash-donut-value">
							{count(slice.value)}
							<span className="dash-donut-pct">
								{Math.round((slice.value / total) * 100)}%
							</span>
						</span>
					</li>
				))}
			</ul>
		</div>
	);
};

export default Donut;
