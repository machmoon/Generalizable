import { describe, expect, it } from "vitest";
import {
	canPostprocess,
	isModelLocked,
	limitsFor,
	maxConcurrentScans,
	nextPlanUp,
	PLAN_LIMITS,
	PLANS,
} from "./accountProfile";

describe("plan limits", () => {
	it("gives Free only the free model", () => {
		expect(PLAN_LIMITS.free.models).toEqual(["LesionSegmenter"]);
		expect(isModelLocked("free", "LesionSegmenter")).toBe(false);
		expect(isModelLocked("free", "ePAI")).toBe(true);
		expect(isModelLocked("free", "R-Super")).toBe(true);
	});

	it("never locks the view-only option — it doesn't reach the server", () => {
		expect(isModelLocked("free", "None")).toBe(false);
	});

	it("unlocks every model above Free", () => {
		for (const plan of ["pro", "team", "enterprise"] as const) {
			expect(isModelLocked(plan, "ePAI")).toBe(false);
			expect(canPostprocess(plan)).toBe(true);
		}
	});

	it("holds postprocessing back from Free", () => {
		expect(canPostprocess("free")).toBe(false);
	});

	it("reports concurrency as a number, unlimited included", () => {
		expect(maxConcurrentScans("free")).toBe(1);
		expect(maxConcurrentScans("pro")).toBe(5);
		expect(maxConcurrentScans("enterprise")).toBe(Infinity);
	});

	it("falls back to Free for an unknown plan rather than throwing", () => {
		// @ts-expect-error deliberately outside PlanId — a stale value from the API
		expect(limitsFor("platinum")).toEqual(PLAN_LIMITS.free);
		expect(limitsFor(undefined)).toEqual(PLAN_LIMITS.free);
	});

	it("points each plan at the next one up, and Enterprise at nothing", () => {
		expect(nextPlanUp("free")).toBe("pro");
		expect(nextPlanUp("pro")).toBe("team");
		expect(nextPlanUp("team")).toBe("enterprise");
		expect(nextPlanUp("enterprise")).toBeNull();
	});
});

describe("plan cards", () => {
	it("splits into two individual and two team plans", () => {
		expect(PLANS.filter((p) => p.group === "individual").map((p) => p.id))
			.toEqual(["free", "pro"]);
		expect(PLANS.filter((p) => p.group === "team").map((p) => p.id))
			.toEqual(["team", "enterprise"]);
	});

	it("keeps every card short enough to scan", () => {
		for (const plan of PLANS) {
			expect(plan.points.length).toBeLessThanOrEqual(6);
			// Bullets are noun phrases, not sentences.
			for (const point of plan.points) {
				expect(point.split(" ").length).toBeLessThanOrEqual(6);
				expect(point).not.toMatch(/\.$/);
			}
			expect(plan.blurb.split(" ").length).toBeLessThanOrEqual(7);
		}
	});

	it("prices Free at nothing, Pro as earned, Team as coming, Enterprise as open", () => {
		const byId = Object.fromEntries(PLANS.map((p) => [p.id, p]));
		expect(byId.free.price).toBe("$0");
		expect(byId.pro.price).toBe("Free"); // earned by verification, not bought
		expect(byId.team.price).toBe("Coming soon");
		expect(byId.enterprise.price).toBe("Custom");
		// A bare figure means nothing without a period attached to it.
		for (const plan of PLANS) expect(plan.priceNote).toBeTruthy();
	});

	it("gives every card a lead line so the bullet lists align", () => {
		for (const plan of PLANS) {
			expect(plan.inherits ?? plan.pointsLead).toBeTruthy();
		}
	});

	it("has a limits entry for every card and vice versa", () => {
		expect(PLANS.map((p) => p.id).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
	});
});
