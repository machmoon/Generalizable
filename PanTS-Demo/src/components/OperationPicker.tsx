import type { ReactNode } from "react";

export interface OperationOption<T extends string> {
	value: T;
	label: string;
	tooltip?: string;
	icon: ReactNode;
}

interface OperationPickerProps<T extends string> {
	title?: string;
	name: string;
	options: OperationOption<T>[];
	value: T;
	onChange: (value: T) => void;
}

/**
 * Standard operation picker shared by every panel that offers a small set
 * of mutually-exclusive operations (scissors, margin, islands, ...):
 * "Operation:" header on top, then each choice as a radio row with its icon
 * beside its label. One component so every tool's picker looks and behaves
 * the same instead of being reinvented per panel.
 *
 * Pass title="" (or omit and pass nothing truthy) to skip the header
 * entirely — useful when the panel already has its own label above the
 * picker (e.g. Grow From Seeds' "Scope:" label) and showing "Operation:"
 * on top of that would be redundant.
 */
export default function OperationPicker<T extends string>({
	title = "Operation:", name, options, value, onChange,
}: OperationPickerProps<T>) {
	return (
		<div className="atb-flyout__grid atb-flyout__grid--scissors">
			<div className="atb-flyout__col">
				{title && <span className="atb-flyout__label">{title}</span>}
				{options.map((opt) => (
					<label className="atb-flyout__radio" key={opt.value} title={opt.tooltip}>
						<input
							type="radio"
							name={name}
							checked={value === opt.value}
							onChange={() => onChange(opt.value)}
						/>
						{opt.icon}
						{opt.label}
					</label>
				))}
			</div>
		</div>
	);
}