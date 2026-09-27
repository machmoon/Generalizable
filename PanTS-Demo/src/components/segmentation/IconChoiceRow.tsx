// Shared icon-only control used across the annotation corner panel: a row
// of buttons with no visible text, where the name/explanation lives in a
// hover tooltip instead of a permanent label.
//
//   - IconChoiceRow<T>   single-select group of icon buttons (radio-like)
//   - IconTooltipButton  one standalone icon button with a tooltip, for
//                        actions outside a choice group
import { useId, useRef, useState } from "react";
import "./SegmentEffectPanel.css";

export interface IconChoiceOption<T extends string> {
	value: T;
	label: string;
	tooltip?: string;
	icon: React.ReactNode;
}

type IconBtnVariant = "default" | "primary" | "danger";
type IconBtnSize = "sm" | "md";

interface TooltipProps {
	label: string;
	tooltip?: string;
}

// Hover-only explanation box: bold title (the label) plus optional body
// text. pointer-events:none so it never intercepts clicks meant for the
// button underneath it.
function Tooltip({ label, tooltip }: TooltipProps) {
	return (
		<div className="seg-effect__tooltip" role="tooltip">
			<strong>{label}</strong>
			{tooltip && tooltip !== label && <span>{tooltip}</span>}
		</div>
	);
}

interface IconChoiceRowProps<T extends string> {
	/** Group name — used for the radio role/aria-grouping, not rendered. */
	name: string;
	options: IconChoiceOption<T>[];
	value: T;
	onChange: (value: T) => void;
	size?: IconBtnSize;
	disabled?: boolean;
}

export default function IconChoiceRow<T extends string>({
	name,
	options,
	value,
	onChange,
	size = "md",
	disabled,
}: IconChoiceRowProps<T>) {
	const groupId = useId();

	return (
		<div className="seg-effect__icon-row" role="radiogroup" aria-label={name}>
			{options.map((opt) => {
				const isActive = opt.value === value;
				const isDisabled = disabled;
				return (
					<IconBtn
						key={`${groupId}-${opt.value}`}
						icon={opt.icon}
						label={opt.label}
						tooltip={opt.tooltip}
						size={size}
						active={isActive}
						disabled={isDisabled}
						role="radio"
						ariaChecked={isActive}
						onClick={() => { if (!isDisabled) onChange(opt.value); }}
					/>
				);
			})}
		</div>
	);
}

interface IconTooltipButtonProps {
	icon: React.ReactNode;
	/** Shown as the tooltip's bold title, and used for aria-label — never
	 *  rendered as visible on-screen text next to the icon. */
	label: string;
	tooltip?: string;
	onClick?: () => void;
	active?: boolean;
	disabled?: boolean;
	variant?: IconBtnVariant;
	size?: IconBtnSize;
}

/** A single icon button with the same hover-tooltip treatment as
 *  IconChoiceRow's options, for standalone actions outside a choice group.
 *  If `onClick` is omitted the button renders inert, useful for attaching
 *  a tooltip to an icon that just explains a nearby control. */
export function IconTooltipButton({
	icon,
	label,
	tooltip,
	onClick,
	active,
	disabled,
	variant = "default",
	size = "md",
}: IconTooltipButtonProps) {
	return (
		<IconBtn
			icon={icon}
			label={label}
			tooltip={tooltip}
			size={size}
			active={active}
			disabled={disabled}
			variant={variant}
			onClick={onClick}
			role={onClick ? "button" : undefined}
		/>
	);
}

// Shared low-level rendering for both the grouped and standalone cases:
// icon-only button, hover/focus-triggered tooltip, active/variant styling.
function IconBtn({
	icon,
	label,
	tooltip,
	size,
	active,
	disabled,
	variant = "default",
	role,
	ariaChecked,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	tooltip?: string;
	size: IconBtnSize;
	active?: boolean;
	disabled?: boolean;
	variant?: IconBtnVariant;
	role?: "radio" | "button";
	ariaChecked?: boolean;
	onClick?: () => void;
}) {
	const [hover, setHover] = useState(false);
	const [focus, setFocus] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const showTooltip = hover || focus;

	const variantClass =
		variant === "primary" ? " seg-effect__icon-btn--primary" :
		variant === "danger" ? " seg-effect__icon-btn--danger" :
		"";

	return (
		<span className="seg-effect__icon-btn-wrap">
			<button
				ref={btnRef}
				type="button"
				className={`seg-effect__icon-btn seg-effect__icon-btn--${size}${active ? " is-active" : ""}${variantClass}`}
				aria-label={label}
				title={onClick ? undefined : label /* native fallback tooltip only for inert glyphs */}
				role={role}
				aria-checked={role === "radio" ? ariaChecked : undefined}
				disabled={disabled || !onClick}
				onClick={onClick}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				onFocus={() => setFocus(true)}
				onBlur={() => setFocus(false)}
			>
				{icon}
			</button>
			{showTooltip && <Tooltip label={label} tooltip={tooltip} />}
		</span>
	);
}