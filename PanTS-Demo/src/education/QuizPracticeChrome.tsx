import { IconAlertTriangle, IconArrowLeft, IconArrowRight, IconCheck, IconFlag, IconLayoutSidebarRight, IconTrophy, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { QuizPracticeController } from "./types";

export function QuizPracticeHeader({ controller }: { controller: QuizPracticeController }) {
	return (
		<header className="lr-header edu-quiz-header">
			<div className="lr-header__identity">
				<span className="lr-live-dot" data-state="connected" />
				<div><strong>Solo VQA Practice</strong><span>Case {controller.pack.case_id} · {controller.pack.difficulty}</span></div>
			</div>
			<div className="lr-header__warning">Untimed · answer key stays server-side until submission</div>
			<div className="lr-header__actions">
				<span className="lr-status" data-state="connected">{controller.result ? `${controller.result.score}/${controller.result.max_score}` : `${controller.questionIndex + 1}/${controller.pack.questions.length}`}</span>
				<a className="lr-header-button" href={`/case/${controller.pack.case_id}`} title="Leave practice and open this case in the CT viewer">
					<IconArrowLeft size={18} /> CT viewer
				</a>
				<button className="lr-header-button" onClick={() => controller.setDockOpen(!controller.dockOpen)} aria-expanded={controller.dockOpen}>
					<IconLayoutSidebarRight size={18} /> Questions
				</button>
			</div>
		</header>
	);
}

export function QuizPracticeDock({ controller }: { controller: QuizPracticeController }) {
	const [reported, setReported] = useState(false);
	const question = controller.pack.questions[controller.questionIndex];
	const reveal = controller.result?.reveals.find((item) => item.question_id === question.id);
	const selected = controller.answers[question.id];
	return (
		<aside className="lr-dock lr-quiz-dock" aria-label="Solo VQA practice">
			<div className="lr-dock__head lr-quiz-dock__head">
				<div><span className="lr-eyebrow">{controller.pack.title}</span><strong>{controller.result ? "Review answers" : `${controller.pack.questions.length} linked ${controller.pack.questions.length === 1 ? "question" : "questions"}`}</strong></div>
				<button className="lr-dock__close" onClick={() => controller.setDockOpen(false)} aria-label="Close quiz panel"><IconX size={18} /></button>
			</div>
			<div className="lr-dock__body lr-quiz-body">
				{controller.result && controller.questionIndex === 0 && (
					<section className="lr-quiz-complete">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2>{controller.result.score}/{controller.result.max_score} correct</h2>
						<p>Response chain: {controller.result.consistency.status}.</p>
					</section>
				)}
				<section className="lr-quiz-question">
					<div className="lr-quiz-kicker">Question {controller.questionIndex + 1} of {controller.pack.questions.length}</div>
					<h2>{question.prompt}</h2>
					<fieldset className="lr-quiz-choices" disabled={Boolean(controller.result)}>
						<legend className="sr-only">Answer choices</legend>
						{question.choices.map((choice, index) => {
							const correct = reveal?.correct_choice_id === choice.id;
							const picked = selected === choice.id;
							return <button type="button" key={choice.id} className={`${picked ? "is-selected" : ""}${correct ? " is-correct" : ""}`} aria-pressed={picked} onClick={() => controller.selectAnswer(choice.id)}>
								<span>{String.fromCharCode(65 + index)}</span>{choice.label}{(picked || correct) && <IconCheck size={17} />}
							</button>;
						})}
					</fieldset>
					{reveal && <div className={`lr-quiz-personal ${selected === reveal.correct_choice_id ? "is-correct" : "is-incorrect"}`}>{selected === reveal.correct_choice_id ? "Correct" : "Incorrect"}</div>}
					{reveal?.source_label && <div className="lr-quiz-kicker">{reveal.source_label}</div>}
					{reveal && <p className="lr-quiz-explanation">{reveal.explanation}</p>}
					<div className="edu-quiz-nav">
						<button type="button" className="lr-button lr-button--secondary" onClick={controller.previous} disabled={controller.questionIndex === 0}><IconArrowLeft size={17} /> Previous</button>
						<button type="button" className="lr-button lr-button--primary" onClick={controller.next} disabled={!controller.result && (!selected || controller.submitting)}>
							{controller.submitting ? "Submitting…" : controller.questionIndex === controller.pack.questions.length - 1 && !controller.result ? "Submit" : "Next"} <IconArrowRight size={17} />
						</button>
					</div>
				</section>
				{controller.result && (
					<section className="lr-export">
						<button disabled={reported} onClick={() => void controller.reportContent("other").then(() => setReported(true)).catch(() => undefined)}><IconFlag size={16} /> {reported ? "Report recorded" : "Report content issue"}</button>
						<small>No scan data or personal information is included.</small>
					</section>
				)}
				{controller.error && <div className="lr-error" role="alert"><IconAlertTriangle size={16} /> {controller.error}</div>}
			</div>
		</aside>
	);
}
