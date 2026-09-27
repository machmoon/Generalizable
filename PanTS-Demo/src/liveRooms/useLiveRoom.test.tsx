import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE, LIVE_ROOM_SEQUENCE_GAP_MS, emptyDurableState } from "./protocol";
import type { LiveQuizState, LiveRoomEvent } from "./types";
import { useLiveRoom } from "./useLiveRoom";

type SocketEvent = { code?: number; data?: string };
type SocketListener = (event: SocketEvent) => void;

class MockWebSocket {
	static readonly OPEN = 1;
	static instances: MockWebSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	closed: Array<{ code?: number; reason?: string }> = [];
	failNextSend = false;
	private listeners: Record<string, SocketListener[]> = {};

	constructor(_url: string) {
		MockWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: SocketListener) {
		(this.listeners[type] ??= []).push(listener);
	}

	send(frame: string) {
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("socket send failed");
		}
		this.sent.push(frame);
	}
	close(code?: number, reason?: string) {
		if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
			throw new Error(`Invalid browser WebSocket close code: ${code}`);
		}
		this.closed.push({ code, reason });
	}

	emit(type: string, event: SocketEvent = {}) {
		if (type === "open") this.readyState = MockWebSocket.OPEN;
		for (const listener of this.listeners[type] ?? []) listener(event);
	}
}

const options = (name = "Tester") => ({
	metadata: {
		room_id: "00000000-0000-4000-8000-000000000035",
		case_id: "35",
		resolution: "low" as const,
		created_at: "2026-07-13T00:00:00Z",
		expires_at: "2026-07-14T00:00:00Z",
		geometry_hash: "hash",
		dimensions: [4, 4, 2],
		latest_seq: 0,
		mode: "review" as const,
	},
	roomKey: "secret",
	name,
	maskUrl: "blob:mask",
	snapshotSequence: 0,
	initialState: emptyDurableState(),
	initialQuiz: null,
});

function connect(socket: MockWebSocket) {
	act(() => {
		socket.emit("open");
		socket.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "00000000-0000-4000-8000-000000000035", name: "Tester", color: "#fff", role: "reviewer" },
			resume_credential: "resume-secret",
			participants: [],
			events: [],
		}) });
	});
}

function storedValues(): Array<string | null> {
	return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index) || ""));
}

function chatEvent(seq: number): LiveRoomEvent {
	return {
		seq,
		event_id: `event-${seq}`,
		type: "chat.add",
		participant_id: "peer",
		name: "Peer",
		created_at: "2026-07-13T00:00:00Z",
		payload: { message: { id: `message-${seq}`, author: "Peer", text: String(seq) } },
	};
}

function quizEvent(seq: number, phase: "question_open" | "question_closed"): LiveRoomEvent {
	return {
		...chatEvent(seq),
		type: phase === "question_open" ? "quiz.started" : "quiz.closed",
		payload: { quiz: {
			phase, question_index: 0, question_count: 1,
			current_question: { id: "organ", prompt: "Which organ?", choices: [] },
			deadline_at: null, remaining_seconds: 30, timer_paused: false,
			response_count: 0, eligible_count: 1, reveal: null, leaderboard: [],
			consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 1 },
			round_completed: false, host_connected: true,
		} },
	};
}

function quizState(overrides: Partial<LiveQuizState> = {}): LiveQuizState {
	return {
		phase: "lobby", question_index: -1, question_count: 1, current_question: null,
		deadline_at: null, remaining_seconds: 30, timer_paused: false, response_count: 0,
		eligible_count: 0, reveal: null, leaderboard: [],
		consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 },
		round_completed: false, host_connected: true,
		...overrides,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	MockWebSocket.instances = [];
	sessionStorage.clear();
});

