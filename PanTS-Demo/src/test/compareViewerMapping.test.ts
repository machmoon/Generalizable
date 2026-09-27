import { describe, expect, it } from "vitest";
import { fitAffine, fitCaseMapping, fitPerAxisLinear, type Vec3 } from "../helpers/compareViewer";

// A known affine transform (rotation + anisotropic scale + translation) used to generate
// synthetic landmark pairs — if the fit is correct, applying it to a point NOT in the fit
// set should still land close to the point the same known transform would produce.
const applyKnownAffine = ([x, y, z]: Vec3): Vec3 => [
	1.2 * x - 0.3 * y + 5,
	0.3 * x + 0.9 * y + 2 * z - 10,
	0.5 * z + 20,
];

const LANDMARKS: Vec3[] = [
	[0, 0, 0],
	[10, 0, 0],
	[0, 10, 0],
	[0, 0, 10],
	[10, 10, 0],
	[5, -5, 15],
	[-8, 3, 7],
];

describe("fitAffine", () => {
	it("recovers a known affine transform from >=4 landmark pairs", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.map((p) => [p, applyKnownAffine(p)]);
		const fit = fitAffine(pairs);
		expect(fit).not.toBeNull();

		// A point that was NOT part of the fit set — verifies the fit generalizes rather
		// than just interpolating the training points.
		const probe: Vec3 = [3, -2, 9];
		const expected = applyKnownAffine(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("returns null with fewer than 4 pairs", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.slice(0, 3).map((p) => [p, applyKnownAffine(p)]);
		expect(fitAffine(pairs)).toBeNull();
	});

	it("returns null for degenerate (collinear) landmarks", () => {
		const collinear: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]];
		const pairs: [Vec3, Vec3][] = collinear.map((p) => [p, applyKnownAffine(p)]);
		expect(fitAffine(pairs)).toBeNull();
	});
});

describe("fitPerAxisLinear", () => {
	it("recovers an independent per-axis scale + offset", () => {
		const scaleOffset = ([x, y, z]: Vec3): Vec3 => [2 * x + 1, -0.5 * y + 4, 3 * z - 7];
		const pts: Vec3[] = [[0, 0, 0], [1, 2, 3], [-4, 5, -6]];
		const pairs: [Vec3, Vec3][] = pts.map((p) => [p, scaleOffset(p)]);
		const fit = fitPerAxisLinear(pairs);
		expect(fit).not.toBeNull();

		const probe: Vec3 = [10, -10, 8];
		const expected = scaleOffset(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("returns null with fewer than 2 pairs", () => {
		expect(fitPerAxisLinear([[[0, 0, 0], [1, 1, 1]]])).toBeNull();
	});

	it("returns null when an axis has no spread across landmarks", () => {
		// z is constant across every landmark — can't fit a slope for that axis.
		const pairs: [Vec3, Vec3][] = [
			[[0, 0, 5], [1, 1, 1]],
			[[1, 1, 5], [2, 2, 1]],
			[[2, 2, 5], [3, 3, 1]],
		];
		expect(fitPerAxisLinear(pairs)).toBeNull();
	});
});

describe("fitCaseMapping", () => {
	it("prefers the full affine fit when there are enough landmarks", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.map((p) => [p, applyKnownAffine(p)]);
		const fit = fitCaseMapping(pairs);
		expect(fit).not.toBeNull();
		const probe: Vec3 = [1, 1, 1];
		const expected = applyKnownAffine(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("falls back to the per-axis linear fit with only 2-3 landmarks", () => {
		const scaleOffset = ([x, y, z]: Vec3): Vec3 => [2 * x, 2 * y, 2 * z];
		const pts: Vec3[] = [[0, 0, 0], [1, 1, 1], [2, 3, 4]];
		const pairs: [Vec3, Vec3][] = pts.map((p) => [p, scaleOffset(p)]);
		const fit = fitCaseMapping(pairs);
		expect(fit).not.toBeNull();
		expect(fit!([5, 5, 5])).toEqual([10, 10, 10]);
	});

	it("returns null when there's nothing reliable to fit (e.g. no shared organs)", () => {
		expect(fitCaseMapping([])).toBeNull();
		expect(fitCaseMapping([[[0, 0, 0], [1, 1, 1]]])).toBeNull();
	});
});
