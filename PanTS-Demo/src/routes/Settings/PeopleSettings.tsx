import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../contexts/authContext";
import { API_BASE } from "../../helpers/constants";
import { track } from "../../helpers/analytics";
import { useSettings } from "./context";
import { titleCase } from "./analytics/format";
import "./analytics/dashboard.css";

// People: every account, and the roles they hold.
//
// Admin-only, checked here as well as on the server — the settings nav hides the
// link for everyone else, but a hidden link is not access control.
//
// Admin is the only role there is. The vocabulary comes from the server
// (body.roles) rather than a list here, so the menu follows whatever the server
// is actually willing to grant.
//
// Every row's actions sit behind one Edit button, and every action behind a
// confirmation. The toggles this replaced were a single click from making a
// stranger an admin — which hands them every account's email address and the
// ability to demote the person who clicked. A control that dangerous should not
// be the same gesture as a checkbox, and it should have to say what it does.

type Person = {
	id: string;
	email: string;
	name: string | null;
	plan: string;
	account_type: string | null;
	created_at: string | null;
	/** Non-null once the account is scheduled for deletion. */
	deletion_requested_at: string | null;
	roles: string[];
};

/** What an Edit menu item does, once confirmed. */
type Action =
	| { kind: "role"; role: string; held: boolean }
	| { kind: "delete" }
	| { kind: "restore" };

const GRACE_DAYS = 30;

