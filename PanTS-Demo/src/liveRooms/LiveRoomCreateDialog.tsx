import { IconArrowLeft, IconBolt, IconClipboardCheck, IconClockPlay, IconUsersGroup, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../helpers/constants";
import { liveRoomRoute } from "./protocol";
import type { LiveQuizHostCredential } from "./types";
import "./liveRooms.css";

type Props = {
	caseId: string;
	open: boolean;
	onClose: () => void;
};

type QuizPlaylist = {
	playlist_id: string;
	title: string;
	description: string;
	pack_count: number;
};

export default function LiveRoomCreateDialog({ caseId, open, onClose }: Props) {
	const navigate = useNavigate();
	const [name, setName] = useState(() => sessionStorage.getItem("bodymaps.live-room.name") || "");
	const [resolution, setResolution] = useState<"low" | "full">("low");
	const [mode, setMode] = useState<"choose" | "review" | "quiz">("choose");
	const [quizTimer, setQuizTimer] = useState<"untimed" | "15" | "30" | "60">("30");
	const [quizSource, setQuizSource] = useState(() => String(caseId) === "35" ? "pack:radworld-case-35-v1" : "playlist:mixed-challenge-v1");
	const [playlists, setPlaylists] = useState<QuizPlaylist[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setMode("choose");
		setQuizSource(String(caseId) === "35" ? "pack:radworld-case-35-v1" : "playlist:mixed-challenge-v1");
	}, [caseId, open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !submitting) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, open, submitting]);

	useEffect(() => {
		if (!open) return;
		let active = true;
		fetch(`${API_BASE}/api/education/quiz-playlists`)
			.then((response) => response.ok ? response.json() : Promise.reject(new Error("Playlist request failed")))
			.then((body) => { if (active && Array.isArray(body.playlists)) setPlaylists(body.playlists); })
			.catch(() => { if (active) setPlaylists([]); });
		return () => { active = false; };
	}, [open]);

	if (!open) return null;

	if (mode === "choose") {
		const educationAvailable = String(caseId) === "35";
		return (
			<div className="lr-modal-backdrop" role="presentation" onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}>
				<section className="lr-modal lr-mode-menu" role="dialog" aria-modal="true" aria-labelledby="lr-mode-title">
					<div className="lr-modal__head">
						<div><span className="lr-eyebrow">Case {caseId}</span><h2 id="lr-mode-title">Live Rooms</h2></div>
						<button type="button" className="lr-icon-button" onClick={onClose} aria-label="Close"><IconX size={20} /></button>
					</div>
					<p className="lr-modal__intro">Choose how you want to review this scan.</p>
					<div className="lr-mode-grid">
						<button type="button" className="lr-mode-card" onClick={() => setMode("review")}>
							<span><IconUsersGroup size={21} /></span><strong>Collaborative Review</strong><small>Share one editable scan with up to eight people.</small>
						</button>
						<button type="button" className="lr-mode-card lr-mode-card--challenge" disabled={!educationAvailable} onClick={() => navigate("/live/challenge/pancreas-case-35")}>
							<span><IconClockPlay size={21} /></span><strong>Solo Challenge</strong><small>{educationAvailable ? "Five-minute case: locate, measure, and interpret." : "The first curated challenge uses case 35."}</small>
						</button>
							<button type="button" className="lr-mode-card lr-mode-card--quiz" onClick={() => setMode("quiz")}>
								<span><IconBolt size={21} /></span><strong>Individual Race</strong><small>Live linked-question race with private answers.</small>
							</button>
							<button type="button" className="lr-mode-card" onClick={() => navigate("/learn/quiz/radworld-case-35-v1")}>
								<span><IconClipboardCheck size={21} /></span><strong>Solo VQA Practice</strong><small>Untimed linked-question pack with answer review.</small>
						</button>
					</div>
				</section>
			</div>
		);
	}

	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		const cleanName = name.trim();
		if (!cleanName) {
			setError("Enter a display name.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/api/live-rooms`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					case_id: caseId,
					resolution,
					mode: mode === "quiz" ? "quiz" : "review",
						...(mode === "quiz" ? {
							...(quizSource.startsWith("playlist:")
								? { quiz_playlist_id: quizSource.slice("playlist:".length), quiz_playlist_seed: crypto.randomUUID() }
								: { quiz_pack_id: quizSource.slice("pack:".length) }),
							quiz_timer_seconds: quizTimer === "untimed" ? null : Number(quizTimer),
					} : {}),
				}),
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error || `Could not create room (${response.status})`);
			const quizHostCredential: LiveQuizHostCredential | undefined = typeof body.quiz_host_claim === "string"
				? { mode: "modern", value: body.quiz_host_claim }
				: typeof body.quiz_host_secret === "string"
					? { mode: "legacy", value: body.quiz_host_secret }
					: undefined;
			sessionStorage.setItem("bodymaps.live-room.name", cleanName);
			sessionStorage.setItem(`bodymaps.live-room.${body.room_id}.case-id`, String(body.case_id));
			navigate(liveRoomRoute(String(body.room_id), String(body.room_key)), {
				state: {
					liveRoomCreation: {
						creatorName: cleanName,
						quizHostCredential,
					},
				},
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not create Live Room");
			setSubmitting(false);
		}
	};

	return (
		<div className="lr-modal-backdrop" role="presentation" onMouseDown={(event) => {
			if (event.target === event.currentTarget && !submitting) onClose();
		}}>
			<form className="lr-modal" role="dialog" aria-modal="true" aria-labelledby="lr-create-title" onSubmit={create}>
				<div className="lr-modal__head">
					<div className="lr-modal__title-row">
						<button type="button" className="lr-back-button" onClick={() => setMode("choose")} aria-label="Back to room modes"><IconArrowLeft size={18} /></button>
						<div>
						<span className="lr-eyebrow">Case {caseId}</span>
						<h2 id="lr-create-title">{mode === "quiz" ? "Start an Individual Race" : "Start a Live Room"}</h2>
						</div>
					</div>
					<button type="button" className="lr-icon-button" onClick={onClose} aria-label="Close" disabled={submitting}>
						<IconX size={20} />
					</button>
				</div>
				<p className="lr-modal__intro">{mode === "quiz" ? "Host one private-answer linked-question race. No account required." : "Share link. Review one scan together. No account required."}</p>
				<label className="lr-field">
					<span>Display name</span>
					<input autoFocus maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
				</label>
				<fieldset className="lr-resolution">
					<legend>Resolution</legend>
					<label className={resolution === "low" ? "is-selected" : ""}>
						<input type="radio" name="resolution" checked={resolution === "low"} onChange={() => setResolution("low")} />
						<span><strong>Fast preview</strong><small>Recommended for smooth collaboration</small></span>
					</label>
					<label className={resolution === "full" ? "is-selected" : ""}>
						<input type="radio" name="resolution" checked={resolution === "full"} onChange={() => setResolution("full")} />
						<span><strong>Full resolution</strong><small>Available when server copy exists</small></span>
					</label>
				</fieldset>
					{mode === "quiz" && (
						<>
						<fieldset className="lr-resolution lr-quiz-source">
							<legend>Quiz pack</legend>
							<label className={quizSource === "pack:radworld-case-35-v1" ? "is-selected" : ""}>
								<input type="radio" name="quiz-source" disabled={String(caseId) !== "35"} checked={quizSource === "pack:radworld-case-35-v1"} onChange={() => setQuizSource("pack:radworld-case-35-v1")} />
								<span><strong>Case 35</strong><small>{String(caseId) === "35" ? "Reviewed fixed regression pack" : "Open Case 35 to use this fixed pack"}</small></span>
							</label>
							{playlists.map((playlist) => (
								<label className={quizSource === `playlist:${playlist.playlist_id}` ? "is-selected" : ""} key={playlist.playlist_id}>
									<input type="radio" name="quiz-source" disabled={playlist.pack_count === 0} checked={quizSource === `playlist:${playlist.playlist_id}`} onChange={() => setQuizSource(`playlist:${playlist.playlist_id}`)} />
									<span><strong>{playlist.title}</strong><small>{playlist.pack_count} packs</small></span>
								</label>
							))}
						</fieldset>
						<fieldset className="lr-resolution lr-quiz-timer">
						<legend>Per-question timer</legend>
						{(["untimed", "15", "30", "60"] as const).map((value) => (
							<label className={quizTimer === value ? "is-selected" : ""} key={value}>
								<input type="radio" name="quiz-timer" value={value} checked={quizTimer === value} onChange={() => setQuizTimer(value)} />
								<span><strong>{value === "untimed" ? "Untimed" : `${value} seconds`}</strong></span>
							</label>
						))}
						</fieldset>
						</>
					)}
				<div className="lr-capability-note">
					<IconUsersGroup size={18} />
					<span>{mode === "quiz" ? "The participant link never contains the host credential. Answers stay private until reveal." : "Anyone with link can edit. Room supports 8 people and expires after 24 hours."}</span>
				</div>
				{error && <div className="lr-error" role="alert">{error}</div>}
				<div className="lr-modal__actions">
					<button type="button" className="lr-button lr-button--secondary" onClick={onClose} disabled={submitting}>Cancel</button>
					<button className="lr-button lr-button--primary" disabled={submitting || !name.trim()}>
						{submitting ? "Creating…" : mode === "quiz" ? "Create Race Room" : "Create Live Room"}
					</button>
				</div>
			</form>
		</div>
	);
}
