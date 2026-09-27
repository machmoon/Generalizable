import { useEffect, useRef, useState } from "react";

// One flyout group's transient UI state: whether it's open, where its portal-rendered
// panel sits (measured off the trigger button on open), and the refs the outside-
// click/reflow handler needs. Shared by every toolbar dropdown (Layout, Window, Adjust,
// Panels, ... in the single viewer; View, Window, Adjust, Sync in the compare viewer) so
// this logic — open/close, position, dismiss-on-outside-click-or-scroll — isn't hand-
// duplicated per group per page.
export function useToolbarFlyout() {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const toggle = () => {
		setOpen((prev) => {
			const next = !prev;
			if (next && btnRef.current) {
				const r = btnRef.current.getBoundingClientRect();
				setPos({ top: r.bottom + 8, left: r.left });
			}
			return next;
		});
	};
	const close = () => setOpen(false);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: globalThis.MouseEvent) => {
			const t = e.target as Node;
			if (groupRef.current?.contains(t) || menuRef.current?.contains(t)) return;
			setOpen(false);
		};
		const onReflow = () => setOpen(false);
		document.addEventListener("mousedown", onPointerDown);
		window.addEventListener("scroll", onReflow, true);
		window.addEventListener("resize", onReflow);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("scroll", onReflow, true);
			window.removeEventListener("resize", onReflow);
		};
	}, [open]);

	return { open, pos, groupRef, btnRef, menuRef, toggle, close };
}
