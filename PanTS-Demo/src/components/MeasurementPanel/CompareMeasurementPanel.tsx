import { IconCrosshair, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import {
	type CaseKey,
	type CompareHandle,
	type MeasurementSummary,
} from "../../helpers/compareViewer";
import { toolDisplayName } from "../../helpers/sessionReport";
import "./MeasurementPanel.css";

type Props = {
	handle: CompareHandle | null;
	idA: string;
	idB: string;
	onClose: () => void;
};

// Same inventory as the single viewer's MeasurementPanel (rename / jump / delete), but
// sourced from the compare viewer's handle and tagged with which case (A/B) each
// measurement belongs to, since jumping needs to move the right case's crosshair.
function CompareMeasurementPanel({ handle, idA, idB, onClose }: Props) {
	const [items, setItems] = useState<MeasurementSummary[]>(() => handle?.getMeasurementSummaries() ?? []);

	useEffect(() => {
		if (!handle) return;
		setItems(handle.getMeasurementSummaries());
		const unsubscribe = handle.subscribeToMeasurementChanges(() => {
			setItems(handle.getMeasurementSummaries());
		});
		return unsubscribe;
	}, [handle]);

	const commitLabel = (uid: string, label: string) => {
		handle?.renameMeasurement(uid, label.trim());
		setItems(handle?.getMeasurementSummaries() ?? []);
	};

	const caseLabel = (caseKey: CaseKey) => (caseKey === "a" ? idA : idB);

	return (
		<div className="vp-measure" role="region" aria-label="Measurements">
			<div className="vp-measure__head">
				<span className="vp-panel__title">Measurements</span>
				<div className="vp-measure__actions">
					{items.length > 0 && (
						<button
							className="vp-measure__clear"
							onClick={() => {
								handle?.clearMeasurements();
								setItems([]);
							}}
						>
							Clear all
						</button>
					)}
					<button className="vp-measure__close" onClick={onClose} aria-label="Close measurements">
						×
					</button>
				</div>
			</div>
			{items.length === 0 ? (
				<div className="vp-measure__empty">
					No measurements yet.
					<br />
					<span>Pick a tool from the Measure menu and draw on either case.</span>
				</div>
			) : (
				<div className="vp-measure__list">
					{items.map((m) => (
						<div className="vp-measure__item" key={m.uid}>
							<div className="vp-measure__main">
								<input
									className="vp-measure__label"
									defaultValue={m.label}
									placeholder={toolDisplayName(m.tool)}
									aria-label="Measurement label"
									onBlur={(e) => {
										if (e.target.value.trim() !== m.label) commitLabel(m.uid, e.target.value);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									}}
								/>
								<span className="vp-measure__value">{m.value}</span>
							</div>
							<div className="vp-measure__meta">
								Case {caseLabel(m.caseKey)} · {toolDisplayName(m.tool)}
							</div>
							<div className="vp-measure__btns">
								<button
									className="vp-measure__btn"
									title="Jump to this measurement"
									aria-label="Jump to this measurement"
									disabled={!m.center}
									onClick={() => handle?.jumpToMeasurement(m.uid, m.caseKey)}
								>
									<IconCrosshair size={15} />
								</button>
								<button
									className="vp-measure__btn vp-measure__btn--danger"
									title="Delete this measurement"
									aria-label="Delete this measurement"
									onClick={() => handle?.removeMeasurement(m.uid)}
								>
									<IconTrash size={15} />
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default CompareMeasurementPanel;
