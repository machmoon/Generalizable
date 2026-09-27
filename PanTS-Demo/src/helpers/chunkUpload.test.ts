import { afterEach, describe, expect, it, vi } from "vitest";
import { postWithRetry, resolveResumeStart } from "./chunkUpload";

const okResponse = (body: unknown = { status: "ok" }) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const errorResponse = (status: number) =>
	new Response(JSON.stringify({ error: "nope" }), {
		status,
		headers: { "content-type": "application/json" },
	});

// baseDelayMs: 0 everywhere - the backoff timing isn't what's under test.
const noDelay = { baseDelayMs: 0 };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("postWithRetry", () => {
	it("returns the first response when it succeeds", async () => {
		const fetchMock = vi.fn().mockResolvedValue(okResponse());
		vi.stubGlobal("fetch", fetchMock);

		const res = await postWithRetry("/api/upload-inference-chunk", {}, noDelay);

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a dropped connection and succeeds - the blip that used to kill a run", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValue(okResponse());
		vi.stubGlobal("fetch", fetchMock);

		const res = await postWithRetry("/api/upload-inference-chunk", {}, noDelay);

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a 503 and returns the eventual success", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(errorResponse(503))
			.mockResolvedValue(okResponse());
		vi.stubGlobal("fetch", fetchMock);

		const res = await postWithRetry("/api/upload-inference-chunk", {}, noDelay);

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a 413 - the chunk will never fit", async () => {
		const fetchMock = vi.fn().mockResolvedValue(errorResponse(413));
		vi.stubGlobal("fetch", fetchMock);

		const res = await postWithRetry("/api/upload-inference-chunk", {}, noDelay);

		expect(res.status).toBe(413);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("gives up after the retry budget and throws the network error", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postWithRetry("/api/upload-inference-chunk", {}, { retries: 2, baseDelayMs: 0 }),
		).rejects.toThrow("Failed to fetch");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("returns the last error response rather than throwing when retries run out", async () => {
		const fetchMock = vi.fn().mockResolvedValue(errorResponse(500));
		vi.stubGlobal("fetch", fetchMock);

		const res = await postWithRetry("/api/upload-inference-chunk", {}, noDelay);

		expect(res.status).toBe(500);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("never retries after a user cancel", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn().mockImplementation(() => {
			controller.abort();
			return Promise.reject(new DOMException("Aborted", "AbortError"));
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postWithRetry("/api/upload-inference-chunk", { signal: controller.signal }, noDelay),
		).rejects.toThrow(/abort/i);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not fire a request at all if already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postWithRetry("/api/upload-inference-chunk", { signal: controller.signal }, noDelay),
		).rejects.toThrow(/abort/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("resolveResumeStart", () => {
	it("believes the server over the local cursor when the server is ahead", async () => {
		// The cursor is only persisted every 16 chunks, so it routinely lags.
		const fetchMock = vi.fn().mockResolvedValue(okResponse({ next_chunk: 48 }));
		vi.stubGlobal("fetch", fetchMock);

		expect(await resolveResumeStart("", "sid", 32)).toBe(48);
		expect(fetchMock).toHaveBeenCalledWith("/api/upload-status/sid", {
			credentials: "include",
		});
	});

	it("restarts from 0 when the server has swept the chunks", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ next_chunk: 0 })));

		expect(await resolveResumeStart("", "sid", 200)).toBe(0);
	});

	it("rewinds to the server's first gap", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ next_chunk: 12 })));

		expect(await resolveResumeStart("", "sid", 64)).toBe(12);
	});

	it("falls back to the local cursor when the endpoint is unreachable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

		expect(await resolveResumeStart("", "sid", 32)).toBe(32);
	});

	it("falls back to the local cursor on an older backend with no such route", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(404)));

		expect(await resolveResumeStart("", "sid", 32)).toBe(32);
	});

	it("falls back to the local cursor if the payload is malformed", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ next_chunk: "eight" })));

		expect(await resolveResumeStart("", "sid", 32)).toBe(32);
	});
});
