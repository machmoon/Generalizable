// Real authentication against the Flask backend (B1 email/password + B2 OAuth).
//
// The session lives in an httponly cookie the JS can't read, so on mount we ask
// GET /api/auth/me to restore it; sign in/up/out hit the auth endpoints. Every
// request uses credentials:"include" so the cookie is sent (also cross-origin in
// dev). This is the single seam the whole account UI reads through.
//
// OAuth is a full-page redirect, not a fetch: the browser goes to
// /api/auth/oauth/<provider>, the backend bounces it to the provider and back,
// sets the same session cookie, and returns us to the app — where the mount-time
// /me call picks the session up. `oauthProviders` reports which buttons to
// enable (a provider without server-side credentials stays disabled).
//
// The account controls (rename, export, delete history, delete account) all go
// to real endpoints — see api/auth_blueprint.py. Deleting the account is
// reversible for a grace period: the server keeps the row and signing back in
// cancels it.
//
// The plan is real too: user_account.plan, changed through /me/plan, and its
// limits are enforced server-side (see flask-server/services/plan_store.py).
// There is no payment step — pricing hasn't been set — but the limits bite.
//
// Account type is real too: user_account.account_type, set through PATCH
// /auth/me. It still gates nothing — it exists so activity can be grouped by it
// — but it is no longer a localStorage value the server has never seen.
//
// Not wired yet: emailNotifications -> B3, still a client-only localStorage pref.
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import {
	type AccountProfile,
	type AccountType,
	type PlanId,
} from "../helpers/accountProfile";
import { track } from "../helpers/analytics";
import { API_BASE } from "../helpers/constants";

export type AuthUser = {
	id: string;
	email: string;
	/** The name the user set, or one derived from their email if they haven't. */
	name: string;
	/** True when `name` is the user's own rather than derived from the email. */
	hasCustomName: boolean;
	emailNotifications: boolean; // client-only preference until B3
	/** Whether the account's email address has been verified. */
	emailVerified: boolean;
	/** Billing plan, from user_account.plan. Its limits are enforced server-side. */
	plan: PlanId;
	/** Self-reported account type, from user_account.account_type. Gates nothing. */
	profile: AccountProfile;
	/** Roles held, from the user_role table ("admin" is the only one). The server
	 *  enforces them; these only decide what the UI offers to draw. */
	roles: string[];
};

/** What GET /me/usage returns: the plan's limits and what's been used of them. */
export type PlanUsage = {
	plan: PlanId;
	scans: { used: number; limit: number | null; in_flight: number; resets_at: string | null };
	ai_messages: { used: number; limit: number | null; resets_at: string | null };
};

export type AuthProvider2 = "google" | "github";
// "forgot" is the same card again, asking only for an email. It isn't reachable
// from the header — you get there from the sign-in form, having failed at it.
export type AuthMode = "signin" | "signup" | "forgot";

type AuthContextValue = {
	user: AuthUser | null;
	isAuthenticated: boolean;
	/** True until the initial /me check resolves (avoids a signed-out flash). */
	loading: boolean;
	signIn: (email: string, password: string) => Promise<AuthUser>;
	/** `name` is optional and is stored server-side on user_account.name. */
	signUp: (email: string, password: string, name?: string) => Promise<AuthUser>;
	/** Full-page redirect into the provider's consent screen. Never returns. */
	signInWithProvider: (provider: AuthProvider2) => void;
	/**
	 * Ask for a reset link. Resolves whether or not an account exists — the
	 * server answers the same way either way, so that nobody can use this to
	 * discover which addresses are registered. The UI has to say "if an account
	 * exists" rather than "sent", because it genuinely doesn't know.
	 */
	requestPasswordReset: (email: string) => Promise<void>;
	/** Redeem a reset token. On success the user is signed in. */
	resetPassword: (token: string, password: string) => Promise<AuthUser>;
	/** (Re)send the verification link for the signed-in account. `sent` is the
	 *  truth from the server — false means SMTP is off and the link only went
	 *  to the server log. */
	sendVerification: () => Promise<{ sent: boolean; alreadyVerified: boolean }>;
	/** Redeem an emailed verification token. Public: works signed out too. */
	verifyEmail: (token: string) => Promise<void>;
	/** Which providers the server has credentials for (null until loaded). */
	oauthProviders: Record<AuthProvider2, boolean> | null;
	signOut: () => Promise<void>;
	updatePreferences: (patch: Partial<Pick<AuthUser, "emailNotifications">>) => void;
	/** Set the display name. An empty string clears it back to the email default. */
	updateName: (name: string) => Promise<void>;
	/** Download everything the server holds for this account as a JSON file. */
	exportData: () => Promise<void>;
	/** Delete every scan and result, keeping the account. Returns how many went. */
	deleteScanHistory: () => Promise<number>;
	/**
	 * Schedule the account for deletion and sign out. Reversible by signing back
	 * in — resolves with the deadline and the grace period, so the UI can say so.
	 */
	deleteAccount: () => Promise<{ restoreBy: string; graceDays: number }>;
	/** Patch the self-reported account type. Persisted server-side. */
	updateAccountProfile: (patch: Partial<AccountProfile>) => Promise<void>;
	/** Move to another plan. No payment step — pricing isn't set. */
	setPlan: (plan: PlanId) => Promise<void>;
	/** Redeem a server-configured access coupon for sponsored model access. */
	redeemAdminCoupon: (coupon: string) => Promise<AuthUser>;
	/** Current plan usage, or null until loaded. Refreshed by refreshUsage(). */
	usage: PlanUsage | null;
	refreshUsage: () => Promise<void>;
	// Global auth popup, opened from the header or any gated action. Signing up
	// and signing in are the same card with a different title, the way both
	// Claude and ChatGPT do it — `mode` picks which.
	authPrompt: { open: boolean; mode: AuthMode };
	/** Defaults to sign-in: most people reaching a gate already have an account. */
	promptAuth: (mode?: AuthMode) => void;
	closeAuthPrompt: () => void;
	/** Error surfaced by the OAuth callback redirect (?auth_error=...), if any. */
	oauthError: string | null;
	clearOauthError: () => void;
};

