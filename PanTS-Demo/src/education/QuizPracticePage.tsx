import { useCallback, useEffect, useMemo, useState } from "react";
import { ungzip } from "pako";
import { useParams } from "react-router-dom";
import { API_BASE } from "../helpers/constants";
import VisualizationPage from "../routes/VisualizationPage";
import type {
	QuizPracticeController,
	QuizPracticePack,
	QuizPracticeResult,
} from "./types";
import "../liveRooms/liveRooms.css";
import "./quizPractice.css";

type Attempt = {
	attempt_id: string;
	attempt_key: string;
	pack: QuizPracticePack;
};

async function responseJson<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
	return body as T;
}

export default function QuizPracticePage() {
	const { packId = "" } = useParams<{ packId: string }>();
	const [attempt, setAttempt] = useState<Attempt | null>(null);
	const [questionIndex, setQuestionIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [result, setResult] = useState<QuizPracticeResult | null>(null);
	const [maskUrl, setMaskUrl] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dockOpen, setDockOpen] = useState(true);

	useEffect(() => {
		let active = true;
		setAttempt(null);
		setQuestionIndex(0);
		setAnswers({});
		setResult(null);
		setMaskUrl(null);
		setError(null);
		fetch(`${API_BASE}/api/education/quiz-packs/${encodeURIComponent(packId)}/attempts`, {
			method: "POST",
		}).then((response) => responseJson<Attempt>(response)).then((value) => {
			if (active) setAttempt(value);
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught.message : "Quiz practice unavailable");
		});
		return () => { active = false; };
	}, [packId]);

	useEffect(() => () => {
		if (maskUrl) URL.revokeObjectURL(maskUrl);
	}, [maskUrl]);

	const submit = useCallback(async () => {
		if (!attempt || submitting || result) return;
		setSubmitting(true);
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/api/education/quiz-attempts/${attempt.attempt_id}/submit`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Quiz-Attempt-Key": attempt.attempt_key,
				},
				body: JSON.stringify({ answers }),
			});
			const completed = await responseJson<QuizPracticeResult>(response);
			setResult(completed);
			const revealResponse = await fetch(
				`${API_BASE}/api/education/quiz-attempts/${attempt.attempt_id}/reveal-segmentation.nii.gz`,
				{ headers: { "X-Quiz-Attempt-Key": attempt.attempt_key } },
			);
			if (!revealResponse.ok) throw new Error("Quiz reveal could not be loaded");
			// Blob URLs have no `.gz` suffix, so Cornerstone cannot infer gzip handling.
			// Expose raw NIfTI bytes, matching live-room reveal-mask handling.
			const compressedMask = new Uint8Array(await revealResponse.arrayBuffer());
			setMaskUrl(URL.createObjectURL(new Blob([
				new Uint8Array(ungzip(compressedMask)),
			], { type: "application/octet-stream" })));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Quiz could not be submitted");
		} finally {
			setSubmitting(false);
		}
	}, [answers, attempt, result, submitting]);

	const next = useCallback(() => {
		if (!attempt) return;
		if (result) {
			setQuestionIndex((current) => Math.min(attempt.pack.questions.length - 1, current + 1));
			return;
		}
		const question = attempt.pack.questions[questionIndex];
		if (!answers[question.id]) return;
		if (questionIndex === attempt.pack.questions.length - 1) {
			void submit();
		} else {
			setQuestionIndex((current) => current + 1);
		}
	}, [answers, attempt, questionIndex, result, submit]);

	const reportContent = useCallback(async (category: string) => {
		if (!attempt) return;
		try {
			const response = await fetch(`${API_BASE}/api/education/quiz-packs/${encodeURIComponent(attempt.pack.pack_id)}/reports`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ category, mode: "solo" }),
			});
			await responseJson(response);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Content report could not be recorded");
			throw caught;
		}
	}, [attempt]);

	const controller = useMemo<QuizPracticeController | null>(() => attempt ? ({
		pack: attempt.pack,
		questionIndex,
		answers,
		result,
		maskUrl,
		submitting,
		error,
		dockOpen,
		setDockOpen,
		selectAnswer: (choiceId) => {
			if (result) return;
			const question = attempt.pack.questions[questionIndex];
			setAnswers((current) => ({ ...current, [question.id]: choiceId }));
		},
		previous: () => setQuestionIndex((current) => Math.max(0, current - 1)),
		next,
		reportContent,
	}) : null, [answers, attempt, dockOpen, error, maskUrl, next, questionIndex, reportContent, result, submitting]);

	if (error && !attempt) return (
		<main className="lr-page lr-page--center"><div className="lr-expired" role="alert"><h1>Quiz practice unavailable</h1><p>{error}</p><a className="lr-button lr-button--primary" href="/dashboard">Return to dashboard</a></div></main>
	);
	if (!controller) return <main className="lr-page lr-page--center" role="status"><div className="lr-loading-ring" /><p>Preparing quiz pack…</p></main>;
	return <VisualizationPage quizPractice={controller} />;
}
