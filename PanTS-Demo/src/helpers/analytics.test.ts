import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, routePattern, track, trackPageView } from "./analytics";

// The contract that matters here is what leaves the browser: a feature name, a
// route pattern, a duration — and never anything identifying the scan.

const bodies = () =>
	(global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
		([, init]) => JSON.parse(String((init as RequestInit).body)).events
	);

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ stored: 1 }) })) as never;
	window.history.pushState({}, "", "/dashboard");
});

afterEach(() => {
	flush();
	vi.restoreAllMocks();
});

describe("routePattern", () => {
	it("keeps the static routes it knows", () => {
		expect(routePattern("/")).toBe("/");
		expect(routePattern("/upload")).toBe("/upload");
		expect(routePattern("/account/plan")).toBe("/account/plan");
	});

	it("reduces a case URL to its pattern, dropping the id", () => {
		expect(routePattern("/case/BDMAP_00000123")).toBe("/case/:caseId");
		expect(routePattern("/session/8f3c-4e21")).toBe("/session/:sessionId");
	});

	it("ignores a trailing slash", () => {
		expect(routePattern("/upload/")).toBe("/upload");
	});

	it("returns null for a route it doesn't recognise", () => {
		// Better to lose the row than to store a URL we haven't vetted.
		expect(routePattern("/some/unknown/page")).toBeNull();
	});
});

describe("track", () => {
	it("sends the event name and the current route, not the URL", async () => {
		window.history.pushState({}, "", "/case/BDMAP_00000123");
		track("viewer_open_case");
		flush();

		const [event] = bodies()[0];
		expect(event.kind).toBe("action");
		expect(event.name).toBe("viewer_open_case");
		expect(event.route).toBe("/case/:caseId");
		expect(JSON.stringify(event)).not.toContain("BDMAP_00000123");
	});

	it("batches events into one request rather than one request per click", () => {
		track("upload_select_model");
		track("upload_start_inference");
		track("viewer_measure");
		expect(global.fetch).not.toHaveBeenCalled();

		flush();
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(bodies()[0]).toHaveLength(3);
	});

	it("flushes on its own once the batch gets big", () => {
		for (let i = 0; i < 20; i++) track("viewer_toggle_organ");
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(bodies()[0]).toHaveLength(20);
	});

	it("gives every event the same anonymous id across a visit", () => {
		track("auth_open_modal");
		track("dataset_search");
		flush();

		const [first, second] = bodies()[0];
		expect(first.anon_id).toBeTruthy();
		expect(first.anon_id).toBe(second.anon_id);
		expect(first.session_id).toBe(second.session_id);
	});

	it("reuses the same anonymous id on a later visit", async () => {
		// A fresh module is a fresh page load: the id is cached in memory for the
		// life of the page, so persistence is only observable across one.
		localStorage.setItem("bmAnalyticsAnon", "known-browser");
		vi.resetModules();
		const fresh = await import("./analytics");

		fresh.track("auth_open_modal");
		fresh.flush();

		expect(bodies()[0][0].anon_id).toBe("known-browser");
	});

	it("never reports a plan or account type — the server decides that", () => {
		track("account_change_plan");
		flush();

		const [event] = bodies()[0];
		expect(event).not.toHaveProperty("plan");
		expect(event).not.toHaveProperty("account_type");
		expect(event).not.toHaveProperty("user_id");
	});

	it("swallows a failed send instead of surfacing it to the app", async () => {
		global.fetch = vi.fn(async () => {
			throw new Error("offline");
		}) as never;

		expect(() => {
			track("viewer_measure");
			flush();
		}).not.toThrow();
	});

	it("does nothing visible when storage is unavailable", () => {
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});

		expect(() => {
			track("dataset_search");
			flush();
		}).not.toThrow();

		getItem.mockRestore();
		setItem.mockRestore();
	});
});

describe("trackPageView", () => {
	it("records the route with how long was spent on it", () => {
		trackPageView("/upload", 4200);
		flush();

		const [event] = bodies()[0];
		expect(event.kind).toBe("page_view");
		expect(event.name).toBe("/upload");
		expect(event.duration_ms).toBe(4200);
	});

	it("never reports a negative duration", () => {
		trackPageView("/upload", -50);
		flush();
		expect(bodies()[0][0].duration_ms).toBe(0);
	});
});

describe("flush", () => {
	it("sends nothing when there is nothing queued", () => {
		flush();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("empties the queue, so a second flush doesn't resend", () => {
		track("viewer_measure");
		flush();
		flush();
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});
});
