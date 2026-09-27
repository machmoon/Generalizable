import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import "../components/AuthModal.css";
import "./ResetPassword.css";

// Where the emailed verification link lands: /verify-email?token=…
//
// Same card as the reset page, for the same reason: it is arrived at from a
// mail client, with nothing behind it to pop over. Unlike a reset token, the
// token is redeemed on load - the worst a burned token can do is finish its
// own job (the address ends up verified either way), so the smooth path wins
// over a confirm button. Failure explains itself and points at Settings.
const VerifyEmail: React.FC = () => {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const { verifyEmail, isAuthenticated } = useAuth();
	const token = params.get("token") || "";

	const [state, setState] = useState<"working" | "done" | "failed">("working");
	const [error, setError] = useState("");
	// Strict Mode mounts twice; the token works once.
	const attempted = useRef(false);

	useEffect(() => {
		if (attempted.current) return;
		attempted.current = true;
		if (!token) {
			setState("failed");
			setError("This link is missing its token — copy the full link from the email.");
			return;
		}
		verifyEmail(token)
			.then(() => setState("done"))
			.catch((err) => {
				setState("failed");
				setError(
					err instanceof Error && err.message
						? err.message
						: "Couldn't verify your email."
				);
			});
	}, [token, verifyEmail]);

	return (
		<div className="rp-wrapper">
			<div className="authm-card rp-card">
				<Link to="/" className="rp-brand">
					<img src="/bodymaps-logo.svg" alt="BodyMaps" className="authm-logo" />
				</Link>

				{state === "working" && (
					<>
						<h1 className="authm-title">Verifying your email…</h1>
						<p className="authm-sent">One moment.</p>
					</>
				)}

				{state === "done" && (
					<>
						<h1 className="authm-title">Email verified</h1>
						<p className="authm-sent">
							Your email address is confirmed.
							{isAuthenticated ? " You're all set." : " Sign in to continue."}
						</p>
						<button
							type="button"
							className="authm-submit rp-submit"
							onClick={() => navigate("/dashboard")}
						>
							Continue to BodyMaps
						</button>
					</>
				)}

				{state === "failed" && (
					<>
						<h1 className="authm-title">Couldn't verify</h1>
						<p className="authm-sent">{error}</p>
						<p className="authm-fineprint">
							You can ask for a fresh link from Settings → Profile after signing
							in — links work once and the newest one replaces the rest.
						</p>
					</>
				)}
			</div>
		</div>
	);
};

export default VerifyEmail;
