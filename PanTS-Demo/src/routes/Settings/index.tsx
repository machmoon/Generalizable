import {
	IconChartBar, IconHeart, IconHistory, IconShieldLock, IconUser, IconUsers,
} from "@tabler/icons-react";
import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import Header from "../../components/Header";
import { useAuth } from "../../contexts/authContext";
import { track } from "../../helpers/analytics";
import { SettingsContext } from "./context";
import "./Settings.css";

// Settings shell: a left nav and a panel, one URL per section.
//
// Replaces the single scrolling page this used to be. The layout follows
// Claude's settings — a narrow rail of sections, and a panel of rows where each
// row is a label on the left and its control on the right, separated by a
// hairline. The old page explained every control in a paragraph underneath it;
// almost all of that prose is gone. "Export data" does not need three lines
// telling you what exporting data is.
//
// Sections own their own content (ProfileSettings, PlanSettings, ...); this
// file owns the chrome, the signed-out redirect, and the shared busy/notice
// state so every action reports success and failure the same way.

// Notifications is deliberately not a section: it's one switch, and a whole
// page for one switch is a mostly-empty panel. It lives on Profile, the way
// Claude keeps small preferences inside General.
type Section = {
	to: string;
	label: string;
	icon: typeof IconUser;
	/** Exact-match the URL, so "/account" isn't active on every child route. */
	end?: boolean;
};

const SECTIONS: Section[] = [
	{ to: "/account", label: "Profile", icon: IconUser, end: true },
	{ to: "/account/plan", label: "Plan", icon: IconHeart },
	{ to: "/account/history", label: "History", icon: IconHistory },
	{ to: "/account/privacy", label: "Privacy", icon: IconShieldLock },
];

// Admin-only sections, appended below the rest so the rail's ordinary shape
// doesn't shift for the people who have them. Hiding these is presentation, not
// protection — both pages and both APIs check the role themselves.
const ADMIN_SECTIONS: Section[] = [
	{ to: "/account/analytics", label: "Usage", icon: IconChartBar },
	{ to: "/account/people", label: "People", icon: IconUsers },
];

const SettingsPage: React.FC = () => {
	const navigate = useNavigate();
	// Once per visit to the settings area, not once per section.
	useEffect(() => {
		track("account_open_settings");
	}, []);
	const { isAuthenticated, loading, promptAuth, user } = useAuth();
	const sections = user?.roles.includes("admin")
		? [...SECTIONS, ...ADMIN_SECTIONS]
		: SECTIONS;

	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");

	// Wait for the initial /me check before deciding. Without the `loading` guard
	// a hard refresh on /account bounces you to the landing page, because the
	// session cookie hasn't been exchanged for a user yet on first render.
	useEffect(() => {
		if (!loading && !isAuthenticated) {
			navigate("/", { replace: true });
			promptAuth();
		}
	}, [loading, isAuthenticated, navigate, promptAuth]);

	// Success messages clear themselves — they confirm something that already
	// happened, so leaving one pinned makes the page look stuck. Errors stay up.
	useEffect(() => {
		if (!notice) return;
		const t = setTimeout(() => setNotice(""), 6000);
		return () => clearTimeout(t);
	}, [notice]);

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
		} finally {
			setBusy(false);
		}
	};

	if (!isAuthenticated) return null;

	return (
		<div className="set-wrapper">
			<Header />
			<main className="set-main">
				<h1 className="set-title">Settings</h1>

				<div className="set-layout">
					<nav className="set-nav" aria-label="Settings sections">
						{sections.map((s) => (
							<NavLink
								key={s.to}
								to={s.to}
								end={s.end}
								className={({ isActive }) =>
									`set-nav-item${isActive ? " set-nav-item--on" : ""}`
								}
							>
								<s.icon size={17} stroke={1.7} aria-hidden="true" />
								{s.label}
							</NavLink>
						))}
					</nav>

					<section className="set-panel">
						{notice && <div className="set-banner">{notice}</div>}
						{error && <div className="set-banner set-banner--error">{error}</div>}
						<SettingsContext.Provider
							value={{ busy, run, notify: setNotice, fail: setError }}
						>
							<Outlet />
						</SettingsContext.Provider>
					</section>
				</div>
			</main>
		</div>
	);
};

export default SettingsPage;
