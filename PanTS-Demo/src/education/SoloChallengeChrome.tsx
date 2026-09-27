import {
	IconCheck,
	IconClock,
	IconCrosshair,
	IconMessageCircle,
	IconRefresh,
	IconRulerMeasure,
	IconSend,
	IconSparkles,
	IconTargetArrow,
	IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { API_BASE } from "../helpers/constants";
import type { MeasurementSummary, SharedMeasurement } from "../helpers/CornerstoneNifti2";
import type { SoloChallengeController } from "./types";

function clock(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function SoloChallengeHeader({ controller }: { controller: SoloChallengeController }) {
	const urgent = controller.remainingSeconds <= 60 && !controller.result;
	return (
		<header className="edu-header">
			<div className="edu-header__identity">
				<span className="edu-header__index">01</span>
				<div><strong>Solo Challenge</strong><span>Case {controller.challenge.case_id} · Pancreas CT</span></div>
			</div>
			<div className="edu-header__prompt">Find · measure · interpret</div>
			<div className="edu-header__actions">
				<div className={`edu-timer ${urgent ? "is-urgent" : ""}`} aria-live="polite">
					<IconClock size={17} />
					<strong>{controller.result ? clock(controller.result.elapsed_seconds) : clock(controller.remainingSeconds)}</strong>
					<span>{controller.result ? "elapsed" : "remaining"}</span>
				</div>
				<button type="button" onClick={() => controller.setTaskDockOpen(!controller.taskDockOpen)} aria-expanded={controller.taskDockOpen}>
					<IconTargetArrow size={18} /> {controller.result ? "Results" : "Task"}
				</button>
			</div>
		</header>
	);
}

export function SoloChallengeDock({
	controller,
	crosshair,
	measurement,
	serializedMeasurement,
	onSetMarker,
	onActivateMeasure,
	onSubmit,
}: {
	controller: SoloChallengeController;
	crosshair: [number, number, number] | null;
	measurement: MeasurementSummary | null;
	serializedMeasurement: SharedMeasurement | null;
	onSetMarker: () => void;
	onActivateMeasure: () => void;
	onSubmit: () => void;
}) {
	const abnormalChoice = controller.findingChoice && controller.findingChoice !== "no_focal_lesion";
	const ready = Boolean(
		controller.findingChoice
		&& controller.impression.trim()
		&& (!abnormalChoice || controller.marker && serializedMeasurement),
	);
	return (
		<aside className="edu-dock" aria-label={controller.result ? "Challenge results" : "Solo challenge task"}>
			<div className="edu-dock__head">
				<div><span className="edu-kicker">{controller.result ? "Attempt complete" : controller.challenge.eyebrow}</span><strong>{controller.result ? "Review your result" : controller.challenge.title}</strong></div>
				<button type="button" aria-label="Close task panel" onClick={() => controller.setTaskDockOpen(false)}><IconX size={18} /></button>
			</div>
			{controller.result ? <ChallengeResult controller={controller} /> : (
				<div className="edu-dock__body">
					<p className="edu-task-prompt">{controller.challenge.prompt}</p>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>01</span><strong>Classify the finding</strong></div>
						<div className="edu-findings">
							{controller.challenge.finding_choices.map((choice) => (
								<label key={choice.id} className={controller.findingChoice === choice.id ? "is-selected" : ""}>
									<input type="radio" name="finding" checked={controller.findingChoice === choice.id} onChange={() => controller.setFindingChoice(choice.id)} />
									<span>{choice.label}</span>
								</label>
							))}
						</div>
					</section>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>02</span><strong>Place the 3D marker</strong>{controller.marker && <IconCheck size={16} />}</div>
						<p>Move the crosshair to the center of the finding, then lock that position.</p>
						<button type="button" className="edu-secondary-action" disabled={!crosshair} onClick={onSetMarker}>
							<IconCrosshair size={17} /> {controller.marker ? "Update finding marker" : "Set finding marker"}
						</button>
						{controller.marker && <code>{controller.marker.map((value) => Math.round(value)).join(", ")} mm</code>}
					</section>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>03</span><strong>Measure the abnormal area</strong>{measurement && <IconCheck size={16} />}</div>
						<p>In the axial (top-down) CT view, draw a line across the widest part of the abnormal area. This records its size in millimeters.</p>
						<button type="button" className="edu-secondary-action" onClick={onActivateMeasure}><IconRulerMeasure size={17} /> Start measuring</button>
						{measurement && <code>{measurement.value}</code>}
					</section>
					<section className="edu-task-section">
						<label htmlFor="edu-impression"><span>04</span><strong>Radiology impression</strong></label>
						<textarea id="edu-impression" value={controller.impression} maxLength={2000} onChange={(event) => controller.setImpression(event.target.value)} placeholder="Write a concise finding, location, supporting observation, and calibrated conclusion…" />
						<small>{controller.impression.length}/2000</small>
					</section>
					{controller.error && <div className="edu-error" role="alert">{controller.error}</div>}
					<button type="button" className="edu-submit" disabled={!ready || controller.submitting} onClick={onSubmit}>
						{controller.submitting ? "Grading attempt…" : "Submit interpretation"} <IconSend size={17} />
					</button>
					<small className="edu-submit-note">Submission is final. BodyMaps AI remains locked until this attempt ends.</small>
				</div>
			)}
		</aside>
	);
}

function ChallengeResult({ controller }: { controller: SoloChallengeController }) {
	const result = controller.result!;
	const [question, setQuestion] = useState("");
	const [messages, setMessages] = useState<Array<{ role: "student" | "tutor"; text: string }>>([]);
	const [sending, setSending] = useState(false);
	const tutorUnavailable = result.status === "provisional";
	const scoreRows = useMemo(() => [
		["Localization", result.scores.localization.points, 35],
		["Measurement", result.scores.measurement.points, 15],
		["Finding", result.scores.finding.points, 10],
		["Impression", result.ai_grade.points, 40],
	] as const, [result]);

	const send = async () => {
		const text = question.trim();
		if (!text || sending) return;
		setQuestion("");
		setMessages((current) => [...current, { role: "student", text }]);
		setSending(true);
		try {
			const response = await fetch(`${API_BASE}/api/education/attempts/${controller.attempt.attempt_id}/tutor`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Attempt-Key": controller.attempt.attempt_key },
				body: JSON.stringify({ message: text, history: messages.slice(-6) }),
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error || "Tutor unavailable");
			setMessages((current) => [...current, { role: "tutor", text: body.reply }]);
		} catch {
			setMessages((current) => [...current, { role: "tutor", text: "The AI tutor is unavailable. Review the revealed overlay and teaching points below." }]);
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="edu-result">
			<div className="edu-result__score">
				<div><strong>{result.total_points === null ? `${result.objective_points}` : result.total_points}</strong><span>/{result.total_points === null ? "60" : "100"}</span></div>
				<p>{result.status === "provisional" ? "Objective score · AI grade pending" : "Final accuracy score"}</p>
			</div>
			<div className="edu-score-list">
				{scoreRows.map(([label, points, maximum]) => (
					<div key={label}><span>{label}</span><div><i style={{ width: `${((points ?? 0) / maximum) * 100}%` }} /></div><strong>{points ?? "—"}/{maximum}</strong></div>
				))}
			</div>
			<section className="edu-result__truth">
				<span className="edu-kicker">Correct answer</span>
				<h3>{result.ground_truth.correct_finding_label}</h3>
				<div className="edu-truth-facts">
					<div><span>Location</span><strong>{result.ground_truth.location}</strong></div>
					<div><span>Widest size</span><strong>{result.ground_truth.reference_diameter_mm} mm</strong></div>
				</div>
				<h4>What to remember</h4>
				<ul>{result.ground_truth.teaching_points.map((point) => <li key={point}>{point}</li>)}</ul>
			</section>
			<section className="edu-result__feedback">
				<div><IconSparkles size={18} /><strong>BodyMaps AI rubric</strong></div>
				<p>{result.ai_grade.feedback || "AI grading is temporarily unavailable. Your objective result is preserved as provisional."}</p>
				{result.ai_grade.criteria && <div className="edu-rubric">{Object.entries(result.ai_grade.criteria).map(([criterion, points]) => <span key={criterion}><strong>{points}/10</strong>{criterion}</span>)}</div>}
				{result.status === "provisional" && (
					<button type="button" className="edu-retry" onClick={() => void controller.retryGrade()} disabled={controller.retryingGrade}>
						<IconRefresh size={15} /> {controller.retryingGrade ? "Retrying AI grade…" : "Retry AI grade"}
					</button>
				)}
				{controller.error && <div className="edu-error" role="alert">{controller.error}</div>}
			</section>
			<section className="edu-tutor">
				<div><IconMessageCircle size={18} /><strong>Discuss this case</strong></div>
				{messages.map((message, index) => <p key={`${message.role}-${index}`} data-role={message.role}>{message.text}</p>)}
				{sending && (
					<p className="edu-tutor__pending" data-role="tutor" role="status" aria-label="AI tutor is thinking">
						<span aria-hidden="true"><i /><i /><i /></span>
					</p>
				)}
				<form onSubmit={(event) => { event.preventDefault(); void send(); }}>
					<textarea
						value={question}
						onChange={(event) => setQuestion(event.target.value)}
						placeholder={tutorUnavailable
							? "AI tutor becomes available after the impression grade is complete."
							: "Ask why the measurement or impression was scored this way…"}
						disabled={tutorUnavailable || sending}
					/>
					<button
						type="submit"
						aria-label="Send question to AI tutor"
						title="Send question"
						disabled={!question.trim() || tutorUnavailable || sending}
					>
						<IconSend size={16} />
					</button>
				</form>
			</section>
			<a className="edu-finish" href="/case/35" onClick={controller.clearSession}>Exit to case 35</a>
		</div>
	);
}