// Cross-tab sync: writing this key on any auth change nudges other tabs to
// re-check /me (we can't watch the httponly cookie directly).
const AUTH_PING_KEY = "authChangePing";

const nameFromEmail = (email: string): string => {
	const local = email.split("@")[0] || email;
	return (
		local
			.split(/[._-]+/)
			.filter(Boolean)
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
			.join(" ") || email
	);
};

// Email-notification preference is client-only until the backend supports it.
const prefKey = (id: string) => `emailNotif:${id}`;
const loadPref = (id: string): boolean => {
	try {
		const v = localStorage.getItem(prefKey(id));
		return v === null ? true : v === "1";
	} catch {
		return true;
	}
};
const savePref = (id: string, on: boolean) => {
	try {
		localStorage.setItem(prefKey(id), on ? "1" : "0");
	} catch {
		/* ignore */
	}
};

type ApiUser = {
	id: string;
	email: string;
	name?: string | null;
	plan?: string | null;
	account_type?: string | null;
	organization?: string | null;
	occupation?: string | null;
	role_description?: string | null;
	email_verified?: boolean;
	roles?: string[] | null;
};
const mapApiUser = (u: ApiUser): AuthUser => {
	const custom = (u.name || "").trim();
	return {
		id: u.id,
		email: u.email,
		// Accounts predating the name column have none — fall back to the email.
		name: custom || nameFromEmail(u.email),
		hasCustomName: custom.length > 0,
		emailNotifications: loadPref(u.id),
		emailVerified: u.email_verified === true,
		plan: (u.plan as PlanId) || "free",
		profile: {
			accountType: (u.account_type as AccountType) || null,
			organization: u.organization || null,
			occupation: u.occupation || null,
			roleDescription: u.role_description || null,
		},
		// Defaulted, never invented: an endpoint that forgets to send roles
		// leaves you with none, which fails closed.
		roles: u.roles ?? [],
	};
};

