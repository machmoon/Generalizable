import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { nextPlanUp, planLabel, PLANS, type PlanId } from "../helpers/accountProfile";
import { track } from "../helpers/analytics";
import "./UpgradeDialog.css";

// The one place a plan limit is explained. Every blocker — a locked model, a
// spent quota, a batch the plan won't run — opens this rather than inventing
// its own message, so hitting a wall looks the same everywhere.
//
// Modelled on how Claude and ChatGPT report a limit: name what stopped you in
// one sentence, say when it comes back if it does, list what the next plan up
// gives, and offer exactly two ways out. No feature matrix — that's what the
// plan page is for, and it's one click away.

/** Why the action was refused. Mirrors plan_store's `reason` values, plus the
 *  client-side checks that never reach the server. */
export type UpgradeReason =
	| "model_locked"
	| "daily_scans"
	| "concurrent_scans"
	| "postprocessing"
	| "daily_ai_messages"
	| "create_reports";

export type UpgradeBlock = {
	reason: UpgradeReason;
	/** The server's sentence, when it came from a 402. */
	message?: string;
	/** Model or feature name, for the locked-feature reasons. */
	feature?: string;
	limit?: number;
	used?: number;
	resetsAt?: string | null;
	plan: PlanId;
};

/** "in about 6 hours" / "in 24 minutes", or null once it's passed. */
const resetPhrase = (iso: string | null | undefined): string | null => {
	if (!iso) return null;
	const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
	if (mins <= 0) return null;
	if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
	const hours = Math.round(mins / 60);
	return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
};

const headline = (b: UpgradeBlock): string => {
	switch (b.reason) {
		case "daily_scans":
			return "You've used your scans for today";
		case "daily_ai_messages":
			return "You've used your assistant messages for today";
		case "concurrent_scans":
			return b.limit === 1
				? "One scan at a time on Free"
				: `${b.limit} scans at a time on your plan`;
		case "model_locked":
			return `${b.feature ?? "This model"} needs Pro`;
		case "postprocessing":
			return `${b.feature ?? "Postprocessing"} needs Pro`;
		case "create_reports":
			return "Research summaries need Pro";
	}
};

const detail = (b: UpgradeBlock): string => {
	const reset = resetPhrase(b.resetsAt);
	switch (b.reason) {
		case "daily_scans":
			{
				const perDay = b.limit === 1 ? "one scan" : `${b.limit} scans`;
				return reset
					? `The ${planLabel(b.plan)} plan runs ${perDay} a day. Your next one is available ${reset}.`
					: `The ${planLabel(b.plan)} plan runs ${perDay} a day.`;
			}
		case "daily_ai_messages":
			return reset
				? `The ${planLabel(b.plan)} plan includes ${b.limit} messages a day. More ${reset}.`
				: `The ${planLabel(b.plan)} plan includes ${b.limit} messages a day.`;
		case "concurrent_scans":
			return "Wait for the current scan to finish, or upgrade to run several at once.";
		case "model_locked":
			return `${planLabel(b.plan)} includes LesionSegmenter. Every other model is on Pro.`;
		case "postprocessing":
			return "Postprocessing cleans up and smooths organ outlines after a run.";
		case "create_reports":
			return `${planLabel(b.plan)} can read research summaries and annotations shared with you, but not create them.`;
	}
};

const UpgradeDialog: React.FC<{ block: UpgradeBlock | null; onClose: () => void }> = ({
	block,
	onClose,
}) => {
	const navigate = useNavigate();

	useEffect(() => {
		if (!block) return;
		track("plan_limit_hit");
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [block, onClose]);

	if (!block) return null;

	const target = nextPlanUp(block.plan);
	const targetPlan = target ? PLANS.find((p) => p.id === target) : null;

	return (
		<div className="upg-backdrop" onClick={onClose}>
			<div
				className="upg-card"
				role="dialog"
				aria-modal="true"
				aria-labelledby="upg-title"
				onClick={(e) => e.stopPropagation()}
			>
				<button type="button" className="upg-close" aria-label="Close" onClick={onClose}>×</button>

				<h2 className="upg-title" id="upg-title">{headline(block)}</h2>
				<p className="upg-detail">{detail(block)}</p>

				{targetPlan && (
					<div className="upg-plan">
						<div className="upg-plan-name">{targetPlan.label}</div>
						<ul className="upg-plan-points">
							{targetPlan.points.slice(0, 4).map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					</div>
				)}

				<div className="upg-actions">
					{targetPlan && (
						<button
							type="button"
							className="upg-primary"
							onClick={() => {
								track("plan_limit_dialog_cta");
								onClose();
								navigate("/account/plan");
							}}
						>
							See plan options
						</button>
					)}
					<button type="button" className="upg-secondary" onClick={onClose}>
						Not now
					</button>
				</div>
			</div>
		</div>
	);
};

export default UpgradeDialog;
