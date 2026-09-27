// Plans, what each one allows, and the account-type vocabulary.
//
// PLAN_LIMITS mirrors flask-server/services/plan_store.py. The server is what
// actually decides — it returns 402 with a reason, and that reason is what the
// upgrade dialog reports. This copy exists so the UI can grey a locked control
// out up front instead of letting you click into a rejection. A drift between
// the two is a cosmetic bug here and a real one there; change them together.
//
// Neither the plan nor the account type is stored here: both are columns on
// user_account and arrive through authContext. What's left in this file is the
// vocabulary — the ids, labels and limits the UI renders.

export type AccountType = "patient" | "clinician" | "researcher" | "student";
export type PlanId = "free" | "pro" | "team" | "enterprise";
/** Which tab of the plan picker a plan appears under. */
export type PlanGroup = "individual" | "team";

/** null means unlimited, matching the server's representation. */
export type PlanLimits = {
	dailyScans: number | null;
	concurrentScans: number | null;
	/** Model ids the plan may run; null means every model. */
	models: string[] | null;
	postprocessing: boolean;
	dailyAiMessages: number | null;
	createReports: boolean;
	retentionDays: number | null;
	priorityQueue: boolean;
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
	free: {
		dailyScans: 1,
		concurrentScans: 1,
		models: ["LesionSegmenter"],
		postprocessing: false,
		dailyAiMessages: 10,
		createReports: false,
		retentionDays: 7,
		priorityQueue: false,
	},
	pro: {
		dailyScans: 10,
		concurrentScans: 5,
		models: null,
		postprocessing: true,
		dailyAiMessages: 200,
		createReports: true,
		retentionDays: 365,
		priorityQueue: true,
	},
	team: {
		dailyScans: 10,
		concurrentScans: 5,
		models: null,
		postprocessing: true,
		dailyAiMessages: 200,
		createReports: true,
		retentionDays: 365,
		priorityQueue: true,
	},
	enterprise: {
		dailyScans: null,
		concurrentScans: null,
		models: null,
		postprocessing: true,
		dailyAiMessages: null,
		createReports: true,
		retentionDays: null,
		priorityQueue: true,
	},
};

export const limitsFor = (plan: PlanId | undefined): PlanLimits =>
	PLAN_LIMITS[plan ?? "free"] ?? PLAN_LIMITS.free;

/**
 * The plan whose limits a control should be greyed against — which is not
 * always the plan the account is on. Admins bypass plan limits entirely
 * (plan_store.limits_for_user does the same server-side), so they are gated as
 * Enterprise, the tier with nothing switched off.
 *
 * For gating only, never for display: the plan an admin's account is *on* is
 * still `user.plan`, and that's what the settings page names.
 */
export const profileComplete = (profile: AccountProfile): boolean =>
	!!(profile.organization && profile.occupation && profile.roleDescription);

/** T2: verified email + complete profile. Server-side twin: plan_store. */
export const isVerifiedResearcher = (
	user: { emailVerified?: boolean; profile?: AccountProfile } | null | undefined,
): boolean => !!user?.emailVerified && !!user.profile && profileComplete(user.profile);

export const gatingPlan = (
	user: {
		plan: PlanId;
		roles: string[];
		emailVerified?: boolean;
		profile?: AccountProfile;
	} | null | undefined,
): PlanId => {
	if (!user) return "free";
	if (user.roles.includes("admin")) return "enterprise";
	if (user.plan === "free" && isVerifiedResearcher(user)) return "pro";
	return user.plan;
};

/** Whether the paid plans are pickable. They aren't open yet, so everyone but
 *  an admin is held on Free — /me/plan refuses the rest with a 403. */
export const canChangePlan = (user: { roles: string[] } | null | undefined): boolean =>
	!!user?.roles.includes("admin");

// Plan cards. Kept to a name, one line, a price, and a handful of short bullets
// — the shape Claude and ChatGPT both use. Longer copy was the old version's
// problem: four plans each explaining themselves in paragraphs is a wall, and
// nobody reads a wall to pick a tier.
export type Plan = {
	id: PlanId;
	label: string;
	group: PlanGroup;
	/** One line under the name. Six words is the budget. */
	blurb: string;
	/**
	 * The headline figure. Billing lands before launch; until it does, /me/plan
	 * is a column write and switching plans grants the tier immediately. The
	 * limits attached to a plan are enforced for real either way.
	 */
	price: string;
	/** Small print under the price ("per month"). */
	priceNote?: string;
	/** Small pill in the card's top corner (member counts), if any. */
	badge?: string;
	/** Renders "Everything in <that plan>, plus:" above the bullets. */
	inherits?: PlanId;
	/** Lead line above the bullets on a plan that inherits nothing. Present so
	 *  every card has one and the bullet lists line up across the row. */
	pointsLead?: string;
	/** Short noun phrases, not sentences. */
	points: string[];
	cta: string;
};

