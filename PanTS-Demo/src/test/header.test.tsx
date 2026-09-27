import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Header from "../components/Header";
import { AuthProvider } from "../contexts/authContext";

const renderHeader = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <Header />
      </MemoryRouter>
    </AuthProvider>,
  );

describe("header navigation", () => {
  it("keeps the four routed tabs and omits the external CONTACT entry", () => {
    renderHeader();
    for (const label of ["OVERVIEW", "DATASET", "UPLOAD", "TEAM"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: /CONTACT/i })).not.toBeInTheDocument();
  });
});
