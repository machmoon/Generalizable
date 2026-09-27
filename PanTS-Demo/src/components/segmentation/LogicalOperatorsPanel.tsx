import { useState } from "react";
import type { LogicalOperation } from "../../helpers/CornerstoneNifti2";
import type { CheckBoxData } from "../../types";
import ApplyButton from "../ApplyButton";
import { GrandchildRow, MenuColumn } from "../viewer/FlyoutPrimitives";

interface LogicalOperatorsPanelProps {
	segments: CheckBoxData[];
	targetSegmentId: number;
	onApply: (operation: LogicalOperation, sourceSegmentId: number | null, bypassMasking: boolean) => void;
	operation: LogicalOperation;
	onOperationChange: (op: LogicalOperation) => void;
	sourceId: number | null;
	onSourceIdChange: (id: number | null) => void;
	bypassMasking: boolean;
	onBypassMaskingChange: (v: boolean) => void;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const OPERATIONS: { value: LogicalOperation; label: string; needsSource: boolean }[] = [
	{ value: "copy", label: "Copy", needsSource: true },
	{ value: "add", label: "Add", needsSource: true },
	{ value: "invert", label: "Invert", needsSource: false },
	{ value: "clear", label: "Clear", needsSource: false },
	{ value: "fill", label: "Fill", needsSource: false },
];

// Plain-language description of what Apply will do, shown on the button
// itself. Source is blank ("___") until a class is picked.
function getApplyLabel(def: typeof OPERATIONS[number], targetLabel: string, sourceLabel: string): string {
	switch (def.value) {
		case "copy":
			return `Replace ${sourceLabel} with ${targetLabel}`;
		case "add":
			return `Combine ${targetLabel} and ${sourceLabel}`;
		case "invert":
			return `Invert ${targetLabel}`;
		case "clear":
			return `Clear ${targetLabel}`;
		case "fill":
			return `Fill ${targetLabel}`;
	}
}

// Plain-language copy for the source picker, since "Source class" alone
// doesn't say what picking one does for this operation.
function getSourceCopy(def: typeof OPERATIONS[number], targetLabel: string): { placeholder: string; title: string } {
	switch (def.value) {
		case "copy":
			return {
				placeholder: "Copy to...",
				title: `${targetLabel} will replace the picked class's shape.`,
			};
		case "add":
			return {
				placeholder: "Combine with…",
				title: `The picked class will be merged into ${targetLabel}.`,
			};
		default:
			return { placeholder: "Source class…", title: "Source class" };
	}
}

// One row in the operations column: clicking opens its grandchild, which
// holds the source-segment picker (Copy/Add only), the bypass-masking
// toggle, and the Apply button for that operation.
function OperationRow({
	def, segments, targetSegmentId, sourceId, onSourceIdChange,
	bypassMasking, onBypassMaskingChange, onApply, onDone, expanded, onToggle,
}: {
	def: typeof OPERATIONS[number];
	segments: CheckBoxData[];
	targetSegmentId: number;
	sourceId: number | null;
	onSourceIdChange: (id: number | null) => void;
	bypassMasking: boolean;
	onBypassMaskingChange: (v: boolean) => void;
	onApply: () => void;
	onDone: () => void;
	expanded: boolean;
	onToggle: () => void;
}) {
	const otherSegments = segments.filter((s) => s.id !== targetSegmentId);
	const targetLabel = segments.find((s) => s.id === targetSegmentId)?.label ?? "___";
	const sourceLabel = sourceId !== null ? segments.find((s) => s.id === sourceId)?.label ?? "___" : "___";

	return (
		<GrandchildRow label={def.label} expanded={expanded} onToggle={onToggle}>
			{def.needsSource && (
				<select
					className="seg-effect__select"
					value={sourceId ?? ""}
					onChange={(e) => onSourceIdChange(e.target.value === "" ? null : Number(e.target.value))}
					title={getSourceCopy(def, targetLabel).title}
					style={{
						background: "rgba(255,255,255,0.06)",
						border: "1px solid rgba(255,255,255,0.12)",
						borderRadius: 8,
						color: "#fff",
						padding: "8px 9px",
						fontSize: 12.5,
					}}
				>
					<option value="" disabled>
						{getSourceCopy(def, targetLabel).placeholder}
					</option>
					{otherSegments.map((s) => (
						<option key={s.id} value={s.id}>
							{s.label}
						</option>
					))}
				</select>
			)}

			<label
				style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#fff", cursor: "pointer" }}
				title={
					bypassMasking
						? "Ignores class ownership — can overwrite any voxel, even another class's."
						: "Can only touch empty voxels and this class's own."
				}
			>
				<input type="checkbox" checked={bypassMasking} onChange={(e) => onBypassMaskingChange(e.target.checked)} />
				Bypass masking
			</label>

			<ApplyButton
				disabled={def.needsSource && sourceId === null}
				onApply={onApply}
				onDone={onDone}
				label={getApplyLabel(def, targetLabel, sourceLabel)}
				successLabel="Applied"
			/>
		</GrandchildRow>
	);
}

export default function LogicalOperatorsPanel({
	segments,
	targetSegmentId,
	onApply,
	operation,
	onOperationChange,
	sourceId,
	onSourceIdChange,
	bypassMasking,
	onBypassMaskingChange,
	onApplied,
	onBusyChange,
}: LogicalOperatorsPanelProps) {
	const [pendingOp, setPendingOp] = useState<LogicalOperation>(operation);
	// Which row's grandchild is open — only one at a time.
	const [expandedOp, setExpandedOp] = useState<LogicalOperation | null>(null);

	// A source picked for one operation has no guaranteed meaning for
	// another, so switching which row's grandchild is "current" forgets it.
	const selectOperation = (op: LogicalOperation) => {
		setPendingOp(op);
		onOperationChange(op);
		onSourceIdChange(null);
	};

	const runApply = (def: typeof OPERATIONS[number]) => {
		selectOperation(def.value);
		onBusyChange?.(true);
		onApply(def.value, def.needsSource ? sourceId : null, bypassMasking);
	};

	// Fires once ApplyButton's own success checkmark has had its beat on
	// screen — this is what actually clears the busy dot and lets the tool
	// deselect, instead of that happening in the same tick as the click.
	const finishApply = () => {
		onBusyChange?.(false);
		onApplied?.();
	};

	return (
		<MenuColumn>
			{OPERATIONS.map((def) => (
				<OperationRow
					key={def.value}
					def={def}
					segments={segments}
					targetSegmentId={targetSegmentId}
					sourceId={pendingOp === def.value ? sourceId : null}
					onSourceIdChange={(id) => { setPendingOp(def.value); onOperationChange(def.value); onSourceIdChange(id); }}
					bypassMasking={bypassMasking}
					onBypassMaskingChange={onBypassMaskingChange}
					onApply={() => runApply(def)}
					onDone={finishApply}
					expanded={expandedOp === def.value}
					onToggle={() => setExpandedOp((prev) => (prev === def.value ? null : def.value))}
				/>
			))}
		</MenuColumn>
	);
}