import { useState } from "react";
import { IconChevronRight, IconCheck } from "@tabler/icons-react";

interface ApplyButtonProps {
	/** May return `false` to signal the commit didn't actually go through
	 *  (validation failure, etc) — in that case no success beat plays and
	 *  `onDone` is not called, so the caller stays put and can show its
	 *  own error state. Returning anything else (including nothing) is
	 *  treated as success. */
	onApply: () => void | boolean;
	disabled?: boolean;
	label?: string;
	applyingLabel?: string;
	/** Shown (with a Hopkins-blue checkmark in place of the arrow) for a
	 *  beat once the commit succeeds — only used when `onDone` is passed.
	 *  Defaults to "Done". */
	successLabel?: string;
	/** Called once the success checkmark has been visible for a moment —
	 *  callers use this to close/collapse whatever this button lives in,
	 *  so the confirmation actually gets seen before things disappear
	 *  instead of both happening in the same tick. If omitted, no success
	 *  beat plays at all and behavior matches the old fire-and-forget
	 *  Apply exactly. */
	onDone?: () => void;
	className?: string;
}

/**
 * Standard "Apply" button for segment-effect panels (Margin, Islands, Smoothing,
 * Logical operators, Fill between slices, Grow from seeds...).
 *
 * These operations run synchronously on the main thread and, depending on scope/
 * volume size, can take a visible moment — without any feedback that looks exactly
 * like the click did nothing (or that the app froze). This wraps the click handler
 * so the "Applying…" spinner state gets a chance to actually paint (via a double
 * requestAnimationFrame) BEFORE the heavy synchronous work runs and blocks the
 * thread, then clears once it returns.
 *
 * When a caller passes `onDone`, a successful commit (onApply not explicitly
 * returning `false`) is followed by a brief Hopkins-blue checkmark state
 * before `onDone` fires — the same confirm-then-close pattern used by the
 * flyouts' own ActionButton, so Apply and the one-shot action buttons read
 * as one consistent language across the toolbar.
 *
 * Styled identically to the flyouts' own ActionButton (soft bordered chip, not a
 * solid opaque pill) so every "do this now" button in the annotation toolbar reads
 * as the same control, whether it's Apply or Grow/Shrink/Smooth/Hollow.
 */
export default function ApplyButton({
	onApply,
	disabled,
	label = "Apply",
	applyingLabel = "Applying…",
	successLabel = "Done",
	onDone,
	className = "",
}: ApplyButtonProps) {
	const [applying, setApplying] = useState(false);
	const [success, setSuccess] = useState(false);

	const handleClick = () => {
		if (disabled || applying || success) return;
		setApplying(true);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				let ok = true;
				try {
					const result = onApply();
					if (result === false) ok = false;
				} finally {
					setApplying(false);
				}
				if (ok && onDone) {
					setSuccess(true);
					window.setTimeout(() => {
						setSuccess(false);
						onDone();
					}, 650);
				}
			});
		});
	};

	return (
		<button
			type="button"
			className={`atb-action-btn ${success ? "is-success" : ""} ${className}`}
			disabled={disabled || applying || success}
			onClick={handleClick}
		>
			<span className="atb-action-btn__label">
				{success ? successLabel : applying ? applyingLabel : label}
			</span>
			{success ? (
				<IconCheck size={14} stroke={3} className="atb-action-btn__check" />
			) : applying ? (
				<span className="atb-action-btn__spinner" aria-hidden="true" />
			) : (
				<IconChevronRight size={14} stroke={2.5} className="atb-action-btn__arrow" />
			)}
		</button>
	);
}