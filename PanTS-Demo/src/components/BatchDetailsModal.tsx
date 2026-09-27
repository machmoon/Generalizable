import React, { useEffect } from "react";
import { formatRelativeTime, recentStatusColor, type RecentUpload } from "../helpers/recentUploads";
import "./BatchDetailsModal.css";

// Popup listing every scan in a batch, each with its own status / View / Download
// — the same affordances an individual completed upload gets. Takes up most of
// the screen (not all) and closes via the X or a backdrop click / Esc.
type Props = {
	label: string;
	uploads: RecentUpload[];
	onClose: () => void;
	onView: (upload: RecentUpload) => void;
	onDownloadScan: (upload: RecentUpload) => void;
	onDownloadAll: () => void;
};

// Only a finished scan can be viewed/downloaded; a still-processing one just
// shows its status (this modal is now reachable from a live batch too).
const isDone = (s: RecentUpload["status"]) => s === "Completed";

const BatchDetailsModal: React.FC<Props> = ({
	label,
	uploads,
	onClose,
	onView,
	onDownloadScan,
	onDownloadAll,
}) => {
	// Close on Esc.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	const done = uploads.filter((u) => u.status === "Completed").length;

	return (
		<div className="bdm-backdrop" onClick={onClose}>
			<div
				className="bdm-panel"
				role="dialog"
				aria-modal="true"
				aria-label={`${label} details`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="bdm-header">
					<div>
						<div className="bdm-title">{label}</div>
						<div className="bdm-subtitle">
							{done}/{uploads.length} complete
						</div>
					</div>
					<div className="bdm-header-actions">
						<button type="button" className="bdm-download-all" onClick={onDownloadAll}>
							Download all
						</button>
						<button type="button" className="bdm-close" aria-label="Close" onClick={onClose}>
							×
						</button>
					</div>
				</div>

				<div className="bdm-list">
					{uploads.map((u) => {
						const done = isDone(u.status);
						return (
							<div key={u.sessionId} className="bdm-row">
								<div className="bdm-row-main">
									<div className="bdm-row-title">{u.label}</div>
									<div className="bdm-row-sub">
										{u.model ? `${u.model} · ` : ""}
										{formatRelativeTime(u.timestamp)}
									</div>
								</div>
								<div className="bdm-row-actions">
									<span className="bdm-status" style={{ color: recentStatusColor(u.status) }}>
										{u.status}
									</span>
									{done && (
										<>
											<button type="button" className="bdm-btn" onClick={() => onView(u)}>
												View
											</button>
											<button type="button" className="bdm-btn" onClick={() => onDownloadScan(u)}>
												Download
											</button>
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};

export default BatchDetailsModal;
