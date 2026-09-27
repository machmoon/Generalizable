// The account control shown in both nav bars (LandingPage's inline nav and the
// shared Header). Signed out: a "Sign in" button that opens the auth popup.
// Signed in: an account menu (the name they set, or their email until they set
// one, + dropdown: Account settings, Sign out).
// Reads authContext, so it flips everywhere at once.
import { IconChevronDown, IconLogout, IconSettings } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import styles from "./AuthButton.module.css";

export default function AuthButton() {
	const { user, isAuthenticated, loading, signOut, promptAuth } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Close the dropdown on any outside click.
	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [menuOpen]);

	// Don't flash "Sign in" before the initial /me check resolves.
	if (loading) return null;

	if (!isAuthenticated || !user) {
		return (
			<button type="button" className={styles.signInBtn} onClick={() => promptAuth()}>
				Sign in
			</button>
		);
	}

	const initial = (user.name || user.email).charAt(0).toUpperCase();

	return (
		<div className={styles.accountRoot} ref={rootRef}>
			<button
				type="button"
				className={styles.accountTrigger}
				onClick={() => setMenuOpen((o) => !o)}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
			>
				<span className={styles.avatar}>{initial}</span>
				<span className={styles.accountEmail}>
					{user.hasCustomName ? user.name : user.email}
				</span>
				<IconChevronDown size={15} className={styles.chevron} />
			</button>

			{menuOpen && (
				<div className={styles.menu} role="menu">
					<div className={styles.menuHeader}>
						<div className={styles.menuName}>{user.name}</div>
						<div className={styles.menuEmail}>{user.email}</div>
					</div>
					<button
						type="button"
						className={styles.menuItem}
						role="menuitem"
						onClick={() => {
							setMenuOpen(false);
							navigate("/account");
						}}
					>
						<IconSettings size={16} />
						Account settings
					</button>
					<button
						type="button"
						className={styles.menuItem}
						role="menuitem"
						onClick={() => {
							setMenuOpen(false);
							signOut();
							navigate("/");
						}}
					>
						<IconLogout size={16} />
						Sign out
					</button>
				</div>
			)}
		</div>
	);
}
