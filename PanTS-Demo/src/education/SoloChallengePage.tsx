import { IconArrowRight, IconClock, IconCrosshair, IconRulerMeasure, IconSparkles } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ungzip } from "pako";
import { API_BASE } from "../helpers/constants";
import VisualizationPage from "../routes/VisualizationPage";
import {
	clearSoloChallengeSession,
	readSoloChallengeSession,
	writeSoloChallengeSession,
} from "./soloChallengeSession";
import type { EducationAttempt, EducationChallenge, EducationResult, SoloChallengeController } from "./types";
import "./soloChallenge.css";

const CHALLENGE_ID = "pancreas-case-35";

async function responseJson<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
	return body as T;
}

export default function SoloChallengePage() {
	const { challengeId = CHALLENGE_ID } = useParams<{ challengeId: string }>();
	const [restoredSession] = useState(() => readSoloChallengeSession(challengeId));
	const [challenge, setChallenge] = useState<EducationChallenge | null>(null);
	const [attempt, setAttempt] = useState<EducationAttempt | null>(restoredSession?.attempt ?? null);
	const [loading, setLoading] = useState(true);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const [findingChoice, setFindingChoice] = useState(restoredSession?.findingChoice ?? "");
	const [impression, setImpression] = useState(restoredSession?.impression ?? "");
	const [marker, setMarker] = useState<[number, number, number] | null>(restoredSession?.marker ?? null);
	const [measurement, setMeasurement] = useState(restoredSession?.measurement ?? null);
	const [result, setResult] = useState<EducationResult | null>(restoredSession?.result ?? null);
	const [maskUrl, setMaskUrl] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [retryingGrade, setRetryingGrade] = useState(false);
	const [taskDockOpen, setTaskDockOpen] = useState(true);

	useEffect(() => {
		fetch(`${API_BASE}/api/education/challenges/${challengeId}`)
			.then((response) => responseJson<EducationChallenge>(response))
			.then(setChallenge)
			.catch((caught) => setError(caught instanceof Error ? caught.message : "Challenge unavailable"))
			.finally(() => setLoading(false));
	}, [challengeId]);

	useEffect(() => {
		if (!attempt || result) return;
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, [attempt, result]);

	useEffect(() => {
		if (!attempt) return;
		writeSoloChallengeSession(challengeId, {
			attempt,
			findingChoice,
			impression,
			marker,
			measurement,
			result,
		});
	}, [attempt, challengeId, findingChoice, impression, marker, measurement, result]);

	useEffect(() => {
		if (!attempt || result) return;
		let cancelled = false;
		void fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/result`, {
			headers: { "X-Attempt-Key": attempt.attempt_key },
		}).then(async (response) => {
			if (cancelled || response.status === 400) return;
			if ([401, 404, 410].includes(response.status)) {
				clearSoloChallengeSession(challengeId);
				setAttempt(null);
				setFindingChoice("");
				setImpression("");
				setMarker(null);
				setMeasurement(null);
				return;
			}
			if (response.ok) setResult(await responseJson<EducationResult>(response));
		}).catch(() => {
			// A temporary result lookup failure should not discard recoverable local work.
		});
		return () => { cancelled = true; };
	}, [attempt, challengeId, result]);

	useEffect(() => {
		if (!attempt || !result) {
			setMaskUrl(null);
			return;
		}
		let active = true;
		let ownedUrl: string | null = null;
		void fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/reveal-segmentation.nii.gz`, {
			headers: { "X-Attempt-Key": attempt.attempt_key },
		}).then(async (response) => {
			if (!response.ok) throw new Error("Challenge reveal could not be loaded");
			const compressed = new Uint8Array(await response.arrayBuffer());
			ownedUrl = URL.createObjectURL(new Blob([new Uint8Array(ungzip(compressed))], {
				type: "application/octet-stream",
			}));
			if (active) setMaskUrl(ownedUrl);
			else URL.revokeObjectURL(ownedUrl);
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught.message : "Challenge reveal failed");
		});
		return () => {
			active = false;
			if (ownedUrl) URL.revokeObjectURL(ownedUrl);
		};
	}, [attempt, result]);

	const remainingSeconds = useMemo(() => {
		if (!attempt) return challenge?.time_limit_seconds ?? 300;
		return Math.max(0, Math.ceil((new Date(attempt.deadline_at).getTime() - now) / 1000));
	}, [attempt, challenge?.time_limit_seconds, now]);

	const start = async () => {
		setStarting(true);
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/api/education/challenges/${challengeId}/attempts`, { method: "POST" });
			setFindingChoice("");
			setImpression("");
			setMarker(null);
			setMeasurement(null);
			setResult(null);
			setMaskUrl(null);
			setAttempt(await responseJson<EducationAttempt>(response));
			setNow(Date.now());
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not start challenge");
		} finally {
			setStarting(false);
		}
	};

	const submit = useCallback(async (measurement: Parameters<SoloChallengeController["submit"]>[0], timedOut = false) => {
		if (!attempt || result || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			const fallbackImpression = "No impression was submitted before the time limit expired.";
			const response = await fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/submit`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Attempt-Key": attempt.attempt_key },
				body: JSON.stringify({
					finding_choice: findingChoice || "no_focal_lesion",
					marker_lps: marker,
					measurement: measurement ? { points: measurement.points } : null,
					impression: impression.trim() || (timedOut ? fallbackImpression : "No impression submitted."),
				}),
			});
			setResult(await responseJson<EducationResult>(response));
			setTaskDockOpen(true);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Could not submit challenge");
		} finally {
			setSubmitting(false);
		}
	}, [attempt, findingChoice, impression, marker, result, submitting]);

	const retryGrade = useCallback(async () => {
		if (!attempt || !result || result.status !== "provisional" || retryingGrade) return;
		setRetryingGrade(true);
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/retry-grade`, {
				method: "POST",
				headers: { "X-Attempt-Key": attempt.attempt_key },
			});
			setResult(await responseJson<EducationResult>(response));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "AI grading remains unavailable");
		} finally {
			setRetryingGrade(false);
		}
	}, [attempt, result, retryingGrade]);

	const clearSession = useCallback(() => {
		clearSoloChallengeSession(challengeId);
	}, [challengeId]);

	if (loading) return <ChallengeState title="Loading challenge…" />;
	if (!challenge || error && !attempt) return <ChallengeState title="Challenge unavailable" detail={error ?? undefined} />;

	if (!attempt) {
		return (
			<main className="edu-start">
				<div className="edu-start__scan" aria-hidden="true" />
				<section className="edu-start__card">
					<span className="edu-kicker">{challenge.eyebrow}</span>
					<h1>{challenge.title}</h1>
					<p>{challenge.prompt}</p>
					<div className="edu-start__facts">
						<span><IconClock size={18} /> Five minutes</span>
						<span><IconCrosshair size={18} /> 3D localization</span>
						<span><IconRulerMeasure size={18} /> Axial diameter</span>
						<span><IconSparkles size={18} /> Post-submit AI tutor</span>
					</div>
					<ol>{challenge.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ol>
					<div className="edu-start__notice">The answer overlay and BodyMaps AI stay locked until submission. This is a low-stakes educational exercise, not clinical diagnosis.</div>
					{error && <div className="edu-error" role="alert">{error}</div>}
					<button type="button" onClick={() => void start()} disabled={starting}>
						{starting ? "Preparing case…" : "Start solo challenge"} <IconArrowRight size={19} />
					</button>
				</section>
			</main>
		);
	}

	const controller: SoloChallengeController = {
		challenge,
		attempt,
		remainingSeconds,
		findingChoice,
		setFindingChoice,
		impression,
		setImpression,
		marker,
		setMarker,
		measurement,
		setMeasurement,
		result,
		maskUrl,
		submitting,
		retryingGrade,
		error,
		submit,
		retryGrade,
		taskDockOpen,
		setTaskDockOpen,
		clearSession,
	};
	return <VisualizationPage soloChallenge={controller} />;
}

function ChallengeState({ title, detail }: { title: string; detail?: string }) {
	return <main className="edu-start edu-start--state"><div><span className="edu-loading" /><h1>{title}</h1>{detail && <p>{detail}</p>}<a href="/case/35">Return to case 35</a></div></main>;
}
