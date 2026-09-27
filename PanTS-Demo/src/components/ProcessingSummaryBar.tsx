import React from "react";

// One consolidated bar for all in-flight scans, instead of a card per scan.
// Shows a circular progress wheel (percent complete), a counter (done / total),
// and a status label. Batch total = still-running + already-finished, so as
// scans complete the counter climbs while the total holds steady.
type Props = {
	running: number; // scans still uploading / queued / running
	done: number; // scans finished in this batch
	statusLabel: string; // dominant phase, e.g. "Running…"
	title?: string; // defaults to "Processing scans"
	closeNote?: string; // e.g. "safe to close" - whether the tab is still needed
	closeReady?: boolean; // true once nothing is uploading (tints the note green)
	onViewDetails?: () => void; // per-scan status / view / download for the batch
	onCancelAll?: () => void;
};

const SIZE = 46;
const STROKE = 4;

const ProcessingSummaryBar: React.FC<Props> = ({ running, done, statusLabel, title = "Processing scans", closeNote, closeReady, onViewDetails, onCancelAll }) => {
	const total = running + done;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;

	const r = (SIZE - STROKE) / 2;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - pct / 100);

	return (
		<div className="proc-bar">
			<div className="proc-wheel" style={{ width: SIZE, height: SIZE }}>
				<svg width={SIZE} height={SIZE}>
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="rgba(0,45,114,0.12)"
						strokeWidth={STROKE}
					/>
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="#002D72"
						strokeWidth={STROKE}
						strokeLinecap="round"
						strokeDasharray={circ}
						strokeDashoffset={offset}
						transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
						style={{ transition: "stroke-dashoffset 0.4s ease" }}
					/>
				</svg>
				<span className="proc-wheel-pct">{pct}%</span>
			</div>

			<div className="proc-info">
				<div className="proc-title">
					{title} <span className="proc-counter">{done}/{total}</span>
				</div>
				<div className="proc-sub">
					{/* The spin is "something is still happening" - once nothing is
					    running anymore it should stop, not keep spinning next to
					    "Inference complete" forever. */}
					{running > 0 ? (
						<span className="upload-spinner proc-spinner" />
					) : (
						<span className="proc-done-icon" aria-hidden="true">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<path d="M20 6 9 17l-5-5" />
							</svg>
						</span>
					)}
					{/* One text run, not sibling flex items - otherwise the row's gap
					    opens a hole before the note and wraps it onto its own line. */}
					<span>
						{statusLabel}
						{running > 0 && ` · ${running} in progress`}
						{closeNote && (
							<span className={`proc-close-note${closeReady ? " proc-close-note--ready" : ""}`}>
								{" "}· {closeNote}
							</span>
						)}
					</span>
				</div>
			</div>

			{onViewDetails && (
				<button type="button" className="proc-details-btn" onClick={onViewDetails}>
					View details
				</button>
			)}
			{onCancelAll && (
				<button type="button" className="active-cancel-btn proc-cancel" onClick={onCancelAll}>
					Cancel all
				</button>
			)}
		</div>
	);
};

export default ProcessingSummaryBar;