const authFetch = (path: string, init?: RequestInit) =>
	fetch(`${API_BASE}${path}`, {
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		...init,
	});

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);
	const [authPrompt, setAuthPrompt] = useState<{ open: boolean; mode: AuthMode }>({
		open: false, mode: "signin",
	});
	const [oauthProviders, setOauthProviders] = useState<Record<AuthProvider2, boolean> | null>(null);
	const [usage, setUsage] = useState<PlanUsage | null>(null);
	// The OAuth callback redirects back with ?auth_error=... on failure (e.g. an
	// unverified provider email colliding with an existing account). Read it once
	// on mount, then strip it from the URL so a refresh doesn't resurface it.
	const [oauthError, setOauthError] = useState<string | null>(() => {
		try {
			const params = new URLSearchParams(window.location.search);
			const err = params.get("auth_error");
			if (err) {
				params.delete("auth_error");
				const qs = params.toString();
				window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
			}
			return err;
		} catch {
			return null;
		}
	});

	const refreshMe = useCallback(async () => {
		try {
			const res = await authFetch("/api/auth/me");
			if (res.ok) {
				const { user: u } = await res.json();
				setUser(u ? mapApiUser(u) : null);
			} else {
				setUser(null);
			}
		} catch {
			setUser(null); // network error -> treat as signed out
		} finally {
			setLoading(false);
		}
	}, []);

	// Restore the session from the cookie on mount.
	useEffect(() => {
		refreshMe();
	}, [refreshMe]);

	// Which OAuth buttons to enable. Failure -> treat both as unavailable.
	useEffect(() => {
		let cancelled = false;
		authFetch("/api/auth/oauth/providers")
			.then((r) => (r.ok ? r.json() : { google: false, github: false }))
			.then((p) => !cancelled && setOauthProviders({ google: !!p.google, github: !!p.github }))
			.catch(() => !cancelled && setOauthProviders({ google: false, github: false }));
		return () => {
			cancelled = true;
		};
	}, []);

	// If we came back from a failed OAuth attempt, show the popup with the error.
	// Sign-in mode: the failure message tells them what to do, and the signup
	// side's terms fine print would be noise on top of an error.
	useEffect(() => {
		if (oauthError) setAuthPrompt({ open: true, mode: "signin" });
	}, [oauthError]);

	// Cross-tab: another tab signed in/out -> re-check.
	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key === AUTH_PING_KEY) refreshMe();
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [refreshMe]);

	const pingOtherTabs = () => {
		try {
			localStorage.setItem(AUTH_PING_KEY, String(Date.now()));
		} catch {
			/* ignore */
		}
	};

	const authAction = useCallback(
		async (path: string, email: string, password: string, name?: string) => {
			const body: Record<string, string> = { email, password };
			if (name?.trim()) body.name = name.trim();
			const res = await authFetch(path, { method: "POST", body: JSON.stringify(body) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
			const mapped = mapApiUser(data.user);
			setUser(mapped);
			pingOtherTabs();
			return mapped;
		},
		[]
	);

	const sendVerification = useCallback(async () => {
		const res = await authFetch("/api/auth/send-verification", { method: "POST" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't send the link. Try again.");
		return { sent: data.sent === true, alreadyVerified: data.already_verified === true };
	}, []);

	const verifyEmail = useCallback(async (token: string) => {
		const res = await authFetch("/api/auth/verify-email", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "This link has expired or has already been used.");
		// If this browser is signed in as the account that just verified,
		// reflect it immediately — the tier check reads it.
		setUser((current) =>
			current && data.user && current.id === data.user.id ? mapApiUser(data.user) : current
		);
	}, []);

	const signIn = useCallback(
		(email: string, password: string) => authAction("/api/auth/login", email, password),
		[authAction]
	);
	// The name goes to the server with the registration — /auth/register takes it,
	// so a signup name lands in user_account.name rather than in local storage.
	const signUp = useCallback(
		(email: string, password: string, name?: string) =>
			authAction("/api/auth/register", email, password, name),
		[authAction]
	);

	const requestPasswordReset = useCallback(async (email: string) => {
		const res = await authFetch("/api/auth/forgot-password", {
			method: "POST",
			body: JSON.stringify({ email }),
		});
		// 200 whether or not the address has an account. The only failure worth
		// surfacing is the rate limit, which is a thing the user can act on.
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Couldn't send the link. Try again.");
		}
	}, []);

	const resetPassword = useCallback(
		async (token: string, password: string) => {
			const res = await authFetch("/api/auth/reset-password", {
				method: "POST",
				body: JSON.stringify({ token, password }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "Couldn't reset your password.");
			const mapped = mapApiUser(data.user);
			setUser(mapped);
			pingOtherTabs();
			return mapped;
		},
		[]
	);

	// OAuth can't be a fetch: the provider's consent screen has to be a top-level
	// navigation (and the backend needs to set the cookie on the way back), so we
	// hand the whole browser over. On return, the mount-time /me call restores
	// the session.
	const signInWithProvider = useCallback((provider: AuthProvider2) => {
		// Hand the backend the page we're leaving so its callback can send us
		// back here instead of to the app root. Same-origin relative path only;
		// the backend re-validates it before redirecting.
		const next = window.location.pathname + window.location.search + window.location.hash;
		const qs = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
		window.location.href = `${API_BASE}/api/auth/oauth/${provider}${qs}`;
	}, []);

	const signOut = useCallback(async () => {
		track("auth_sign_out");
		// Clear locally first so the UI updates instantly, then revoke server-side.
		setUser(null);
		pingOtherTabs();
		try {
			await authFetch("/api/auth/logout", { method: "POST" });
		} catch {
			/* ignore — already cleared locally */
		}
	}, []);

	const promptAuth = useCallback((mode: AuthMode = "signin") => {
		track("auth_open_modal");
		setAuthPrompt({ open: true, mode });
	}, []);
	const closeAuthPrompt = useCallback(
		() => setAuthPrompt((p) => ({ ...p, open: false })),
		[]
	);

	// Auto-close the popup once a user is established.
	useEffect(() => {
		if (user) setAuthPrompt((p) => (p.open ? { ...p, open: false } : p));
	}, [user]);

	const updatePreferences = useCallback(
		(patch: Partial<Pick<AuthUser, "emailNotifications">>) => {
			setUser((prev) => {
				if (!prev) return prev;
				const next = { ...prev, ...patch };
				if (typeof next.emailNotifications === "boolean") savePref(next.id, next.emailNotifications);
				return next;
			});
		},
		[]
	);

	const updateName = useCallback(async (name: string) => {
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't save your name. Try again.");
		setUser(mapApiUser(data.user));
	}, []);

	// Streams straight from the server so the file is the real record, not a
	// reconstruction from whatever this browser happens to have cached.
	const exportData = useCallback(async () => {
		const res = await authFetch("/api/me/export");
		if (!res.ok) throw new Error("Couldn't prepare your data. Try again.");
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bodymaps-export.json";
		a.click();
		URL.revokeObjectURL(url);
	}, []);

	const deleteScanHistory = useCallback(async () => {
		const res = await authFetch("/api/me/jobs", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't delete your history. Try again.");
		return Number(data.deleted?.jobs ?? 0);
	}, []);

	const deleteAccount = useCallback(async () => {
		const res = await authFetch("/api/me", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't delete your account. Try again.");
		// The server has already revoked every session and cleared the cookie.
		setUser(null);
		pingOtherTabs();
		return { restoreBy: data.restore_by as string, graceDays: Number(data.grace_days) };
	}, []);

	const updateAccountProfile = useCallback(async (patch: Partial<AccountProfile>) => {
		// "" clears a field: the server reads an empty string as "not provided".
		const body: Record<string, string> = {};
		if ("accountType" in patch) body.account_type = patch.accountType ?? "";
		if ("organization" in patch) body.organization = patch.organization ?? "";
		if ("occupation" in patch) body.occupation = patch.occupation ?? "";
		if ("roleDescription" in patch) body.role_description = patch.roleDescription ?? "";
		if (Object.keys(body).length === 0) return;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't save your role. Try again.");
		setUser(mapApiUser(data.user));
	}, []);

	const refreshUsage = useCallback(async () => {
		if (!user) {
			setUsage(null);
			return;
		}
		try {
			const res = await authFetch("/api/me/usage");
			setUsage(res.ok ? await res.json() : null);
		} catch {
			setUsage(null); // a usage read failing is not worth surfacing
		}
	}, [user]);

	const setPlan = useCallback(async (plan: PlanId) => {
		const res = await authFetch("/api/me/plan", {
			method: "POST",
			body: JSON.stringify({ plan }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't change your plan. Try again.");
		setUser(mapApiUser(data.user));
	}, []);

	const redeemAdminCoupon = useCallback(async (coupon: string) => {
		const res = await authFetch("/api/auth/redeem-admin-coupon", {
			method: "POST",
			body: JSON.stringify({ coupon }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "Couldn't redeem that access coupon.");
		const mapped = mapApiUser(data.user);
		setUser(mapped);
		return mapped;
	}, []);

	// Keep usage in step with whoever is signed in — including after a plan
	// change, since the limits it reports come from the plan.
	useEffect(() => {
		refreshUsage();
	}, [refreshUsage]);

	const clearOauthError = useCallback(() => setOauthError(null), []);

	const value = useMemo<AuthContextValue>(
		() => ({
			user,
			isAuthenticated: user !== null,
			loading,
			signIn,
			signUp,
			signInWithProvider,
			requestPasswordReset,
			resetPassword,
			sendVerification,
			verifyEmail,
			oauthProviders,
			signOut,
			updatePreferences,
			updateName,
			exportData,
			deleteScanHistory,
			deleteAccount,
			 updateAccountProfile,
			 setPlan,
			 redeemAdminCoupon,
			 usage,
			refreshUsage,
			authPrompt,
			promptAuth,
			closeAuthPrompt,
			oauthError,
			clearOauthError,
		}),
		[user, loading, signIn, signUp, signInWithProvider, requestPasswordReset,
		 resetPassword, sendVerification, verifyEmail, oauthProviders, signOut,
		 updatePreferences, updateName, exportData, deleteScanHistory, deleteAccount,
		 updateAccountProfile, setPlan, redeemAdminCoupon, usage, refreshUsage, authPrompt, promptAuth,
		 closeAuthPrompt, oauthError, clearOauthError]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
	return ctx;
}