export const PLANS: Plan[] = [
	{
		id: "free",
		label: "Free",
		group: "individual",
		blurb: "Try BodyMaps",
		price: "$0",
		priceNote: "always free",
		pointsLead: "Includes:",
		points: [
			"1 scan a day",
			"LesionSegmenter model",
			"Full viewer and 3D reconstruction",
			"10 assistant messages a day",
		],
		cta: "Start free",
	},
	// Pro / Team / Enterprise are future offerings: no prices, no feature the
	// code does not implement, no clinical positioning. The cards stay visible
	// so the shape of the plan family is clear, but the button says "Coming
	// soon" for everyone except admins (who switch tiers to test limits).
	{
		id: "pro",
		label: "Pro",
		group: "individual",
		blurb: "For verified researchers",
		price: "Free",
		priceNote: "verify email + complete profile",
		inherits: "free",
		points: [
			"10 scans a day",
			"Every model",
			"Several scans at once",
			"Research summaries and annotations",
		],
		cta: "Choose Pro",
	},
	{
		id: "team",
		label: "Team",
		group: "team",
		blurb: "For a research team or lab",
		price: "Coming soon",
		priceNote: "pricing not yet set",
		badge: "2–15 members",
		inherits: "pro",
		points: [
			"Collaboration features for a team",
			"Higher shared usage limits",
			"Details announced at launch",
		],
		cta: "Choose Team",
	},
	{
		id: "enterprise",
		label: "Enterprise",
		group: "team",
		blurb: "For a research institution",
		// "Talk to us" is the button; the price slot needs to say something else.
		price: "Custom",
		priceNote: "by agreement",
		badge: "15+ members",
		inherits: "team",
		points: [
			"Single sign-on",
			"Private deployment",
			"Alternate data terms",
			"Support agreement",
		],
		cta: "Talk to us",
	},
];

export const planLabel = (id: PlanId): string =>
	PLANS.find((p) => p.id === id)?.label ?? id;

/** The plan an upgrade prompt should point at. Enterprise has nowhere to go. */
export const nextPlanUp = (plan: PlanId): PlanId | null =>
	plan === "free" ? "pro" : plan === "pro" ? "team" : plan === "team" ? "enterprise" : null;

// ---- feature checks --------------------------------------------------------
// Cosmetic only — each has a server-side counterpart that does the real work.

/** Whether a model id is outside the plan's allowance. "None" is view-only and
 *  never reaches the server, so it's never locked. */
export const isModelLocked = (plan: PlanId, modelId: string): boolean => {
	if (modelId === "None") return false;
	const allowed = limitsFor(plan).models;
	return allowed !== null && !allowed.includes(modelId);
};

export const canPostprocess = (plan: PlanId): boolean => limitsFor(plan).postprocessing;

export const canCreateReports = (plan: PlanId): boolean => limitsFor(plan).createReports;

/** How many scans this plan may have running at once (Infinity if unlimited). */
export const maxConcurrentScans = (plan: PlanId): number =>
	limitsFor(plan).concurrentScans ?? Infinity;

// ---- account type (self-reported, optional, gates nothing but is reported on) ----

export const ACCOUNT_TYPES: { id: AccountType; label: string }[] = [
	{ id: "patient", label: "Patient" },
	{ id: "clinician", label: "Clinician" },
	{ id: "researcher", label: "Researcher" },
	{ id: "student", label: "Student" },
];

export const accountTypeLabel = (id: AccountType | null): string =>
	ACCOUNT_TYPES.find((t) => t.id === id)?.label ?? "Not set";

export type AccountProfile = {
	/** null until the user picks one in settings. Nothing depends on it. */
	accountType: AccountType | null;
	/** Verified-researcher profile. Filled in + a verified email unlocks the
	 *  10-scans-a-day tier; the check itself is server-side. */
	organization: string | null;
	occupation: string | null;
	roleDescription: string | null;
};
