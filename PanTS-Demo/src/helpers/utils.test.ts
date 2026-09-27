import { describe, expect, it } from "vitest";
import type { Color } from "@cornerstonejs/core/types";
import {
	arrayIsEqual,
	capitalize,
	cleanName,
	closestColorIndex,
	deepIsEqual,
	filenameToName,
	getPanTSId,
	prettify_segmentation_category,
	roundDigits,
} from "./utils";

describe("case-ID formatting", () => {
	it("getPanTSId pads numeric ids to 8 digits", () => {
		expect(getPanTSId("1")).toBe("PanTS_00000001");
		expect(getPanTSId("8854")).toBe("PanTS_00008854");
	});

	it("getPanTSId does not truncate ids already 8+ digits", () => {
		expect(getPanTSId("12345678")).toBe("PanTS_12345678");
		expect(getPanTSId("123456789")).toBe("PanTS_123456789");
	});

	it("cleanName strips the prefix and leading zeros", () => {
		expect(cleanName("PanTS_00008854")).toBe("8854");
		expect(cleanName("PanTS_00000001")).toBe("1");
	});
});

describe("equality helpers", () => {
	it("arrayIsEqual compares length and elements in order", () => {
		expect(arrayIsEqual([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(arrayIsEqual([1, 2, 3], [1, 2])).toBe(false);
		expect(arrayIsEqual([1, 2, 3], [1, 2, 4])).toBe(false);
		expect(arrayIsEqual<string>(["a", "b"], ["a", "b"])).toBe(true);
	});

	it("deepIsEqual compares nested objects structurally", () => {
		expect(deepIsEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
		expect(deepIsEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(deepIsEqual({ a: 1 }, { a: 1, b: 2 } as unknown as { a: number })).toBe(false);
	});
});

describe("color matching", () => {
	it("closestColorIndex returns the nearest color key", () => {
		const dict: { [key: number]: Color } = {
			1: [254, 0, 0, 255],
			2: [0, 0, 255, 255],
			3: [0, 255, 0, 255],
		};
		expect(closestColorIndex([255, 0, 0, 255], dict)).toBe(1);
		expect(closestColorIndex([0, 0, 250, 255], dict)).toBe(2);
		expect(closestColorIndex([10, 250, 10, 255], dict)).toBe(3);
	});
});

describe("string utilities", () => {
	it("capitalize uppercases the first letter and is safe on empty input", () => {
		expect(capitalize("hello")).toBe("Hello");
		expect(capitalize("")).toBe("");
	});

	it("filenameToName drops the extension at the first dot", () => {
		expect(filenameToName("liver.nii.gz")).toBe("liver");
		expect(filenameToName("no-extension")).toBe("no-extension");
	});

	it("prettify_segmentation_category title-cases underscore-separated names", () => {
		expect(prettify_segmentation_category("kidney_left")).toBe("Kidney Left");
		expect(prettify_segmentation_category("aorta")).toBe("Aorta");
	});
});

describe("number utilities", () => {
	it("roundDigits rounds to the requested precision", () => {
		expect(roundDigits(3.14159, 2)).toBe(3.14);
		expect(roundDigits(3.14159, 0)).toBe(3);
		expect(roundDigits(10, 2)).toBe(10);
	});
});
