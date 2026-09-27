import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dual viewer pulls the Cornerstone WebGL stack, which can't run under jsdom — mock
// the isolated setup helper so we can verify the page mounts + lays out two panes.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const { setupCompare } = vi.hoisted(() => ({ setupCompare: vi.fn() }));
vi.mock("../helpers/compareViewer", () => ({
	setupCompare,
	getOrganLabelAtPoint: vi.fn(),
	VIEWPORT_IDS: {
		aAx: "cmp_a_ax", aSag: "cmp_a_sag", aCor: "cmp_a_cor",
		bAx: "cmp_b_ax", bSag: "cmp_b_sag", bCor: "cmp_b_cor",
	},
	LENGTH_TOOL: "Length",
	BIDIRECTIONAL_TOOL: "Bidirectional",
	ANGLE_TOOL: "Angle",
	PROBE_TOOL: "Probe",
	ROI_TOOL: "RectangleROI",
	ELLIPSE_TOOL: "EllipticalROI",
	FREEHAND_ROI_TOOL: "PlanarFreehandROI",
	ARROW_TOOL: "ArrowAnnotate",
	MAGNIFY_TOOL: "AdvancedMagnify",
}));

import CompareViewerPage from "../routes/CompareViewerPage";

beforeEach(() => {
	setupCompare.mockResolvedValue({
		setLinked: vi.fn(),
		setSyncCursor: vi.fn(),
		setSegVisible: vi.fn(),
		setSegOpacity: vi.fn(),
		setOrganVisibility: vi.fn(),
		applyWindow: vi.fn(),
		applyZoom: vi.fn(),
		centerCursor: vi.fn(),
		jumpToOrgan: vi.fn(),
		refit: vi.fn(),
		resetView: vi.fn(),
		setFocusedViewport: vi.fn(),
		setReferenceLines: vi.fn(),
		flipFocused: vi.fn(),
		rotateFocused90: vi.fn(),
		startCine: vi.fn(() => true),
		stopCine: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		clearMeasurements: vi.fn(),
		getMeasurementSummaries: vi.fn(() => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(),
		subscribeToMeasurementChanges: vi.fn(() => vi.fn()),
		destroy: vi.fn(),
	});
	// resolveCtUrl does a HEAD probe; return not-ok so it falls back to the HF url.
	global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/compare-viewer" element={<CompareViewerPage />} />
			</Routes>
		</MemoryRouter>
	);

describe("CompareViewerPage", () => {
	it("mounts two labelled panes and calls setupCompare for two cases", async () => {
		renderAt("/compare-viewer?a=1&b=2");
		expect(await screen.findByText("Case 1")).toBeTruthy();
		expect(await screen.findByText("Case 2")).toBeTruthy();

		// The toolbar (and its Sync group) is hidden by default, like the single viewer's
		// top toolbar — reveal it via the floating gear, then open the Sync flyout.
		fireEvent.click(await screen.findByRole("button", { name: /toggle toolbar/i }));
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
		expect(screen.getByText(/Link scroll/i)).toBeTruthy();

		// The isolated Cornerstone setup is invoked once with both viewport elements.
		await vi.waitFor(() => expect(setupCompare).toHaveBeenCalledTimes(1));
	});

	it("prompts when ids are missing", async () => {
		renderAt("/compare-viewer");
		expect(await screen.findByText(/Provide two case ids/i)).toBeTruthy();
		expect(setupCompare).not.toHaveBeenCalled();
	});
});
