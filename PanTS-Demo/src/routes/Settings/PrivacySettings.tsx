import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { useSettings } from "./context";

// Privacy: export, and the two destructive actions.
//
// There is no red "danger zone" panel any more. Claude puts "Delete account"
// in a plain row like any other and saves the weight for the confirmation —
// which is the right split: a warning you scroll past every visit stops
// registering, and the moment that actually matters is the click.
//
// Export is deliberately narrow: the account fields you can see on this
// page, nothing internal (no ids, no job rows with server paths). Scans and
// results are not part of it.
const PrivacySettings: React.FC = () => {
	const navigate = useNavigate();
	const { exportData, deleteScanHistory, deleteAccount } = useAuth();
	const { busy, run, notify } = useSettings();

	const [confirming, setConfirming] = useState<"history" | "account" | null>(null);
	const [typed, setTyped] = useState("");

	const word = confirming === "account" ? "DELETE" : "CLEAR";

	const start = (which: "history" | "account") => {
		setConfirming(which);
		setTyped("");
	};

	const confirm = () =>
		run(async () => {
			if (confirming === "history") {
				const count = await deleteScanHistory();
				setConfirming(null);
				setTyped("");
				notify(
					count === 0
						? "You had no scans to delete."
						: `Removed ${count} scan${count === 1 ? "" : "s"} and their results.`
				);
				return;
			}
			await deleteAccount();
			navigate("/", { replace: true });
		});

	return (
		<>
			<div className="set-group">
				<h2 className="set-heading">Your data</h2>

				<div className="set-row">
					<span className="set-row-label">Export account details</span>
					<button type="button" className="set-btn" disabled={busy} onClick={() =>
						run(async () => {
							await exportData();
							notify("Your account details have been downloaded.");
						})
					}>
						Export
					</button>
				</div>

				<div className="set-row">
					<span className="set-row-label">Delete scan history</span>
					<button type="button" className="set-btn set-btn--danger" onClick={() => start("history")}>
						Delete
					</button>
				</div>

				<div className="set-row">
					<span className="set-row-label">Delete account</span>
					<button type="button" className="set-btn set-btn--danger" onClick={() => start("account")}>
						Delete
					</button>
				</div>

				{confirming && (
					<div className="set-confirm" role="alertdialog" aria-label="Confirm">
						<div className="set-confirm-text">
							{confirming === "history" ? (
								<>
									This removes the scans and results shown in your history, along with
									the working files and masks we can associate with them. It doesn't
									remove a de-identified contribution already separated from your
									account, and copies may persist for a time in backups. Your account
									stays. It can't be undone.
								</>
							) : (
								<>
									This signs you out everywhere and schedules your account and its data
									for removal after 30 days. Sign back in before then and everything is
									restored. Removal isn't guaranteed on a specific day, and de-identified
									contributions already separated from your account may remain.
								</>
							)}
							<br />
							Type <strong>{word}</strong> to confirm.
						</div>
						<div className="set-confirm-actions">
							<input
								className="set-input"
								value={typed}
								autoFocus
								aria-label={`Type ${word} to confirm`}
								onChange={(e) => setTyped(e.target.value)}
							/>
							<button
								type="button"
								className="set-btn set-btn--danger"
								disabled={busy || typed.trim() !== word}
								onClick={confirm}
							>
								{busy ? "Working…" : "Confirm"}
							</button>
							<button
								type="button"
								className="set-btn"
								onClick={() => { setConfirming(null); setTyped(""); }}
							>
								Cancel
							</button>
						</div>
					</div>
				)}
			</div>
		</>
	);
};

export default PrivacySettings;
