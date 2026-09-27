// The account control in the nav bar. What it puts on screen is the whole
// point of it: the name once the account has one, the email until then — an
// address is what we have to fall back on, not what anyone wants to see.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthButton from "../components/AuthButton";
import { AuthProvider } from "../contexts/authContext";

const USER = {
	id: "u1",
	email: "test.user@example.com",
	name: null as string | null,
	plan: "free",
};

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	USER.name = null;
	localStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderButton = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AuthButton />
			</MemoryRouter>
		</AuthProvider>
	);

describe("the signed-in account control", () => {
	it("shows the name once one is set", async () => {
		USER.name = "Ada Lovelace";
		renderButton();

		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		// The email is still in the dropdown, but the dropdown is closed.
		expect(screen.queryByText("test.user@example.com")).not.toBeInTheDocument();
	});

	it("falls back to the email until there is one", async () => {
		renderButton();

		expect(await screen.findByText("test.user@example.com")).toBeInTheDocument();
	});
});
