import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LandingPage from "../routes/LandingPage";
import { LANDING_OVERVIEW, LANDING_SUBTITLE } from "../helpers/copy";

// The landing page fetches the live CT count; stub it so the test never
// touches a backend (same shape as routes.smoke.test.tsx).
beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], total: 0, ids: [] }),
    text: async () => "",
    headers: { get: () => "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("landing hero copy", () => {
  it("shows the subtitle under the wordmark and the overview under the stats row", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const subtitle = screen.getByText(LANDING_SUBTITLE);
    expect(subtitle.previousElementSibling?.tagName).toBe("H1");
    const overview = screen.getByText(LANDING_OVERVIEW);
    // Directly after the stats row, not between subtitle and stats.
    expect(overview.previousElementSibling?.textContent).toContain("CT Volumes");
    expect(overview.nextElementSibling).toBeNull();
    // The nonclinical sentence lives in the footer, not in the paragraph.
    expect(overview.textContent).not.toMatch(/nonclinical|research use only/i);
  });
});
