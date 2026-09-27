import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { gzip } from "pako";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizPracticeController } from "./types";

vi.mock("../routes/VisualizationPage", () => ({
	default: ({ quizPractice }: { quizPractice: QuizPracticeController }) => (
		<main>
			<span>{quizPractice.maskUrl ?? "no-mask"}</span>
			<button onClick={() => quizPractice.selectAnswer("pancreas")}>Select answer</button>
			<button onClick={quizPractice.next}>Next</button>
		</main>
	),
}));

import QuizPracticePage from "./QuizPracticePage";

function readBlob(blob: Blob): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
}

const pack = {
	pack_id: "radworld-case-35-v1",
	version: 1,
	case_id: "35",
	title: "Case 35",
	difficulty: "easy" as const,
	provenance: {},
	generator_version: "test",
	validator_version: "test",
	questions: [{
		id: "organ",
		prompt: "Which organ?",
		choices: [{ id: "pancreas", label: "Pancreas" }],
	}],
};

const result = {
	attempt_id: "attempt-1",
	pack_id: pack.pack_id,
	pack_version: 1,
	case_id: "35",
	status: "completed",
	completed_at: "2026-08-13T00:00:00Z",
	score: 1,
	max_score: 1,
	answers: { organ: "pancreas" },
	consistency: { status: "consistent", reasons: [] },
	reveals: [],
};

describe("QuizPracticePage reveal mask", () => {
	let createdBlob: Blob | null;
	const rawNifti = new Uint8Array([92, 1, 0, 0, 110, 43, 49, 0]);

	beforeEach(() => {
		createdBlob = null;
		Object.assign(URL, {
			createObjectURL: vi.fn((blob: Blob) => {
				createdBlob = blob;
				return "blob:quiz-mask";
			}),
			revokeObjectURL: vi.fn(),
		});
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/attempts")) {
				return new Response(JSON.stringify({
					attempt_id: "attempt-1",
					attempt_key: "secret",
					pack,
				}), { status: 201, headers: { "Content-Type": "application/json" } });
			}
			if (url.endsWith("/submit")) {
				return new Response(JSON.stringify(result), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.endsWith("/reveal-segmentation.nii.gz")) {
				return new Response(gzip(rawNifti), { status: 200 });
			}
			throw new Error(`Unexpected request: ${url}`);
		}));
	});

	afterEach(() => vi.unstubAllGlobals());

	it("decompresses gzip before creating suffix-less reveal blob URL", async () => {
		render(
			<MemoryRouter initialEntries={[`/learn/quiz/${pack.pack_id}`]}>
				<Routes>
					<Route path="/learn/quiz/:packId" element={<QuizPracticePage />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByText("no-mask")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Select answer" }));
		fireEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(await screen.findByText("blob:quiz-mask")).toBeInTheDocument();
		await waitFor(() => expect(createdBlob).not.toBeNull());
		expect(new Uint8Array(await readBlob(createdBlob!))).toEqual(rawNifti);
		expect(createdBlob!.type).toBe("application/octet-stream");
	});
});
