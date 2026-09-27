import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import TeamPage from "../routes/TeamPage";

describe("team page", () => {
  it("links the two verified profiles and leaves the other cards unlinked", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const zhou = screen.getByRole("link", { name: "Zongwei Zhou, PhD on LinkedIn" });
    expect(zhou).toHaveAttribute("href", "https://www.linkedin.com/in/zongwei-zhou");
    expect(zhou).toHaveAttribute("target", "_blank");
    expect(zhou).toHaveAttribute("rel", "noopener noreferrer");
    const li = screen.getByRole("link", { name: "Wenxuan Li on LinkedIn" });
    expect(li).toHaveAttribute("href", "https://www.linkedin.com/in/wenxuan-li-chelsea");
    // Exactly two profile links; the other four members have none yet.
    expect(screen.getAllByRole("link", { name: /on LinkedIn$/ })).toHaveLength(2);
    expect(screen.getByText("Alan L. Yuille, PhD")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Yuille/ })).not.toBeInTheDocument();
  });
});
