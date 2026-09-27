import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import { track } from "../helpers/analytics";
import "../components/AuthModal.css";
import "./ResetPassword.css";

// Where the emailed reset link lands: /reset-password?token=…
//
// A page rather than a mode of the auth popup, because it is arrived at from
// outside the app entirely — a mail client, on a device that may never have
// loaded the site. There is nothing behind it to pop over.
//
// It borrows AuthModal's stylesheet rather than growing a second set of form
// styles; the card is the same card, standing on its own.
//
// The token is NOT checked on load. Doing so would mean an endpoint that
// reports whether a token is valid without redeeming it, which is a thing worth
// guessing at; and a link-preview fetch by the mail client would burn the token
// before the user ever clicked. It is checked when the form is submitted.

const MIN_LENGTH = 8;

const ResetPassword: React.FC = () => {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const { resetPassword, promptAuth } = useAuth();
	const token = params.get("token") || "";

	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);

	// A link with no token at all is a mangled paste, not an expired one, and
	// saying so is more useful than letting them type a password first.
	const missingToken = !token;

	useEffect(() => {
		if (!done) return;
		const t = setTimeout(() => navigate("/dashboard", { replace: true }), 1800);
		return () => clearTimeout(t);
	}, [done, navigate]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		if (password.length < MIN_LENGTH) {
			setError(`Use at least ${MIN_LENGTH} characters.`);
			return;
		}
		// Checked here rather than server-side: the server only ever sees one
		// password, and "you typed it differently twice" is a question about this
		// form, not about the account.
		if (password !== confirm) {
			setError("Those two passwords don't match.");
			return;
		}
		setBusy(true);
		try {
			await resetPassword(token, password);
			track("auth_reset_password");
			setDone(true);
		} catch (err) {
			setError(
				err instanceof Error && err.message
					? err.message
					: "Couldn't reset your password. Try again."
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="rp-wrapper">
			<div className="authm-card rp-card">
				<Link to="/" className="rp-brand">
					<img src="/bodymaps-logo.svg" alt="" className="authm-logo" />
				</Link>

				{done ? (
					<>
						<h1 className="authm-title">Password changed</h1>
						<p className="authm-sent">
							You're signed in on this device. Every other browser that was
							signed in as you has been signed out.
						</p>
					</>
				) : missingToken ? (
					<>
						<h1 className="authm-title">That link is incomplete</h1>
						<p className="authm-sent">
							The reset link seems to have been cut short — that often happens
							when it wraps across two lines in an email. Copy the whole link, or
							ask for a new one.
						</p>
						<button
							type="button"
							className="authm-submit rp-submit"
							onClick={() => { navigate("/"); promptAuth("forgot"); }}
						>
							Send a new link
						</button>
					</>
				) : (
					<>
						<h1 className="authm-title">Choose a new password</h1>
						<form className="authm-form" onSubmit={submit}>
							<label className="authm-field">
								<span className="authm-label">New password</span>
								<input
									type="password"
									autoComplete="new-password"
									className="authm-input"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder={`At least ${MIN_LENGTH} characters`}
									autoFocus
								/>
							</label>
							<label className="authm-field">
								<span className="authm-label">Confirm new password</span>
								<input
									type="password"
									autoComplete="new-password"
									className="authm-input"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
									placeholder="••••••••"
								/>
							</label>
							{error && <div className="authm-error">{error}</div>}
							<button type="submit" className="authm-submit" disabled={busy}>
								{busy ? "…" : "Set new password"}
							</button>
						</form>
						<p className="authm-fineprint">
							Links expire an hour after they're sent and work only once.
						</p>
					</>
				)}
			</div>
		</div>
	);
};

export default ResetPassword;