describe("useLiveRoom socket lifecycle", () => {
	it("ignores delayed close events from Strict Mode's replaced socket", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { rerender, unmount } = renderHook(({ name }) => useLiveRoom(options(name)), {
			initialProps: { name: "Tester one" },
		});

		rerender({ name: "Tester two" });
		expect(MockWebSocket.instances).toHaveLength(2);
		act(() => {
			MockWebSocket.instances[0].emit("close", { code: 1006 });
			vi.advanceTimersByTime(1_000);
		});
		expect(MockWebSocket.instances).toHaveLength(2);
		unmount();
	});

	it("keeps transient callback identities stable across room updates", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const sendPresence = result.current.sendPresence;
		const sendView = result.current.sendView;
		connect(MockWebSocket.instances[0]);
		expect(result.current.connectionState).toBe("connected");
		expect(result.current.sendPresence).toBe(sendPresence);
		expect(result.current.sendView).toBe(sendView);
		unmount();
	});

	it("deep-merges partial participant view cameras and skips identical updates", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		act(() => {
			socket.emit("open");
			socket.emit("message", { data: JSON.stringify({
				type: "room.ready",
				self: { participant_id: "self", name: "Tester", color: "#fff", role: "reviewer" },
				participants: [{
					participant_id: "peer", name: "Peer", color: "#000", role: "reviewer", plane: "axial",
					cursor: { pane: "axial", x: 0.2, y: 0.3 },
					view: {
						crosshair: [1, 2, 3],
						cameras: {
							axial: { position: [1, 2, 3], parallelScale: 1 },
							sagittal: { position: [4, 5, 6] },
							coronal: { position: [7, 8, 9] },
						},
					},
				}],
				events: [],
			}) });
		});
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "presence.changed",
			participant: {
				participant_id: "peer", cursor: null, active_tool: "Length",
				view: { cameras: { axial: { parallelScale: 2 } }, windowWidth: 400 },
			},
		}) }));
		expect(result.current.participants[0]).toMatchObject({
			participant_id: "peer", name: "Peer", plane: "axial", cursor: null, active_tool: "Length",
			view: {
				crosshair: [1, 2, 3], windowWidth: 400,
				cameras: {
					axial: { position: [1, 2, 3], parallelScale: 2 },
					sagittal: { position: [4, 5, 6] },
					coronal: { position: [7, 8, 9] },
				},
			},
		});
		const participants = result.current.participants;
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "presence.changed",
			participant: {
				participant_id: "peer", cursor: null, active_tool: "Length",
				view: { cameras: { axial: { parallelScale: 2 } }, windowWidth: 400 },
			},
		}) }));
		expect(result.current.participants).toBe(participants);
		unmount();
	});

	it("sends latest throttled presence instead of dropping final position", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => {
			result.current.sendPresence({ plane: "axial" });
			result.current.sendPresence({ cursor: null });
			result.current.sendPresence({ plane: "coronal", injected: "discard" });
		});
		let presence = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "presence.update");
		expect(presence).toHaveLength(1);
		expect(presence[0].payload.plane).toBe("axial");
		act(() => vi.advanceTimersByTime(50));
		presence = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "presence.update");
		expect(presence).toHaveLength(2);
		expect(presence[1].payload.plane).toBe("coronal");
		expect(presence[1].payload.cursor).toBeNull();
		expect(presence[1].payload.injected).toBeUndefined();
		unmount();
	});

	it("does not reconnect after fatal protocol errors", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => {
			socket.emit("message", { data: JSON.stringify({ type: "error", fatal: true, message: "Invalid key" }) });
			socket.emit("close", { code: 4003 });
			vi.advanceTimersByTime(30_000);
		});
		expect(result.current.connectionState).toBe("error");
		expect(MockWebSocket.instances).toHaveLength(1);
		unmount();
	});

	it("fails pending mask work without recovery or reconnect when code 4000 replaces the tab", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onRejected = vi.fn();
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		let committed!: Promise<boolean>;
		act(() => {
			committed = result.current.sendDurable("mask.patch", {
				operation_id: "pending-mask",
				geometry_hash: "hash",
				resolution: "low",
				segment_label: 1,
				ranges: [{ start: 0, length: 1, before: 0, after: 1 }],
			}, "pending-mask", { onRejected });
		});
		act(() => {
			socket.emit("close", { code: 4000 });
			vi.advanceTimersByTime(30_000);
		});
		await expect(committed).resolves.toBe(false);
		expect(onRejected).not.toHaveBeenCalled();
		expect(result.current.connectionState).toBe("disconnected");
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(storedValues()).toContain(JSON.stringify({
			participantId: "00000000-0000-4000-8000-000000000035",
			resumeCredential: "resume-secret",
		}));
		unmount();
	});

	it("rejects empty mask patches without reporting a successful send", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		connect(MockWebSocket.instances[0]);
		await expect(result.current.sendDurable("mask.patch", {
			operation_id: "empty",
			geometry_hash: "hash",
			resolution: "low",
			segment_label: 1,
			ranges: [],
		})).resolves.toBe(false);
		unmount();
	});

	it("runs optimistic recovery when the server rejects a durable event", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onRejected = vi.fn();
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		let committed!: Promise<boolean>;
		act(() => {
			committed = result.current.sendDurable("measurement.delete", { id: "measurement-1" }, "event-rejected", { onRejected });
			socket.emit("message", { data: JSON.stringify({ type: "error", event_id: "event-rejected", message: "revision conflict" }) });
		});
		await expect(committed).resolves.toBe(false);
		expect(onRejected).toHaveBeenCalledOnce();
		unmount();
	});

	it("keeps durable events queued until commit and retries after reconnect", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const first = MockWebSocket.instances[0];
		connect(first);
		let durablePromise!: Promise<boolean>;
		act(() => { durablePromise = result.current.sendChat("persist me"); });
		const durableFrame = first.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "chat.add");
		expect(durableFrame).toBeTruthy();

		act(() => {
			first.emit("close", { code: 1006 });
			vi.advanceTimersByTime(500);
		});
		const resumed = MockWebSocket.instances[1];
		act(() => resumed.emit("open"));
		const hello = JSON.parse(resumed.sent[0]);
		expect(hello.participant_id).toBe("00000000-0000-4000-8000-000000000035");
		expect(hello.resume_credential).toBe("resume-secret");
		act(() => resumed.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: hello.participant_id, name: "Tester", color: "#fff", role: "reviewer" },
			participants: [],
			events: [],
		}) }));
		const replay = resumed.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.event_id === durableFrame.event_id);
		expect(replay).toBeTruthy();
		act(() => resumed.emit("message", { data: JSON.stringify({
			type: "event.committed",
			event: { ...chatEvent(1), event_id: durableFrame.event_id },
		}) }));
		await expect(durablePromise).resolves.toBe(true);
		unmount();
	});

	it("buffers out-of-order commits and delivers them exactly in sequence", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => socket.emit("message", { data: JSON.stringify({ type: "event.committed", event: chatEvent(2) }) }));
		expect(result.current.pendingEvents).toEqual([]);
		act(() => socket.emit("message", { data: JSON.stringify({ type: "event.committed", event: chatEvent(1) }) }));
		expect(result.current.pendingEvents.map(({ event }) => event.seq)).toEqual([1, 2]);
		expect(result.current.state.chat.map((message) => message.text)).toEqual(["1", "2"]);
		act(() => result.current.acknowledgeEvents(1));
		expect(result.current.pendingEvents.map(({ event }) => event.seq)).toEqual([2]);
		unmount();
	});

	it("drains a contiguous 500-event replay before enforcing the gap buffer cap and flushes the outbox", async () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onAuthoritativeResync = vi.fn();
		const { result, unmount } = renderHook(() => useLiveRoom({ ...options(), onAuthoritativeResync }));
		const socket = MockWebSocket.instances[0];
		act(() => socket.emit("open"));
		let queued!: Promise<boolean>;
		act(() => { queued = result.current.sendChat("flush after replay"); });
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "replay-self", name: "Tester", color: "#fff", role: "reviewer" },
			resume_credential: "replay-resume",
			participants: [],
			events: Array.from({ length: 500 }, (_, index) => chatEvent(index + 1)),
			latest_seq: 500,
		}) }));

		expect(onAuthoritativeResync).not.toHaveBeenCalled();
		expect(result.current.pendingEvents).toHaveLength(500);
		const flushed = socket.sent.map((frame) => JSON.parse(frame)).find((frame) => frame.type === "chat.add");
		expect(flushed).toBeTruthy();
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "event.committed",
			event: { ...chatEvent(501), event_id: flushed.event_id },
		}) }));
		await expect(queued).resolves.toBe(true);
		unmount();
	});

	it("enforces the buffer cap on unresolved out-of-order replay events", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onAuthoritativeResync = vi.fn();
		const { result, unmount } = renderHook(() => useLiveRoom({ ...options(), onAuthoritativeResync }));
		const socket = MockWebSocket.instances[0];
		act(() => {
			socket.emit("open");
			socket.emit("message", { data: JSON.stringify({
				type: "room.ready",
				participants: [],
				events: [chatEvent(1), ...Array.from({ length: 257 }, (_, index) => chatEvent(index + 3))],
			}) });
		});
		expect(onAuthoritativeResync).toHaveBeenCalledOnce();
		expect(result.current.pendingEvents.map(({ event }) => event.seq)).toEqual([1]);
		unmount();
	});

	it("applies quiz state only after its committed sequence becomes contiguous", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const lobby = {
			phase: "lobby" as const, question_index: -1, question_count: 1, current_question: null,
			deadline_at: null, remaining_seconds: 30, timer_paused: false, response_count: 0,
			eligible_count: 0, reveal: null, leaderboard: [],
			consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 },
			round_completed: false, host_connected: true,
		};
		const { result, unmount } = renderHook(() => useLiveRoom({ ...options(), initialQuiz: lobby }));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => {
			socket.emit("message", { data: JSON.stringify({ type: "event.committed", event: quizEvent(2, "question_closed") }) });
			socket.emit("message", { data: JSON.stringify({ type: "quiz.state", quiz: { ...lobby, phase: "completed" } }) });
		});
		expect(result.current.quiz?.phase).toBe("lobby");
		act(() => socket.emit("message", { data: JSON.stringify({ type: "event.committed", event: quizEvent(1, "question_open") }) }));
		expect(result.current.quiz?.phase).toBe("question_closed");
		unmount();
	});

	it("applies only newer revisioned quiz state, including response counts and eventless ready state", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const initialQuiz = quizState({ revision: 1 });
		const { result, unmount } = renderHook(() => useLiveRoom({
			...options(),
			metadata: { ...options().metadata, mode: "quiz" },
			initialQuiz,
		}));
		const socket = MockWebSocket.instances[0];
		act(() => {
			socket.emit("open");
			socket.emit("message", { data: JSON.stringify({
				type: "room.ready",
				self: { participant_id: "student", name: "Tester", color: "#fff", role: "student" },
				participants: [], events: [],
				quiz: { state: quizState({
					revision: 2,
					phase: "question_open",
					question_index: 0,
					current_question: { id: "organ", prompt: "Which organ?", choices: [] },
				}) },
			}) });
		});
		expect(result.current.quiz?.phase).toBe("question_open");

		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.state",
			quiz: { ...result.current.quiz, revision: 3, response_count: 2 },
		}) }));
		expect(result.current.quiz?.response_count).toBe(2);
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.state",
			quiz: quizState({ revision: 2, phase: "completed", round_completed: true }),
		}) }));
		expect(result.current.quiz).toMatchObject({ revision: 3, phase: "question_open", response_count: 2 });
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.state",
			quiz: { ...result.current.quiz, revision: undefined, response_count: 99 },
		}) }));
		expect(result.current.quiz).toMatchObject({ revision: 3, response_count: 2 });
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.personal",
			quiz: {
				state: { ...result.current.quiz, revision: 4, response_count: 3 },
				own_submissions: { organ: { choice_id: "pancreas", answered_at: "now", response_ms: 100, name: "Tester" } },
				eligible: true,
			},
		}) }));
		expect(result.current.quiz).toMatchObject({ revision: 4, phase: "question_open", response_count: 3 });
		expect(result.current.quizOwnSubmissions.organ.choice_id).toBe("pancreas");
		expect(result.current.quizEligible).toBe(true);
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.host.promoted",
			quiz: quizState({ revision: 5, phase: "completed", round_completed: true }),
		}) }));
		expect(result.current.quiz).toMatchObject({ revision: 5, phase: "completed", round_completed: true });
		expect(result.current.isHost).toBe(true);
		unmount();
	});

	it("limits revisionless quiz updates to same-step response and personal fields", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const closed = quizState({
			phase: "question_closed",
			question_index: 0,
			current_question: { id: "organ", prompt: "Which organ?", choices: [] },
			leaderboard: [{
				rank: 1, participant_id: "student", name: "Student", score: 1, max_score: 1,
				total_response_ms: 100, consistency: { status: "consistent", reasons: [] },
			}],
		});
		const { result, unmount } = renderHook(() => useLiveRoom({
			...options(), metadata: { ...options().metadata, mode: "quiz" }, initialQuiz: closed,
		}));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.state",
			quiz: { ...closed, response_count: 3, eligible_count: 4, leaderboard: [] },
		}) }));
		expect(result.current.quiz).toMatchObject({ phase: "question_closed", response_count: 3, eligible_count: 4 });
		expect(result.current.quiz?.leaderboard).toHaveLength(1);

		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.personal",
			quiz: {
				state: { ...closed, response_count: 4, eligible_count: 5 },
				own_submissions: { organ: { choice_id: "pancreas", answered_at: "now", response_ms: 200, name: "Tester" } },
				eligible: true,
			},
		}) }));
		expect(result.current.quiz?.response_count).toBe(4);
		expect(result.current.quizOwnSubmissions.organ.choice_id).toBe("pancreas");
		expect(result.current.quizEligible).toBe(true);

		act(() => socket.emit("message", { data: JSON.stringify({
			type: "quiz.personal",
			quiz: {
				state: quizState({ phase: "question_open", question_index: 0, current_question: closed.current_question }),
				own_submissions: { organ: { choice_id: "stale", answered_at: "then", response_ms: 1, name: "Tester" } },
				eligible: false,
			},
		}) }));
		expect(result.current.quiz?.phase).toBe("question_closed");
		expect(result.current.quizOwnSubmissions.organ.choice_id).toBe("pancreas");
		expect(result.current.quizEligible).toBe(true);
		unmount();
	});

	it("reconnects from the last contiguous sequence after a gap timeout", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		connect(socket);
		act(() => {
			socket.emit("message", { data: JSON.stringify({ type: "event.committed", event: chatEvent(2) }) });
			vi.advanceTimersByTime(LIVE_ROOM_SEQUENCE_GAP_MS);
		});
		expect(socket.closed.at(-1)).toEqual({ code: LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE, reason: "Sequence gap resync" });
		expect(MockWebSocket.instances).toHaveLength(1);
		act(() => {
			socket.emit("close", { code: LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE });
			vi.advanceTimersByTime(500);
			MockWebSocket.instances[1].emit("open");
		});
		expect(JSON.parse(MockWebSocket.instances[1].sent[0]).last_seq).toBe(0);
		unmount();
	});

	it("requests authoritative bounded-replay recovery only once after more than 500 events", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onAuthoritativeResync = vi.fn();
		const { unmount } = renderHook(() => useLiveRoom({ ...options(), onAuthoritativeResync }));
		const socket = MockWebSocket.instances[0];
		act(() => {
			socket.emit("open");
			socket.emit("message", { data: JSON.stringify({
				type: "room.ready",
				self: { participant_id: "participant-resync", name: "Tester", color: "#fff", role: "reviewer" },
				resume_credential: "credential-resync",
				participants: [], events: [], latest_seq: 501, resync_required: true,
				snapshot: { state: emptyDurableState() },
			}) });
			socket.emit("message", { data: JSON.stringify({ type: "room.resync_required" }) });
		});
		expect(onAuthoritativeResync).toHaveBeenCalledOnce();
		expect(storedValues()).toContain(JSON.stringify({ participantId: "participant-resync", resumeCredential: "credential-resync" }));
		unmount();
	});

	it("marks every bootstrap event for viewport replay, including self edits", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const { result, unmount } = renderHook(() => useLiveRoom(options()));
		const socket = MockWebSocket.instances[0];
		const first = { ...chatEvent(1), participant_id: result.current.participantId };
		const second = { ...chatEvent(2), participant_id: result.current.participantId };
		act(() => {
			socket.emit("open");
			socket.emit("message", {
				data: JSON.stringify({ type: "room.ready", participants: [], events: [first, second] }),
			});
		});
		expect(result.current.pendingEvents).toHaveLength(2);
		expect(result.current.pendingEvents.every((delivery) => delivery.replayed)).toBe(true);
		unmount();
	});

	it("retains a modern host claim until the server acknowledges it", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onQuizHostCredentialAccepted = vi.fn();
		const quizOptions = {
			...options(),
			metadata: { ...options().metadata, mode: "quiz" as const, quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
			initialQuiz: {
				revision: 1,
				phase: "lobby" as const, question_index: -1, question_count: 4, current_question: null,
				deadline_at: null, remaining_seconds: 30, timer_paused: false, response_count: 0,
				eligible_count: 0, reveal: null, leaderboard: [],
				consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 },
				round_completed: false, host_connected: false,
			},
		};
		const { result, unmount } = renderHook(() => useLiveRoom({
			...quizOptions,
			quizHostCredential: { mode: "modern", value: "one-time-claim" },
			onQuizHostCredentialAccepted,
		}));
		const socket = MockWebSocket.instances[0];
		act(() => socket.emit("open"));
		const hello = JSON.parse(socket.sent[0]);
		expect(hello.quiz_host_claim).toBe("one-time-claim");
		expect(storedValues()).not.toContain("one-time-claim");

		act(() => socket.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "00000000-0000-4000-8000-000000000035", name: "Tester", color: "#fff", role: "host" },
			resume_credential: "resume-host",
			participants: [], events: [],
			quiz: { state: { ...quizOptions.initialQuiz, revision: 2, phase: "question_open", question_index: 0 }, own_submissions: { organ: { choice_id: "pancreas", answered_at: "now", response_ms: 200, name: "Tester" } }, eligible: true },
		}) }));
		expect(result.current.isHost).toBe(true);
		expect(result.current.quizEligible).toBe(true);
		expect(result.current.quizOwnSubmissions.organ.choice_id).toBe("pancreas");
		expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "host.claim_ack" });
		expect(onQuizHostCredentialAccepted).not.toHaveBeenCalled();
		act(() => socket.emit("message", { data: JSON.stringify({ type: "host.claim_acknowledged" }) }));
		expect(onQuizHostCredentialAccepted).toHaveBeenCalledOnce();
		act(() => { expect(result.current.startQuiz()).toBe(true); });
		expect(socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "quiz.start")).toBe(true);
		act(() => {
			socket.emit("close", { code: 1006 });
			vi.advanceTimersByTime(500);
			MockWebSocket.instances[1].emit("open");
		});
		const resumedHello = JSON.parse(MockWebSocket.instances[1].sent[0]);
		expect(resumedHello.resume_credential).toBe("resume-host");
		expect(resumedHello.quiz_host_claim).toBeUndefined();
		expect(storedValues()).not.toContain("one-time-claim");
		act(() => MockWebSocket.instances[1].emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "00000000-0000-4000-8000-000000000035", name: "Tester", color: "#fff", role: "host" },
			participants: [], events: [],
		}) }));
		expect(MockWebSocket.instances[1].sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "host.claim_ack" });
		expect(onQuizHostCredentialAccepted).toHaveBeenCalledOnce();
		unmount();
	});

	it("resends a modern host acknowledgment after its response is dropped without replaying the claim", () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onQuizHostCredentialAccepted = vi.fn();
		const quizOptions = {
			...options(),
			metadata: { ...options().metadata, mode: "quiz" as const },
			quizHostCredential: { mode: "modern" as const, value: "retryable-claim" },
			onQuizHostCredentialAccepted,
		};
		const { unmount } = renderHook(() => useLiveRoom(quizOptions));
		const first = MockWebSocket.instances[0];
		act(() => first.emit("open"));
		act(() => first.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "host-retry", name: "Tester", color: "#fff", role: "host" },
			resume_credential: "resume-retry",
			participants: [], events: [],
		}) }));
		expect(first.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "host.claim_ack" });
		expect(onQuizHostCredentialAccepted).not.toHaveBeenCalled();

		act(() => {
			first.emit("close", { code: 1006 });
			vi.advanceTimersByTime(500);
			MockWebSocket.instances[1].emit("open");
		});
		const second = MockWebSocket.instances[1];
		const hello = JSON.parse(second.sent[0]);
		expect(hello).toMatchObject({ participant_id: "host-retry", resume_credential: "resume-retry" });
		expect(hello.quiz_host_claim).toBeUndefined();
		expect(hello.quiz_host_secret).toBeUndefined();
		act(() => second.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "host-retry", name: "Tester", color: "#fff", role: "host" },
			participants: [], events: [],
		}) }));
		expect(second.sent.map((frame) => JSON.parse(frame))).toContainEqual({ type: "host.claim_ack" });
		expect(onQuizHostCredentialAccepted).not.toHaveBeenCalled();
		act(() => second.emit("message", { data: JSON.stringify({ type: "host.claim_acknowledged" }) }));
		expect(onQuizHostCredentialAccepted).toHaveBeenCalledOnce();
		unmount();
	});

	it("uses only the legacy host secret and clears it on host ready without an unsupported ack", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const onQuizHostCredentialAccepted = vi.fn();
		const { unmount } = renderHook(() => useLiveRoom({
			...options(),
			metadata: { ...options().metadata, mode: "quiz" },
			quizHostCredential: { mode: "legacy", value: "legacy-secret" },
			onQuizHostCredentialAccepted,
		}));
		const socket = MockWebSocket.instances[0];
		act(() => socket.emit("open"));
		const hello = JSON.parse(socket.sent[0]);
		expect(hello.quiz_host_secret).toBe("legacy-secret");
		expect(hello.quiz_host_claim).toBeUndefined();
		act(() => socket.emit("message", { data: JSON.stringify({
			type: "room.ready",
			self: { participant_id: "legacy-host", name: "Tester", color: "#fff", role: "host" },
			resume_credential: "legacy-resume",
			participants: [], events: [],
		}) }));
		expect(socket.sent.map((frame) => JSON.parse(frame)).some((frame) => frame.type === "host.claim_ack")).toBe(false);
		expect(onQuizHostCredentialAccepted).toHaveBeenCalledOnce();
		unmount();
	});

	it("uses a stored resume identity instead of a stale navigation claim after refresh", () => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const roomId = options().metadata.room_id;
		sessionStorage.setItem(`bodymaps.live-room.${roomId}.participant-credential`, JSON.stringify({
			participantId: "participant-resumed",
			resumeCredential: "credential-resumed",
		}));
		const quizOptions = {
			...options(),
			metadata: { ...options().metadata, mode: "quiz" as const },
			quizHostCredential: { mode: "modern" as const, value: "stale-claim" },
		};
		const { unmount } = renderHook(() => useLiveRoom(quizOptions));
		const socket = MockWebSocket.instances[0];
		act(() => socket.emit("open"));
		const hello = JSON.parse(socket.sent[0]);
		expect(hello.participant_id).toBe("participant-resumed");
		expect(hello.resume_credential).toBe("credential-resumed");
		expect(hello.quiz_host_claim).toBeUndefined();
		unmount();
	});
});
