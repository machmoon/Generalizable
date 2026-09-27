import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoloChallengeController } from "./types";
import { readSoloChallengeSession, writeSoloChallengeSession } from "./soloChallengeSession";

vi.mock("../routes/VisualizationPage", () => ({
	default: ({ soloChallenge }: { soloChallenge: SoloChallengeController }) => (
		<main>
			<span>{soloChallenge.attempt.attempt_id}</span>
			<span>{soloChallenge.findingChoice}</span>
			<span>{soloChallenge.impression}</span>
			<span>{soloChallenge.marker?.join(",")}</span>
			<span>{soloChallenge.measurement?.id}</span>
			<span>{soloChallenge.maskUrl ?? "reveal hidden"}</span>
			<button onClick={() => soloChallenge.setImpression("Updated after restore")}>Update impression</button>
		</main>
	),
}));

import SoloChallengePage from "./SoloChallengePage";

const challengeId = "pancreas-case-35";
const challenge = {
	challenge_id: challengeId,
	case_id: "35",
	title: "Find the abnormal area in the pancreas",
	eyebrow: "BodyMaps Solo Challenge 01",
	prompt: "Review the CT scan.",
	time_limit_seconds: 300,
	finding_choices: [],
	requirements: [],
	scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" as const },
};

describe("SoloChallengePage session recovery", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/result")) {
				return new Response(JSON.stringify({ error: "Attempt has not been submitted" }), {
					status: 400,
				headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(challenge), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}));
	});

	afterEach(() => vi.unstubAllGlobals());

	it("restores and continues persisting an in-progress attempt after remount", async () => {
		writeSoloChallengeSession(challengeId, {
			attempt: {
				attempt_id: "attempt-restored",
				attempt_key: "key",
				challenge_id: challengeId,
				started_at: "2099-01-01T12:00:00Z",
				deadline_at: "2099-01-01T12:05:00Z",
				delete_at: "2099-01-02T12:00:00Z",
				status: "active",
			},
			findingChoice: "focal_pancreatic_lesion",
			impression: "Saved impression",
			marker: [1, 2, 3],
			measurement: {
				id: "saved-length",
				tool: "Length",
				points: [[1, 2, 3], [4, 5, 6]],
				polyline: [],
				text: "",
				label: "",
				frame_of_reference: "frame-1",
				metadata: {},
			},
			result: null,
		});

		render(
			<MemoryRouter initialEntries={[`/live/challenge/${challengeId}`]}>
				<Routes>
					<Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByText("attempt-restored")).toBeInTheDocument();
		expect(screen.getByText("focal_pancreatic_lesion")).toBeInTheDocument();
		expect(screen.getByText("Saved impression")).toBeInTheDocument();
		expect(screen.getByText("1,2,3")).toBeInTheDocument();
		expect(screen.getByText("saved-length")).toBeInTheDocument();
		expect(screen.getByText("reveal hidden")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Update impression" }));
		await waitFor(() => {
			expect(readSoloChallengeSession(challengeId)?.impression).toBe("Updated after restore");
		});
	});
});
