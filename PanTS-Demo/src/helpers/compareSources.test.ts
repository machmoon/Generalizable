import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSources } from "./compareSources";

describe("comparison volume resolution", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses preview CT with full-resolution segmentation", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

		const sources = await resolveSources("35");

		expect(sources.ct).toContain("/api/get-main-nifti/35.nii.gz?res=low");
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz");
		expect(sources.seg).not.toContain("res=low");
	});
});
