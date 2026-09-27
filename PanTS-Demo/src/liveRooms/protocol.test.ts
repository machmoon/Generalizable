import { gzip } from "pako";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_LIVE_ROOM_CHAT_MESSAGES,
	appRootRelativeUrl,
	applyCommittedEvent,
	bootstrapLiveRoom,
	chunkMaskRanges,
	emptyDurableState,
	liveRoomShareUrl,
	roomKeyFromFragment,
	sanitizeLiveRoomPresence,
	sanitizeLiveRoomView,
} from "./protocol";
import type { LiveRoomEvent } from "./types";

describe("Live Room protocol helpers", () => {
	afterEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("extracts capability only from URL fragment", () => {
		expect(roomKeyFromFragment("#secret%2Fkey")).toBe("secret/key");
		expect(roomKeyFromFragment("#%zz")).toBe("");
	});

	it("chunks mask ranges without losing order", () => {
		const ranges = Array.from({ length: 40 }, (_, index) => ({ start: index, length: 1, before: 0, after: 2 }));
		const chunks = chunkMaskRanges(ranges, 180);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.flat()).toEqual(ranges);
	});

	it("applies committed object events idempotently", () => {
		const event = {
			seq: 1,
			event_id: "event-1",
			type: "chat.add",
			participant_id: "p1",
			name: "Guest",
			created_at: "2026-07-12T00:00:00Z",
			payload: { message: { id: "m1", author: "Guest", text: "hello" } },
		} satisfies LiveRoomEvent;
		const once = applyCommittedEvent(emptyDurableState(), event);
		const twice = applyCommittedEvent(once, event);
		expect(twice.chat).toHaveLength(1);
	});

	it("bounds in-memory chat while retaining newest messages", () => {
		let state = emptyDurableState();
		for (let index = 0; index <= MAX_LIVE_ROOM_CHAT_MESSAGES; index += 1) {
			state = applyCommittedEvent(state, {
				seq: index + 1,
				event_id: `event-${index}`,
				type: "chat.add",
				participant_id: "p1",
				name: "Guest",
				created_at: "2026-07-12T00:00:00Z",
				payload: { message: { id: `message-${index}`, author: "Guest", text: String(index) } },
			});
		}
		expect(state.chat).toHaveLength(MAX_LIVE_ROOM_CHAT_MESSAGES);
		expect(state.chat[0].text).toBe("1");
	});

	it("generates basename-aware app and room URLs", () => {
		expect(appRootRelativeUrl("/case/35", "/bodymaps/")).toBe("/bodymaps/case/35");
		expect(liveRoomShareUrl("room 1", "key/value", "https://bodymaps.test", "/app"))
			.toBe("https://bodymaps.test/app/live/room%201#key%2Fvalue");
	});

	it("allows only small typed transient fields and preserves explicit clears", () => {
		expect(sanitizeLiveRoomPresence({
			cursor: null,
			plane: "axial",
			crosshair: [1, 2, 3],
			unknown: "discard",
		})).toEqual({ cursor: null, plane: "axial", crosshair: [1, 2, 3] });
		expect(sanitizeLiveRoomView({ view: {
			crosshair: [1, 2, 3],
			cameras: { axial: { position: [1, 2, 3], injected: "discard" }, injected: {} },
			visibleOrgans: [1, 0],
			injected: "discard",
		} })).toEqual({ view: {
			crosshair: [1, 2, 3],
			cameras: { axial: { position: [1, 2, 3] } },
			visibleOrgans: [true, false],
		} });
	});

	it("bootstraps state first and resumes after its sequence when over 500 non-mask events exist", async () => {
		const room = {
			room_id: "room-501", case_id: "35", resolution: "low", created_at: "now", expires_at: "later",
			geometry_hash: "hash", dimensions: [1, 1, 1], latest_seq: 501, mode: "review",
		};
		const requests: string[] = [];
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/snapshot")) {
				return Promise.resolve(new Response(JSON.stringify({
					room,
					latest_seq: 501,
					state: emptyDurableState(),
				}), { status: 200, headers: { "Content-Type": "application/json" } }));
			}
			return Promise.resolve(new Response(gzip(new Uint8Array([1, 2, 3])), {
				status: 200,
				headers: { "X-Live-Room-Sequence": "0" },
			}));
		}));
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:authoritative-mask");

		const result = await bootstrapLiveRoom(room.room_id, "secret");

		expect(requests[0]).toMatch(/\/snapshot$/);
		expect(requests[1]).toMatch(/\/snapshot\?format=mask$/);
		expect(result.snapshotSequence).toBe(501);
		expect(result.maskUrl).toBe("blob:authoritative-mask");
	});
});
