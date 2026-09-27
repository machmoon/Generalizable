import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Node 24 defines its own optional `localStorage` getter. Vitest 3 sees that
// property and skips copying jsdom's Storage object onto the test global, leaving
// the getter undefined unless Node was started with a storage-file flag.
const jsdomStorage = (globalThis as typeof globalThis & {
	jsdom?: { window: { localStorage: Storage } };
}).jsdom?.window.localStorage;
if (jsdomStorage) {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: jsdomStorage,
	});
}

// Unmount React trees between tests so they don't leak into each other.
afterEach(() => cleanup());

// jsdom is missing a few browser APIs the components touch. Stub them so
// route/viewer smoke tests can mount without throwing.

if (!window.matchMedia) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || (ResizeObserverStub as never);

class IntersectionObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
globalThis.IntersectionObserver = globalThis.IntersectionObserver || (IntersectionObserverStub as never);

if (!URL.createObjectURL) {
	URL.createObjectURL = vi.fn(() => "blob:mock");
}
if (!URL.revokeObjectURL) {
	URL.revokeObjectURL = vi.fn();
}

// No WebGL in jsdom — return null so canvas-based code degrades instead of crashing.
HTMLCanvasElement.prototype.getContext =
	HTMLCanvasElement.prototype.getContext || (vi.fn(() => null) as never);
window.HTMLElement.prototype.scrollIntoView = vi.fn();
