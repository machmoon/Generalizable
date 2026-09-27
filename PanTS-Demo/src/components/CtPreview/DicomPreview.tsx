import type { RenderingEngine as CsRenderingEngine, Types } from "@cornerstonejs/core";
import { useEffect, useRef, useState } from "react";
import { loadLocalDicomSeries } from "../../helpers/dicomLocal";

// Inline, client-side preview of a locally-selected DICOM series (a folder of .dcm
// slices) — rendered straight from the File objects with Cornerstone, no upload/server
// round-trip. Mirrors CtPreview (the NIfTI previewer) so both file types get the same
// "verify the right scan before running inference" affordance. Lazy-loaded by the upload
// page so the Cornerstone bundle isn't pulled in until a DICOM folder is previewed.

// Cornerstone core only needs initializing once per page load. loadLocalDicomSeries
// handles the DICOM image-loader init separately (and guards its own re-run).
let _coreInited = false;

export default function DicomPreview({ files }: { files: File[] }) {
	const elementRef = useRef<HTMLDivElement>(null);
	const engineRef = useRef<CsRenderingEngine | null>(null);
	const viewportRef = useRef<Types.IStackViewport | null>(null);
	// Live slice index for the wheel handler (a native, non-passive listener that
	// would otherwise close over a stale value).
	const indexRef = useRef(0);
	const totalRef = useRef(0);
	const [error, setError] = useState(false);
	const [ready, setReady] = useState(false);
	const [slice, setSlice] = useState({ index: 0, total: 0 });

	useEffect(() => {
		let cancelled = false;
		let engine: CsRenderingEngine | null = null;
		setError(false);
		setReady(false);

		const goTo = (idx: number, total: number) => {
			const vp = viewportRef.current;
			if (!vp || total === 0) return;
			const clamped = Math.max(0, Math.min(total - 1, idx));
			indexRef.current = clamped;
			void vp.setImageIdIndex(clamped);
			setSlice({ index: clamped, total });
		};

		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			goTo(indexRef.current + (e.deltaY > 0 ? 1 : -1), totalRef.current);
		};

		const load = async () => {
			const element = elementRef.current;
			if (!element) return;
			try {
				const { init: coreInit, RenderingEngine, Enums } = await import("@cornerstonejs/core");
				if (!_coreInited) {
					await coreInit();
					_coreInited = true;
				}
				// Registers the DICOM loaders, groups the picked files by series, and
				// returns the imageIds of the largest series (the real CT stack — folders
				// often mix in scouts / dose reports).
				const { imageIds } = await loadLocalDicomSeries(files);
				if (cancelled || !elementRef.current) return;

				const viewportId = "dicom-preview-vp";
				engine = new RenderingEngine(`dicom-preview-${Date.now()}`);
				engineRef.current = engine;
				engine.enableElement({
					viewportId,
					type: Enums.ViewportType.STACK,
					element,
				});
				const vp = engine.getViewport(viewportId) as Types.IStackViewport;
				viewportRef.current = vp;

				const start = Math.floor(imageIds.length / 2);
				await vp.setStack(imageIds, start);
				vp.render();
				if (cancelled) return;

				indexRef.current = start;
				totalRef.current = imageIds.length;
				setSlice({ index: start, total: imageIds.length });
				setReady(true);
				// Non-passive so preventDefault actually stops the page scrolling as you
				// page through slices; React's synthetic onWheel is passive in some builds.
				element.addEventListener("wheel", onWheel, { passive: false });
			} catch (e) {
				console.error("DICOM preview failed to load", e);
				if (!cancelled) setError(true);
			}
		};
		load();

		return () => {
			cancelled = true;
			elementRef.current?.removeEventListener("wheel", onWheel);
			try {
				engine?.destroy();
			} catch {
				/* engine already torn down */
			}
			engineRef.current = null;
			viewportRef.current = null;
			totalRef.current = 0;
		};
	}, [files]);

	const goToSlice = (idx: number) => {
		const vp = viewportRef.current;
		if (!vp || slice.total === 0) return;
		const clamped = Math.max(0, Math.min(slice.total - 1, idx));
		indexRef.current = clamped;
		void vp.setImageIdIndex(clamped);
		setSlice(s => ({ ...s, index: clamped }));
	};

	if (error) {
		return (
			<div className="ct-preview ct-preview--msg">
				Couldn't preview this DICOM series — it will still upload for inference.
			</div>
		);
	}

	return (
		<div className="ct-preview">
			<div ref={elementRef} className="ct-preview-canvas" onContextMenu={e => e.preventDefault()} />
			{!ready && <div className="ct-preview-loading">Loading preview…</div>}
			{ready && slice.total > 0 && (
				<div className="dicom-preview-controls">
					<input
						type="range"
						min={0}
						max={slice.total - 1}
						value={slice.index}
						onChange={e => goToSlice(Number(e.target.value))}
						className="dicom-preview-slider"
					/>
					<span className="dicom-preview-count">
						{slice.index + 1} / {slice.total}
					</span>
				</div>
			)}
		</div>
	);
}
