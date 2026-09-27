import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const setImageIdIndex = vi.fn();
const viewport = {
	setStack: vi.fn().mockResolvedValue(undefined),
	render: vi.fn(),
	setImageIdIndex,
};

vi.mock("@cornerstonejs/core", () => ({
	init: vi.fn().mockResolvedValue(undefined),
	Enums: { ViewportType: { STACK: "STACK" } },
	RenderingEngine: class {
		enableElement() {}
		getViewport() { return viewport; }
		destroy() {}
	},
}));

vi.mock("../../helpers/dicomLocal", () => ({
	loadLocalDicomSeries: vi.fn().mockResolvedValue({
		imageIds: ["slice-0", "slice-1", "slice-2", "slice-3"],
	}),
}));

import DicomPreview from "./DicomPreview";

describe("DicomPreview", () => {
	it("uses the loaded series length when scrolling from the middle slice", async () => {
		const { container } = render(<DicomPreview files={[new File(["dcm"], "slice.dcm")]} />);
		await screen.findByText("3 / 4");

		fireEvent.wheel(container.querySelector(".ct-preview-canvas") as HTMLElement, {
			deltaY: 1,
		});

		await waitFor(() => expect(setImageIdIndex).toHaveBeenLastCalledWith(3));
		expect(screen.getByText("4 / 4")).toBeInTheDocument();
	});
});
