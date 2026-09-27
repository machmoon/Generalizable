import { IconBrandGithub, IconBrandGoogle } from "@tabler/icons-react";
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AUTH_FINEPRINT_LEAD, AUTH_FINEPRINT_MID } from "../helpers/copy";
import { useAuth } from "../contexts/authContext";
import { track } from "../helpers/analytics";
import "./AuthModal.css";

// The one auth popup: signing in and creating an account are the same card with
// a different title, a different submit button, and terms fine print on the
// signup side. Claude and ChatGPT both do exactly this — their log-in and
// create-account screens are the same layout throughout.
//
// Opened by authContext.promptAuth(mode) from the header, from gated upload
// actions, and from /signup — which redirects here rather than 404ing, so old
// links and bookmarks still land somewhere sensible.
//
// Providers come first with the email form behind "Continue with email", which
// keeps the default card short.
//
// "forgot" is the third mode, and it skips the provider screen: it is reached
// from the sign-in form by someone who already knows the password isn't working,
// so offering them the Google button again as the first thing is answering a
// question they didn't ask. The one line about OAuth accounts covers the case
// where the reason their password fails is that they never had one.
const AuthModal: React.FC = () => {
	const {
		authPrompt, closeAuthPrompt, promptAuth, signIn, signUp,
		requestPasswordReset, signInWithProvider, oauthProviders, oauthError,
		clearOauthError,
	} = useAuth();

	const isSignup = authPrompt.mode === "signup";
	const isForgot = authPrompt.mode === "forgot";

	// "email mode" reveals the email/password form (World Labs' "Continue with email").
	const [emailMode, setEmailMode] = useState(false);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	// The reset request has been accepted. A settled end state, not a banner over
	// the form: there is nothing left to do on this card.
	const [resetSent, setResetSent] = useState(false);

	// Reset transient form state whenever the popup opens/closes.
	useEffect(() => {
		if (!authPrompt.open) {
			setEmailMode(false);
			setEmail(""); setPassword(""); setError(""); setBusy(false);
			setResetSent(false);
		}
	}, [authPrompt.open]);

	// Flipping between sign-in and sign-up clears the password and any error —
	// a rejected sign-in shouldn't still be showing over the signup form.
	useEffect(() => {
		setPassword(""); setError(""); setResetSent(false);
	}, [authPrompt.mode]);

	// Surface an error the OAuth callback redirected back with.
	useEffect(() => {
		if (oauthError) setError(oauthError);
	}, [oauthError]);

	// Closing the popup also clears a pending OAuth error so it doesn't reappear.
	const dismiss = () => {
		clearOauthError();
		closeAuthPrompt();
	};

	// Close on Esc.
	useEffect(() => {
		if (!authPrompt.open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [authPrompt.open, closeAuthPrompt]);

	if (!authPrompt.open) return null;

	const submitEmail = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		if (isForgot) {
			if (!email.trim()) { setError("Enter your email address."); return; }
		} else if (!email.trim() || !password) {
			setError("Enter an email and password."); return;
		}
		setBusy(true);
		try {
			if (isForgot) {
				await requestPasswordReset(email.trim());
				track("auth_forgot_password_request");
				setResetSent(true);
				return;
			}
			if (isSignup) await signUp(email, password);
			else await signIn(email, password);
			// After the await: this counts successful sign-ins, not attempts.
			track(isSignup ? "auth_sign_up" : "auth_sign_in");
			// authContext auto-closes the popup once the user is set.
		} catch (err) {
			// Surface the API's message ("Invalid email or password", "An account
			// with that email already exists", ...) rather than a generic string.
			setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="authm-backdrop" onClick={dismiss}>
			<div
				className="authm-card"
				role="dialog"
				aria-modal="true"
				aria-label={
					isForgot ? "Reset your password" : isSignup ? "Create your account" : "Sign in"
				}
				onClick={(e) => e.stopPropagation()}
			>
				<button type="button" className="authm-close" aria-label="Close" onClick={dismiss}>×</button>

				<img src="/bodymaps-logo.svg" alt="" className="authm-logo" />
				<h2 className="authm-title">
					{isForgot ? "Reset your password" : isSignup ? "Create your account" : "Sign in"}
				</h2>

				{isForgot && resetSent ? (
					<>
						{/* Deliberately hedged. The server answers identically whether or
						    not the address has an account, so that this card can't be used
						    to find out which addresses are registered — which means the
						    card genuinely does not know, and saying "sent" would be a
						    claim it can't make. */}
						<p className="authm-sent">
							If an account exists for <strong>{email.trim()}</strong>, a reset
							link is on its way. It works once and expires in an hour.
						</p>
						<p className="authm-fineprint">
							Nothing arrived? Check your spam folder, or{" "}
							<button
								type="button"
								className="authm-link"
								onClick={() => { setResetSent(false); setError(""); }}
							>
								try another address
							</button>
							.
						</p>
					</>
				) : !emailMode && !isForgot ? (
					<>
						{/* A provider with no server-side credentials stays disabled. */}
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.google === false}
							title={oauthProviders?.google === false ? "Not configured on this server" : undefined}
							onClick={() => signInWithProvider("google")}
						>
							<IconBrandGoogle size={18} />
							Continue with Google
						</button>
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.github === false}
							title={oauthProviders?.github === false ? "Not configured on this server" : undefined}
							onClick={() => signInWithProvider("github")}
						>
							<IconBrandGithub size={18} />
							Continue with GitHub
						</button>

						{/* Errors bounced back from the OAuth callback land here. */}
						{error && <div className="authm-error">{error}</div>}

						<div className="authm-divider"><span>or</span></div>

						<button type="button" className="authm-email-btn" onClick={() => setEmailMode(true)}>
							Continue with email
						</button>
					</>
				) : (
					<form className="authm-form" onSubmit={submitEmail}>
						{isForgot && (
							<p className="authm-sub">
								Enter your email and we'll send you a link to choose a new
								password. If you normally sign in with Google or GitHub, use
								that button instead — those accounts have no password here.
							</p>
						)}
						<label className="authm-field">
							<span className="authm-label">Email</span>
							<input type="email" autoComplete="email" className="authm-input" value={email}
								onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus />
						</label>
						{!isForgot && (
							<label className="authm-field">
								<span className="authm-label">Password</span>
								<input
									type="password"
									autoComplete={isSignup ? "new-password" : "current-password"}
									className="authm-input"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder={isSignup ? "At least 8 characters" : "••••••••"}
								/>
							</label>
						)}
						{/* Sign-in only. On the signup side there is no password to have
						    forgotten, and offering a reset there just invites confusion. */}
						{!isSignup && !isForgot && (
							<button
								type="button"
								className="authm-link authm-forgot"
								onClick={() => promptAuth("forgot")}
							>
								Forgot password?
							</button>
						)}
						{error && <div className="authm-error">{error}</div>}
						<button type="submit" className="authm-submit" disabled={busy}>
							{busy ? "…" : isForgot ? "Send reset link" : isSignup ? "Create account" : "Sign in"}
						</button>
						<button
							type="button"
							className="authm-back"
							onClick={() => (isForgot ? promptAuth("signin") : setEmailMode(false))}
						>
							← {isForgot ? "Back to sign in" : "Other options"}
						</button>
					</form>
				)}

				{/* Consent by continuing rather than a checkbox, on both sign-up and
				    sign-in — Terms are accepted, the Privacy Policy is acknowledged.
				    The reset-password view is not an entry into the service. */}
				{!isForgot && (
					<p className="authm-fineprint">
						{AUTH_FINEPRINT_LEAD}{" "}
						<Link to="/terms" target="_blank">Terms of Service</Link>{" "}
						{AUTH_FINEPRINT_MID}{" "}
						<Link to="/privacy" target="_blank">Privacy Policy</Link>.
					</p>
				)}

				<div className="authm-toggle">
					{isForgot ? (
						<>
							Remembered it?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						</>
					) : isSignup ? (
						<>
							Already have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						</>
					) : (
						<>
							Don't have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signup")}>
								Sign up
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
};

export default AuthModal;
