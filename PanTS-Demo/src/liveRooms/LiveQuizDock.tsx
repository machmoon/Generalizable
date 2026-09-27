import { IconCheck, IconClock, IconCloudDownload, IconCrown, IconFileTypePdf, IconMessage, IconPlayerPlay, IconTrophy, IconUsersGroup, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { LiveRoomController } from "./types";


function formatTimer(deadline: string | null, pausedSeconds: number | null, now: number): string {
	if (!deadline) return pausedSeconds == null ? "Untimed" : `${Math.max(0, Math.ceil(pausedSeconds))}s`;
	return `${Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000))}s`;
}

function QuizChat({ room }: { room: LiveRoomController }) {
	const [message, setMessage] = useState("");
	return (
		<section className="lr-quiz-chat" aria-label="Room chat">
			<div className="lr-quiz-section-title"><IconMessage size={15} /> Room chat</div>
			<div className="lr-chat-list" aria-live="polite">
				{room.state.chat.length === 0 ? <div className="lr-empty">No messages yet.</div> : room.state.chat.slice(-30).map((item) => (
					<article className="lr-message" key={item.id}>
						<div><strong>{item.author}</strong>{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
						<p>{item.text}</p>
					</article>
				))}
			</div>
			<form className="lr-chat-compose" onSubmit={async (event) => {
				event.preventDefault();
				if (message.trim() && await room.sendChat(message.trim())) setMessage("");
			}}>
				<label htmlFor="lr-quiz-chat">Room message</label>
				<textarea id="lr-quiz-chat" maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message everyone…" />
				<button disabled={!message.trim()}>Send</button>
			</form>
		</section>
	);
}

export default function LiveQuizDock({ room, onClose }: { room: LiveRoomController; onClose: () => void }) {
	const quiz = room.quiz;
	const [now, setNow] = useState(Date.now());
	const [pendingChoice, setPendingChoice] = useState<string | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => setPendingChoice(null), [quiz?.current_question?.id]);
	useEffect(() => {
		if (room.error) setPendingChoice(null);
	}, [room.error]);

	if (!quiz) return <aside className="lr-dock lr-quiz-dock" aria-label="Live Quiz"><div className="lr-empty">Loading quiz…</div></aside>;
	const question = quiz.current_question;
	const ownSubmission = question ? room.quizOwnSubmissions[question.id] : undefined;
	const submittedChoice = ownSubmission?.choice_id ?? pendingChoice;
	const chatAllowed = ["lobby", "question_revealed", "completed"].includes(quiz.phase);
	const totalRevealed = quiz.reveal ? Object.values(quiz.reveal.distribution).reduce((sum, count) => sum + count, 0) : 0;
	const statusText = quiz.timer_paused
		? "Timer paused while the host reconnects"
		: quiz.phase === "question_open"
			? `Question ${quiz.question_index + 1} open. ${quiz.response_count} of ${quiz.eligible_count} answered.`
			: quiz.phase.replaceAll("_", " ");
	const personalCorrect = Boolean(ownSubmission && quiz.reveal && ownSubmission.choice_id === quiz.reveal.correct_choice_id);
	const selfRow = quiz.leaderboard.find((item) => item.participant_id === room.participantId);
	const exportsAvailable = quiz.phase === "completed" || (
		quiz.phase === "question_revealed" && quiz.question_index + 1 === quiz.question_count
	);

	return (
		<aside className="lr-dock lr-quiz-dock" aria-label="Live Quiz">
			<div className="lr-dock__head lr-quiz-dock__head">
				<div>
					<span className="lr-eyebrow">Individual Race · Case {room.metadata.case_id}</span>
					<strong>{room.isHost ? <><IconCrown size={15} /> You are host</> : "Private answer room"}</strong>
				</div>
				<button className="lr-dock__close" onClick={onClose} aria-label="Close quiz panel"><IconX size={18} /></button>
			</div>

			<div className="lr-quiz-status" aria-live="polite" aria-atomic="true">
				<span><IconClock size={16} /> {formatTimer(quiz.deadline_at, quiz.remaining_seconds, now)}</span>
				<span>{quiz.response_count}/{quiz.eligible_count} answered</span>
				<span className="sr-only">{statusText}</span>
			</div>

			<div className="lr-dock__body lr-quiz-body">
				{quiz.phase === "lobby" && (
					<section className="lr-quiz-lobby">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2>{quiz.question_count} linked questions</h2>
						<p>One point per correct answer. Ties use total response time; logical consistency is reported separately.</p>
						{room.isHost ? (
							<button className="lr-button lr-button--primary lr-button--wide" onClick={room.startQuiz} disabled={room.connectionState !== "connected"}>
								<IconPlayerPlay size={17} /> Start race
							</button>
						) : <div className="lr-banner">Waiting for the host to start.</div>}
					</section>
				)}

				{question && ["question_open", "question_closed"].includes(quiz.phase) && (
					<section className="lr-quiz-question">
						<div className="lr-quiz-kicker">Question {quiz.question_index + 1} of {quiz.question_count}</div>
						<h2>{question.prompt}</h2>
						{quiz.phase === "question_open" && !room.isHost && !room.quizEligible && (
							<div className="lr-banner">You joined during this question. Observe now; you become eligible on the next one.</div>
						)}
						<fieldset className="lr-quiz-choices" disabled={quiz.phase !== "question_open" || room.isHost || !room.quizEligible || Boolean(ownSubmission || pendingChoice) || quiz.timer_paused}>
							<legend className="sr-only">Answer choices</legend>
							{question.choices.map((choice, index) => (
								<button
									type="button"
									key={choice.id}
									className={submittedChoice === choice.id ? "is-selected" : ""}
									aria-pressed={submittedChoice === choice.id}
									onClick={() => {
										if (room.answerQuiz(choice.id)) setPendingChoice(choice.id);
									}}
								>
									<span>{String.fromCharCode(65 + index)}</span>{choice.label}
									{submittedChoice === choice.id && <IconCheck size={17} />}
								</button>
							))}
						</fieldset>
						{ownSubmission && <div className="lr-quiz-locked" role="status"><IconCheck size={16} /> Answer locked privately</div>}
						{room.isHost && quiz.phase === "question_open" && (
							<button className="lr-button lr-button--secondary lr-button--wide" onClick={room.closeQuiz}>Close question early</button>
						)}
						{room.isHost && quiz.phase === "question_closed" && (
							<button className="lr-button lr-button--primary lr-button--wide" onClick={room.revealQuiz}>Reveal result</button>
						)}
						{!room.isHost && quiz.phase === "question_closed" && <div className="lr-banner">Question closed. Waiting for the host to reveal.</div>}
					</section>
				)}

				{question && quiz.phase === "question_revealed" && quiz.reveal && (
					<section className="lr-quiz-reveal">
						<div className="lr-quiz-kicker">Result · Question {quiz.question_index + 1}</div>
						<h2>{question.prompt}</h2>
						<div className={`lr-quiz-personal ${ownSubmission ? (personalCorrect ? "is-correct" : "is-incorrect") : ""}`}>
							{room.isHost ? "Host view" : ownSubmission ? (personalCorrect ? "Your answer is correct" : "Your answer is incorrect") : "No answer recorded"}
						</div>
						{quiz.reveal.source_label && <div className="lr-quiz-kicker">{quiz.reveal.source_label}</div>}
						<p className="lr-quiz-explanation">{quiz.reveal.explanation}</p>
						<div className="lr-quiz-distribution" aria-label="Answer distribution">
							{question.choices.map((choice) => {
								const count = quiz.reveal?.distribution[choice.id] ?? 0;
								const percent = totalRevealed ? Math.round(count / totalRevealed * 100) : 0;
								return <div key={choice.id} className={choice.id === quiz.reveal?.correct_choice_id ? "is-correct" : ""}>
									<span>{choice.label}</span><strong>{count}</strong>
									<i style={{ width: `${percent}%` }} />
								</div>;
							})}
						</div>
						{room.isHost && <button className="lr-button lr-button--primary lr-button--wide" onClick={room.advanceQuiz}>
							{quiz.question_index + 1 === quiz.question_count ? "Finish race" : "Next question"}
						</button>}
					</section>
				)}

				{quiz.phase === "completed" && (
					<section className="lr-quiz-complete">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2>Race complete</h2>
						<p>Create a new room to run another round.</p>
					</section>
				)}

				{quiz.leaderboard.length > 0 && ["question_revealed", "completed"].includes(quiz.phase) && (
					<section className="lr-quiz-leaderboard">
						<div className="lr-quiz-section-title"><IconTrophy size={15} /> Leaderboard</div>
						{quiz.leaderboard.map((row) => <div className={row.participant_id === room.participantId ? "is-self" : ""} key={row.participant_id}>
							<b>#{row.rank}</b><span>{row.name}</span><strong>{row.score}/{row.max_score}</strong><small>{(row.total_response_ms / 1000).toFixed(1)}s · {row.consistency.status}</small>
						</div>)}
						{selfRow?.consistency.reasons.map((reason) => <p className="lr-quiz-consistency" key={reason}>{reason}</p>)}
					</section>
				)}

				<section className="lr-quiz-people">
					<div className="lr-quiz-section-title"><IconUsersGroup size={15} /> {room.participants.length} connected</div>
					{room.participants.map((participant) => <div key={participant.participant_id}><span className="lr-avatar" style={{ background: participant.color }}>{participant.name.slice(0, 1).toUpperCase()}</span><strong>{participant.name}{participant.participant_id === room.participantId ? " (you)" : ""}</strong><small>{participant.role}</small></div>)}
				</section>

				{chatAllowed && <QuizChat room={room} />}
				{!chatAllowed && <div className="lr-banner"><IconMessage size={15} /> Chat and editing return after reveal.</div>}
				{exportsAvailable && <section className="lr-export" aria-label="Quiz exports">
					<button onClick={() => void room.downloadExport("zip").catch((caught) => setExportError(caught.message))}><IconCloudDownload size={16} /> Export quiz ZIP</button>
					<button onClick={() => void room.downloadExport("pdf").catch((caught) => setExportError(caught.message))}><IconFileTypePdf size={16} /> PDF</button>
					{exportError && <div className="lr-error" role="alert">{exportError}</div>}
					<small>For research and education use only. Room deletes after 24 hours.</small>
				</section>}
				{room.error && <div className="lr-error" role="alert">{room.error}</div>}
			</div>
		</aside>
	);
}
