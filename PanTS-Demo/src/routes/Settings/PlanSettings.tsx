import { IconCheck } from "@tabler/icons-react";
import React, { useState } from "react";
import { useAuth } from "../../contexts/authContext";
import {
	canChangePlan,
	PLANS,
	planLabel,
	type PlanGroup,
	type PlanId,
} from "../../helpers/accountProfile";
import { track } from "../../helpers/analytics";
import { useSettings } from "./context";

/** "in 6 hrs" / "in 24 min" from an ISO timestamp, or null once it's passed. */
const untilLabel = (iso: string | null): string | null => {
	if (!iso) return null;
	const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
	if (mins <= 0) return null;
	if (mins < 60) return `Resets in ${mins} min`;
	const hours = Math.round(mins / 60);
	return `Resets in ${hours} hr${hours === 1 ? "" : "s"}`;
};

const UsageBar: React.FC<{
	label: string;
	used: number;
	limit: number | null;
	resetsAt: string | null;
	/** What to say before the window has started (nothing used yet). */
	idleNote: string;
}> = ({ label, used, limit, resetsAt, idleNote }) => {
	const pct = limit === null ? 0 : Math.min(100, Math.round((used / limit) * 100));
	const spent = limit !== null && used >= limit;
	// resets_at is null until the first event lands, so an untouched allowance
	// would otherwise show a bare label with no hint of how the window works.
	const reset = untilLabel(resetsAt) ?? (limit === null ? null : idleNote);
	return (
		<div className="set-usage">
			<span className="set-usage-label">
				{label}
				{reset && <span className="set-usage-reset">{reset}</span>}
			</span>
			<div className="set-usage-track">
				<div
					className={`set-usage-fill${spent ? " set-usage-fill--full" : ""}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="set-usage-count">
				{limit === null ? "Unlimited" : `${used} of ${limit}`}
			</span>
		</div>
	);
};

// Plan: what you're on, what you've used of it, and the picker.
//
// The picker is Claude's upgrade page — an Individual / Team and Enterprise
// segmented toggle over two cards each. Four plans side by side was the old
// version's mistake: nobody compares four columns of paragraphs.
//
// No payment: /me/plan is a column write. The limits are real either way.
//
// The paid plans aren't open yet, so their cards are greyed and their buttons
// say so. Admins are the exception at both ends: they can still move an account
// between plans, and their own limits are lifted whichever plan they sit on.
const PlanSettings: React.FC = () => {
	const { user, usage, setPlan, refreshUsage } = useAuth();
	const { busy, run, notify } = useSettings();
	const [group, setGroup] = useState<PlanGroup>("individual");

	if (!user) return null;

	// The effective plan: /me/usage reports the verified-researcher promotion,
	// which the stored column deliberately never records.
	const current = ((usage?.plan as PlanId | undefined) ?? user.plan);
	const currentPlan = PLANS.find((p) => p.id === current);
	const canChange = canChangePlan(user);

	const choose = (id: PlanId) =>
		run(async () => {
			track("account_change_plan");
			await setPlan(id);
			await refreshUsage();
			notify(`You're on ${planLabel(id)}.`);
		});

	return (
		<>
			<div className="set-group">
				<div className="set-plan-hero">
					<div>
						<h2 className="set-plan-name">{planLabel(current)} plan</h2>
						<p className="set-plan-blurb">
							{canChange
								? "Admin access — no limits apply, whatever plan you're on."
								: currentPlan?.blurb}
						</p>
					</div>
					<button
						type="button"
						className="set-btn"
						onClick={() =>
							document.getElementById("change-plan")?.scrollIntoView({ behavior: "smooth" })
						}
					>
						Change plan
					</button>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Usage</h2>
				<p className="set-sub">Rolling 24 hours.</p>
				{usage ? (
					<>
						<UsageBar
							label="Scans"
							used={usage.scans.used}
							limit={usage.scans.limit}
							resetsAt={usage.scans.resets_at}
							idleNote="Resets 24h after your first scan"
						/>
						<UsageBar
							label="Assistant messages"
							used={usage.ai_messages.used}
							limit={usage.ai_messages.limit}
							resetsAt={usage.ai_messages.resets_at}
							idleNote="Resets 24h after your first message"
						/>
					</>
				) : (
					<p className="set-sub">Loading…</p>
				)}
			</div>

			<div className="set-group set-plan-picker" id="change-plan">
				<h2 className="set-heading">Change plan</h2>

				<div className="set-segmented" role="tablist" aria-label="Plan type">
					{([
						["individual", "Individual"],
						["team", "Team and Enterprise"],
					] as const).map(([id, label]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={group === id}
							className={`set-segmented-btn${group === id ? " set-segmented-btn--on" : ""}`}
							onClick={() => setGroup(id)}
						>
							{label}
						</button>
					))}
				</div>

				<div className="set-plan-cards">
					{PLANS.filter((p) => p.group === group).map((p) => {
						const isCurrent = p.id === current;
						// Free stays pickable for everyone — it's the one plan that is
						// open, and nobody should be stranded above it.
						const soon = !canChange && p.id !== "free" && p.id !== "pro";
						// Pro is earned (verified email + complete profile), never
						// clicked into - except by admins moving accounts for testing.
						const lockedPro = p.id === "pro" && !canChange && !isCurrent;
						return (
							<div
								key={p.id}
								className={`set-plan-card${isCurrent ? " set-plan-card--current" : ""}${
									soon ? " set-plan-card--soon" : ""
								}`}
							>
								{p.badge && <span className="set-plan-badge">{p.badge}</span>}
								<h3 className="set-plan-card-name">{p.label}</h3>
								<p className="set-plan-card-blurb">{p.blurb}</p>
								<div className="set-plan-price">
									{p.price}
									{p.priceNote && <span className="set-plan-price-note">{p.priceNote}</span>}
								</div>
								<button
									type="button"
									className={`set-plan-cta${isCurrent ? " set-plan-cta--current" : ""}`}
									disabled={isCurrent || soon || busy || lockedPro}
									onClick={() => choose(p.id)}
								>
									{isCurrent
										? "Current plan"
										: soon
											? "Coming soon"
											: lockedPro
												? "Verify to unlock"
												: p.cta}
								</button>
								<ul className="set-plan-points">
									{/* Every card gets a lead line, including the one that
									    inherits nothing, so the bullet lists start at the
									    same height across the row. */}
									<li className="set-plan-inherits">
										{p.inherits
											? `Everything in ${planLabel(p.inherits)}, plus:`
											: p.pointsLead}
									</li>

									{p.points.map((pt) => (
										<li key={pt}>
											<IconCheck size={13} stroke={2.5} /> {pt}
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>
			</div>
		</>
	);
};

export default PlanSettings;