const joined = (iso: string | null) => {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** How long is left to change your mind about a deletion. */
const daysLeft = (iso: string | null): number | null => {
	if (!iso) return null;
	const requested = new Date(iso).getTime();
	if (Number.isNaN(requested)) return null;
	const elapsed = (Date.now() - requested) / 86_400_000;
	return Math.max(0, Math.ceil(GRACE_DAYS - elapsed));
};

/** The confirmation text for each action. Written out per case rather than
 *  assembled from fragments: these are the sentences that have to stop someone,
 *  and a template that reads "Remove admin from ... including yours" would be
 *  worse than no warning at all. */
const explain = (person: Person, action: Action): { title: string; body: string } => {
	if (action.kind === "delete") {
		return {
			title: `Delete ${person.email}?`,
			body:
				"They'll be signed out everywhere and won't be able to sign in. The "
				+ `account, its scans and its results can be restored for ${GRACE_DAYS} days — `
				+ "after that they're deleted for good.",
		};
	}
	if (action.kind === "restore") {
		return {
			title: `Restore ${person.email}?`,
			body: "The account becomes usable again and they can sign in as before.",
		};
	}
	return action.held
		? {
			title: `Remove admin from ${person.email}?`,
			body: "They'll lose the usage dashboard and this page, can no longer "
				+ "grant or remove roles, and go back to their plan's limits.",
		}
		: {
			title: `Make ${person.email} an admin?`,
			body: "Admins can see every account's email address and usage data, can "
				+ "grant or remove roles — including yours — and are not held to any "
				+ "plan limit. Only do this for someone you'd trust with the whole "
				+ "site.",
		};
};

const PeopleSettings: React.FC = () => {
	const { user } = useAuth();
	const { fail, notify } = useSettings();
	const isAdmin = !!user?.roles.includes("admin");

	const [query, setQuery] = useState("");
	const [people, setPeople] = useState<Person[]>([]);
	const [roles, setRoles] = useState<string[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// The row being changed, so only its controls go dead rather than the page.
	const [pending, setPending] = useState<string | null>(null);
	// Which row's Edit menu is open, and what it has been asked to do.
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<{ person: Person; action: Action } | null>(null);
	// Delete is the one action that has to be typed out, because it's the one
	// aimed at somebody else's account rather than at a role.
	const [typed, setTyped] = useState("");

	const load = useCallback(async (q: string) => {
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams();
			if (q.trim()) params.set("q", q.trim());
			const res = await fetch(`${API_BASE}/api/admin/people?${params}`, {
				credentials: "include",
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Couldn't load accounts (${res.status}).`);
			}
			const body = await res.json();
			setPeople(body.people);
			setRoles(body.roles);
			setTotal(body.total);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load accounts.");
			setPeople([]);
		} finally {
			setLoading(false);
		}
	}, []);

	// Debounced so typing an email doesn't fire a request per keystroke.
	useEffect(() => {
		if (!isAdmin) return;
		const t = setTimeout(() => load(query), 250);
		return () => clearTimeout(t);
	}, [isAdmin, query, load]);

	// Esc closes whichever of the two is open, innermost first.
	useEffect(() => {
		if (!menuFor && !confirming) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (confirming) { setConfirming(null); setTyped(""); }
			else setMenuFor(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [menuFor, confirming]);

	const start = (person: Person, action: Action) => {
		setMenuFor(null);
		setConfirming({ person, action });
		setTyped("");
	};

	const apply = async () => {
		if (!confirming) return;
		const { person, action } = confirming;
		setPending(person.id);
		try {
			const res = await fetch(requestUrl(person, action), {
				method: requestMethod(action),
				credentials: "include",
				headers: requestBody(action) ? { "Content-Type": "application/json" } : undefined,
				body: requestBody(action),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error || "That didn't work.");

			setPeople((current) => current.map((p) => (p.id === person.id
				? applyToRow(p, action, body)
				: p)));
			setConfirming(null);
			setTyped("");
			notify(outcome(person, action));
			// Spelled out rather than routed through a helper: the server drops
			// any name it doesn't know, and the test that keeps the two lists in
			// step (test_analytics_vocabulary.py) can only see literals.
			if (action.kind === "delete") track("admin_delete_account");
			else if (action.kind === "restore") track("admin_restore_account");
			else track(action.held ? "admin_revoke_role" : "admin_grant_role");
		} catch (e) {
			fail(e instanceof Error ? e.message : "That didn't work.");
		} finally {
			setPending(null);
		}
	};

	if (!isAdmin) {
		return (
			<div className="set-group">
				<h2 className="set-heading">People</h2>
				<p className="set-sub">You need an admin account to see this.</p>
			</div>
		);
	}

	return (
		<div className="dash">
			<div className="set-group">
				<h2 className="set-heading">People</h2>
				<p className="set-sub">
					Every account, and what it can do. Admins see usage, manage roles, and
					are not held to any plan limit.
				</p>

				<input
					type="search"
					className="set-input"
					placeholder="Search by email or name"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					aria-label="Search accounts"
				/>
			</div>

			{error && <div className="set-banner set-banner--error dash-banner">{error}</div>}

			{loading && !people.length && <p className="dash-empty">Loading…</p>}

			{!loading && !people.length && !error && (
				<p className="dash-empty">
					{query ? `No account matches "${query}".` : "No accounts yet."}
				</p>
			)}

			{people.map((person) => {
				const isYou = person.id === user?.id;
				const left = daysLeft(person.deletion_requested_at);
				const menuOpen = menuFor === person.id;
				const confirm = confirming?.person.id === person.id ? confirming : null;

				return (
					<div className="dash-person-block" key={person.id}>
						<div className="set-row dash-person">
							<span className="set-row-label">
								{person.email}
								{isYou && <span className="dash-you"> you</span>}
								<span className="set-row-note">
									{[
										person.name,
										titleCase(person.plan),
										person.roles.length ? person.roles.join(" · ") : "No roles",
										joined(person.created_at),
									].filter(Boolean).join(" · ")}
								</span>
								{left !== null && (
									<span className="dash-scheduled">
										Scheduled for deletion · {left} {left === 1 ? "day" : "days"} left to restore
									</span>
								)}
							</span>
							<button
								type="button"
								className="set-btn"
								// Without the email, every row's button is announced
								// identically — a screen reader hears "Edit" a dozen times
								// with no way to tell whose it is.
								aria-label={`Edit ${person.email}`}
								aria-expanded={menuOpen}
								disabled={pending === person.id}
								onClick={() => setMenuFor(menuOpen ? null : person.id)}
							>
								Edit
							</button>
						</div>

						{menuOpen && (
							<div className="dash-menu" role="group" aria-label={`Actions for ${person.email}`}>
								{roles.map((role) => {
									const held = person.roles.includes(role);
									return (
										<button
											key={role}
											type="button"
											className="dash-menu-item"
											onClick={() => start(person, { kind: "role", role, held })}
										>
											{held ? `Remove ${role}` : `Make ${role}`}
										</button>
									);
								})}
								<div className="dash-menu-rule" />
								{person.deletion_requested_at ? (
									<button
										type="button"
										className="dash-menu-item"
										onClick={() => start(person, { kind: "restore" })}
									>
										Restore account
									</button>
								) : (
									<button
										type="button"
										className="dash-menu-item dash-menu-item--danger"
										onClick={() => start(person, { kind: "delete" })}
									>
										Delete account
									</button>
								)}
							</div>
						)}

						{confirm && <ConfirmPanel
							person={confirm.person}
							action={confirm.action}
							typed={typed}
							setTyped={setTyped}
							busy={pending === person.id}
							onCancel={() => { setConfirming(null); setTyped(""); }}
							onConfirm={apply}
						/>}
					</div>
				);
			})}

			{total > people.length && (
				<p className="dash-empty">
					Showing {people.length} of {total}. Search to narrow it down.
				</p>
			)}
		</div>
	);
};

// ---- the confirmation ------------------------------------------------------

const ConfirmPanel: React.FC<{
	person: Person;
	action: Action;
	typed: string;
	setTyped: (v: string) => void;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}> = ({ person, action, typed, setTyped, busy, onCancel, onConfirm }) => {
	const { title, body } = explain(person, action);
	const needsTyping = action.kind === "delete";
	const armed = !needsTyping || typed.trim().toLowerCase() === person.email.toLowerCase();
	const danger = action.kind === "delete"
		|| (action.kind === "role" && action.role === "admin" && !action.held);

	return (
		<div className="set-confirm dash-confirm" role="alertdialog" aria-label={title}>
			<div className="set-confirm-text">
				<strong>{title}</strong>
				<br />
				{body}
				{needsTyping && (
					<>
						<br />
						Type <strong>{person.email}</strong> to confirm.
					</>
				)}
			</div>
			<div className="set-confirm-actions">
				{needsTyping && (
					<input
						className="set-input"
						value={typed}
						autoFocus
						aria-label={`Type ${person.email} to confirm`}
						onChange={(e) => setTyped(e.target.value)}
					/>
				)}
				<button
					type="button"
					className={`set-btn${danger ? " set-btn--danger" : ""}`}
					disabled={busy || !armed}
					onClick={onConfirm}
				>
					{busy ? "Working…" : confirmLabel(action)}
				</button>
				<button type="button" className="set-btn" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
};

// ---- what each action sends, and what it means -----------------------------

const requestUrl = (person: Person, action: Action) => {
	const base = `${API_BASE}/api/admin/people/${person.id}`;
	if (action.kind === "delete") return base;
	if (action.kind === "restore") return `${base}/restore`;
	return action.held ? `${base}/roles/${action.role}` : `${base}/roles`;
};

const requestMethod = (action: Action) => {
	if (action.kind === "delete") return "DELETE";
	if (action.kind === "restore") return "POST";
	return action.held ? "DELETE" : "POST";
};

const requestBody = (action: Action) =>
	action.kind === "role" && !action.held
		? JSON.stringify({ role: action.role })
		: undefined;

/** Fold the server's answer into the row. Role changes trust the server's list
 *  rather than assuming the change took — it refuses some revokes, and this is
 *  the row that has to show it. */
const applyToRow = (person: Person, action: Action, body: { roles?: string[] }): Person => {
	if (action.kind === "role") return { ...person, roles: body.roles ?? person.roles };
	return {
		...person,
		deletion_requested_at: action.kind === "delete" ? new Date().toISOString() : null,
	};
};

const confirmLabel = (action: Action) => {
	if (action.kind === "delete") return "Delete account";
	if (action.kind === "restore") return "Restore account";
	return action.held ? `Remove ${action.role}` : `Make ${action.role}`;
};

const outcome = (person: Person, action: Action) => {
	if (action.kind === "delete") {
		return `${person.email} is scheduled for deletion and has been signed out.`;
	}
	if (action.kind === "restore") return `${person.email} has been restored.`;
	return action.held
		? `Removed ${action.role} from ${person.email}.`
		: `${person.email} is now an ${action.role}.`;
};

export default PeopleSettings;
