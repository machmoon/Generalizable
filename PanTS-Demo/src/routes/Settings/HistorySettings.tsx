import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	formatRelativeTime,
	groupUploads,
	isGroupInFlight,
	loadRecentUploads,
	removeRecentUpload,
	splitByAge,
	type RecentUpload,
	type UploadGroup,
} from "../../helpers/recentUploads";

// History: every scan that's either already been viewed, or has sat unviewed
// for more than a day. The Upload page only keeps unviewed, recent scans so
// it stays a workbench rather than a filing cabinet; everything else lives
// here (see splitByAge).
//
// Reads the same localStorage list the Upload page does, so labels and batch
// grouping carry over. That means history is per-browser — the server's own
// record (GET /api/me/jobs) is only written by the queue path, not the one the
// Upload page actually uses, so it would show an empty list here.
const HistorySettings: React.FC = () => {
	const navigate = useNavigate();
	const [uploads, setUploads] = useState<RecentUpload[]>(() => loadRecentUploads());

	const finished = groupUploads(uploads).filter((g) => !isGroupInFlight(g));
	const { older } = splitByAge(finished);

	const remove = (group: UploadGroup) => {
		const ids =
			group.kind === "single" ? [group.upload.sessionId] : group.uploads.map((u) => u.sessionId);
		let next = uploads;
		ids.forEach((id) => { next = removeRecentUpload(id); });
		setUploads(next);
	};

	const open = (u: RecentUpload) =>
		navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);

	return (
		<div className="set-group">
			<h2 className="set-heading">History</h2>
			<p className="set-sub">
				Scans older than a day. Newer ones stay on the Upload page.
			</p>

			{older.length === 0 ? (
				<div className="set-empty">Nothing here yet.</div>
			) : (
				<div className="set-history-list">
					{older.map((g) => {
						const first = g.kind === "single" ? g.upload : g.uploads[0];
						const label = g.kind === "single" ? g.upload.label : g.label;
						const meta =
							g.kind === "single"
								? `${g.upload.model ? `${g.upload.model} · ` : ""}${g.upload.status} · ${formatRelativeTime(g.timestamp)}`
								: `${g.uploads.filter((u) => u.status === "Completed").length} of ${g.uploads.length} completed · ${formatRelativeTime(g.timestamp)}`;
						const viewable = first.status !== "Failed" && first.status !== "Cancelled";
						return (
							<div key={g.kind === "single" ? g.upload.sessionId : g.batchId} className="set-history-row">
								<div style={{ minWidth: 0 }}>
									<div className="set-history-name">{label}</div>
									<div className="set-history-meta">{meta}</div>
								</div>
								<div className="set-history-actions">
									{viewable && (
										<button type="button" className="set-btn" onClick={() => open(first)}>
											View
										</button>
									)}
									<button type="button" className="set-btn" onClick={() => remove(g)}>
										Remove
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

export default HistorySettings;
