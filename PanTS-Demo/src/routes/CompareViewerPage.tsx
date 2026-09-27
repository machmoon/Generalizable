// Live side-by-side CT comparison: two 3-plane MPR viewers (one case each) with per-case
// crosshair navigation, segmentation overlays, CT-window presets, and an optional link that
// syncs proportional slice position across the two cases. Case ids come from the URL
// (?a=&b=) so the comparison is shareable. All Cornerstone wiring lives in
// helpers/compareViewer (isolated from the single-case viewer).
//
// The chrome (top toolbar, flyout groups, floating gear) intentionally mirrors
// VisualizationPage.tsx's PYCAD-style toolbar — same vp-* classes, same
// useToolbarFlyout hook, same hidden-by-default/floating-gear behavior — so the two
// viewers feel like one product instead of an older sidebar-based design bolted onto a
// newer one.
import {
	IconAdjustmentsHorizontal,
	IconAngle,
	IconArrowsCross,
	IconArrowUpRight,
	IconChevronDown,
	IconCircle,
	IconClick,
	IconClipboardList,
	IconFlipHorizontal,
	IconGrid3x3,
	IconHome,
	IconLasso,
	IconLink,
	IconPlayerPause,
	IconPlayerPlay,
	IconPointer,
	IconRotateClockwise,
	IconRuler2,
	IconScanEye,
	IconSettings,
	IconSquareDashed,
	IconStack2,
	IconTrash,
	IconZoomIn,
} from "@tabler/icons-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import CompareMeasurementPanel from "../components/MeasurementPanel/CompareMeasurementPanel";
import OrganCheckbox from "../components/OrganCheckbox";
import { resolveSources } from "../helpers/compareSources";
import {
	ANGLE_TOOL,
	ARROW_TOOL,
	BIDIRECTIONAL_TOOL,
	type CompareHandle,
	ELLIPSE_TOOL,
	FREEHAND_ROI_TOOL,
	getOrganLabelAtPoint,
	LENGTH_TOOL,
	MAGNIFY_TOOL,
	PROBE_TOOL,
	type PrimaryMouseToolName,
	ROI_TOOL,
	setupCompare,
	VIEWPORT_IDS,
} from "../helpers/compareViewer";
import { segmentation_categories, segmentation_category_colors } from "../helpers/constants";
import { filenameToName } from "../helpers/utils.name";
import { useToolbarFlyout } from "../helpers/viewer/useToolbarFlyout";
// Reuse the single viewer's design-system CSS (vp-* classes) so the toolbar is visually
// identical. Its rules are namespaced (vp-*) and its CSS variables are re-declared on
// .cmv below, so importing it here has no side effects on this page.
import "../routes/VisualizationPage.css";
import "./CompareViewerPage.css";

const CT_PRESETS = [
	{ name: "Soft Tissue", width: 400, center: 40 },
	{ name: "Bone", width: 1800, center: 400 },
	{ name: "Lung", width: 1500, center: -600 },
	{ name: "Liver", width: 150, center: -50 },
] as const;

type ViewMode = "mpr" | "axial" | "sagittal" | "coronal";

// 3D is omitted: the single viewer's 3D is a per-case mesh render that has no meaning in a
// two-case side-by-side layout. The other four modes match the single viewer exactly.
const VIEW_MODES: { mode: ViewMode; label: string }[] = [
	{ mode: "mpr", label: "⊞ MPR" },
	{ mode: "axial", label: "Axial" },
	{ mode: "sagittal", label: "Sag" },
	{ mode: "coronal", label: "Cor" },
];

// Measurement tools + magnify loupe the toolbar can switch the primary mouse button to
// (on both cases at once) — same set as the single viewer.
const MEASURE_TOOLS: { name: PrimaryMouseToolName; label: string; Icon: typeof IconRuler2 }[] = [
	{ name: LENGTH_TOOL, label: "Distance (mm)", Icon: IconRuler2 },
	{ name: BIDIRECTIONAL_TOOL, label: "Bidirectional · long × short axis", Icon: IconArrowsCross },
	{ name: ANGLE_TOOL, label: "Angle (°)", Icon: IconAngle },
	{ name: PROBE_TOOL, label: "HU at point", Icon: IconClick },
	{ name: ROI_TOOL, label: "Rect ROI · HU & area", Icon: IconSquareDashed },
	{ name: ELLIPSE_TOOL, label: "Ellipse ROI · HU & area", Icon: IconCircle },
	{ name: FREEHAND_ROI_TOOL, label: "Freehand ROI · HU & area", Icon: IconLasso },
	{ name: ARROW_TOOL, label: "Arrow · label a finding", Icon: IconArrowUpRight },
	{ name: MAGNIFY_TOOL, label: "Magnify loupe", Icon: IconZoomIn },
];

// Hover-identify resolves a segment index to a display name — same static organ catalog
// the Class Map panel uses (compare has no custom/edited classes, unlike the single viewer).
const resolveOrganLabel = (idx: number): string | undefined => {
	const staticName = segmentation_categories[idx - 1];
	return staticName ? filenameToName(staticName) : undefined;
};

// Cornerstone's segmentation Color is [r, g, b, a] on a 0–255 scale; CSS wants alpha 0–1.
const colorToCss = (c: readonly number[] | undefined): string =>
	c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : "rgba(255, 255, 255, 0.4)";

export default function CompareViewerPage() {
	const [params] = useSearchParams();
	const idA = params.get("a") ?? "";
	const idB = params.get("b") ?? "";

	const aAx = useRef<HTMLDivElement>(null);
	const aSag = useRef<HTMLDivElement>(null);
	const aCor = useRef<HTMLDivElement>(null);
	const bAx = useRef<HTMLDivElement>(null);
	const bSag = useRef<HTMLDivElement>(null);
	const bCor = useRef<HTMLDivElement>(null);
	const handleRef = useRef<CompareHandle | null>(null);

	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [linked, setLinked] = useState(true);
	const [syncCursor, setSyncCursor] = useState(false);
	const [opacityValue, setOpacityValue] = useState(60); // 0–100, matches the single viewer
	const [activePreset, setActivePreset] = useState<string>("Soft Tissue");
	const [winWidth, setWinWidth] = useState(400);
	const [winCenter, setWinCenter] = useState(40);
	// The toolbar lives in normal flow, above the viewports, and is hidden by default —
	// same "opens clean/full-bleed" behavior as the single viewer's vp-topbar.
	const [showToolbar, setShowToolbar] = useState(false);
	const topbarRef = useRef<HTMLDivElement>(null);
	// Class Map panel (OrganCheckbox) open state — mirrors the single viewer's showOrganDetails.
	const [showOrganDetails, setShowOrganDetails] = useState(false);
	const [viewMode, setViewMode] = useState<ViewMode>("mpr");
	const [zoom, setZoom] = useState(1);
	// Per-organ visibility applied to BOTH cases. Index 0 = background (always on).
	const [organVisible, setOrganVisible] = useState<boolean[]>(
		() => [true, ...segmentation_categories.map(() => true)]
	);
	// Hover-to-identify: names the organ under the cursor without moving the crosshair.
	const [hoverIdentifyEnabled, setHoverIdentifyEnabled] = useState(false);
	const [hoverTip, setHoverTip] = useState({ visible: false, x: 0, y: 0, text: "", color: "transparent" });
	// Reference lines: dotted line in a case's other 2 panes for whichever of that case's
	// panes was last scrolled — tracked independently per case inside compareViewer.ts.
	const [referenceLinesOn, setReferenceLinesOn] = useState(false);
	// Cine playback acts on whichever pane was last clicked/scrolled (tracked in compareViewer.ts).
	const [cinePlaying, setCinePlaying] = useState(false);
	const [cineFps, setCineFps] = useState(12);
	// Measurement tools + magnify share one "owns the primary button" slot, applied to
	// both cases at once so either can be measured while a tool is active.
	const [activeMeasureTool, setActiveMeasureTool] = useState<PrimaryMouseToolName | null>(null);
	const [showMeasurePanel, setShowMeasurePanel] = useState(false);

	const viewFlyout = useToolbarFlyout();
	const windowFlyout = useToolbarFlyout();
	const adjustFlyout = useToolbarFlyout();
	const syncFlyout = useToolbarFlyout();
	const measureFlyout = useToolbarFlyout();
	const cineFlyout = useToolbarFlyout();

	useEffect(() => {
		if (!idA || !idB) {
			setStatus("idle");
			return;
		}
		let cancelled = false;
		let handle: CompareHandle | null = null;
		setStatus("loading");
		(async () => {
			try {
				const [sa, sb] = await Promise.all([resolveSources(idA), resolveSources(idB)]);
				if (cancelled || !aAx.current) return;
				handle = await setupCompare(
					{
						aAx: aAx.current!, aSag: aSag.current!, aCor: aCor.current!,
						bAx: bAx.current!, bSag: bSag.current!, bCor: bCor.current!,
					},
					{ ctA: sa.ct, segA: sa.seg, ctB: sb.ct, segB: sb.seg }
				);
				if (cancelled) {
					handle.destroy();
					return;
				}
				handleRef.current = handle;
				handle.applyWindow(400, 40); // Soft Tissue default
				setStatus("ready");
			} catch (e) {
				console.error(e);
				if (!cancelled) setStatus("error");
			}
		})();
		return () => {
			cancelled = true;
			handle?.destroy();
			handleRef.current = null;
			// The old handle's cine interval/measurement-tool state is gone with it; drop the
			// UI-only state that tracked it so a fresh load starts in plain navigation mode.
			setCinePlaying(false);
			setActiveMeasureTool(null);
		};
	}, [idA, idB]);

	useEffect(() => {
		handleRef.current?.setLinked(linked);
	}, [linked]);
	useEffect(() => {
		handleRef.current?.setSyncCursor(syncCursor);
	}, [syncCursor]);
	useEffect(() => {
		handleRef.current?.setSegOpacity(opacityValue / 100);
	}, [opacityValue]);
	useEffect(() => {
		handleRef.current?.setOrganVisibility(organVisible);
	}, [organVisible]);
	useEffect(() => {
		handleRef.current?.applyZoom(zoom);
	}, [zoom]);
	useEffect(() => {
		handleRef.current?.setReferenceLines(referenceLinesOn);
	}, [referenceLinesOn]);
	useEffect(() => {
		handleRef.current?.setActiveMeasurementTool(activeMeasureTool);
	}, [activeMeasureTool]);
	// Re-apply the user's view settings once a fresh load is ready. A new case load builds a
	// new handle with default state (all organs on, 0.6 opacity, fit zoom), so if the user had
	// changed any of these before switching cases we push them back onto the new handle. The
	// per-setting effects above only fire on change, not on reload.
	useEffect(() => {
		if (status !== "ready") return;
		handleRef.current?.setOrganVisibility(organVisible);
		handleRef.current?.setSegOpacity(opacityValue / 100);
		handleRef.current?.applyZoom(zoom);
		handleRef.current?.setReferenceLines(referenceLinesOn);
		// Inputs intentionally omitted: the per-setting effects handle live changes; this runs
		// only when a load completes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status]);
	// The viewport grid changes size whenever the view mode switches between MPR (3 planes)
	// and a single plane, OR the Class Map panel opens/closes (it's a real docked 288px-wide
	// sidebar — flex-basis + display:none/flex — not an overlay, so it genuinely narrows the
	// stage, not just paints over it). Cornerstone's RenderingEngine doesn't know the DOM
	// around it resized unless told to — without this, its canvases keep their stale
	// pre-toggle dimensions, so anything relying on canvas-to-world math (centerCursor, zoom)
	// looks subtly wrong until something else happens to trigger a resize. Re-fit after the
	// layout has painted (double rAF, like the single viewer).
	useEffect(() => {
		if (status !== "ready") return;
		let raf1 = 0;
		let raf2 = 0;
		raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => handleRef.current?.refit());
		});
		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
		};
	}, [viewMode, status, showOrganDetails]);

	const applyPreset = (preset: (typeof CT_PRESETS)[number]) => {
		setActivePreset(preset.name);
		setWinWidth(preset.width);
		setWinCenter(preset.center);
		handleRef.current?.applyWindow(preset.width, preset.center);
	};
	// Same contract as the single viewer's window-change handler: fall back to the current
	// value for whichever side isn't being changed.
	const handleWindowChange = (newWidth: number | null, newCenter: number | null) => {
		const width = Math.max(newWidth ?? winWidth, 1);
		const center = newCenter ?? winCenter;
		setActivePreset("");
		setWinWidth(width);
		setWinCenter(center);
		handleRef.current?.applyWindow(width, center);
	};

	const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const value = Number(e.target.value);
		setOpacityValue(value);
		handleRef.current?.setSegOpacity(value / 100);
	};

	const resetView = () => {
		setZoom(1);
		handleRef.current?.resetView();
	};

	// Jump both cases' crosshairs to the organ's centroid, and make sure it's visible first
	// (matches the single viewer's behaviour).
	const handleJumpToOrgan = (label: number) => {
		setOrganVisible((prev) => {
			if (prev[label]) return prev;
			const next = [...prev];
			next[label] = true;
			return next;
		});
		handleRef.current?.jumpToOrgan(label);
	};

	// Hover-identify: resolves the organ under the cursor via the SAME viewport the mouse
	// is over (works on any of the 6 panes — each looks up that pane's own case's volume).
	const handlePaneHover = (viewportId: string) => (e: React.MouseEvent) => {
		if (!hoverIdentifyEnabled) return;
		const idx = getOrganLabelAtPoint(viewportId, e.clientX, e.clientY);
		if (idx == null || idx === 0) {
			setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));
			return;
		}
		const name = resolveOrganLabel(idx) ?? "Unknown";
		const color = colorToCss(segmentation_category_colors[idx]);
		setHoverTip({ visible: true, x: e.clientX + 14, y: e.clientY + 14, text: name, color });
	};
	const handlePaneHoverLeave = () => setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));

	// Focus (which pane cine/flip/rotate act on) is tracked inside compareViewer.ts itself
	// via its own mousedown/wheel listeners — this just forwards an explicit click there too,
	// so clicking (without dragging) a pane also moves focus, matching the single viewer.
	const handlePaneMouseDown = (viewportId: string) => () => handleRef.current?.setFocusedViewport(viewportId);

	const toggleCine = () => {
		if (cinePlaying) {
			handleRef.current?.stopCine();
			setCinePlaying(false);
			return;
		}
		const ok = handleRef.current?.startCine(cineFps) ?? false;
		setCinePlaying(ok);
	};
	const handleCineFpsChange = (fps: number) => {
		setCineFps(fps);
		if (cinePlaying) {
			handleRef.current?.stopCine();
			handleRef.current?.startCine(fps);
		}
	};

	const bothIds = idA && idB;
	const syncActive = linked || syncCursor;
	const activeMeasureEntry = MEASURE_TOOLS.find((t) => t.name === activeMeasureTool);
	const ActiveMeasureIcon = activeMeasureEntry?.Icon ?? IconRuler2;

	return (
		<div className="cmv">
			{bothIds && showToolbar && (
				<div className="vp-topbar" ref={topbarRef}>
					<button
						className="vp-iconbtn"
						title="Hide toolbar"
						aria-label="Toggle toolbar"
						onClick={() => setShowToolbar(false)}
					>
						<IconSettings size={20} color="white" />
					</button>
					<Link
						className="vp-iconbtn"
						to={`/compare?a=${idA}&b=${idB}`}
						aria-label="Back to comparison"
						title="Back to comparison"
					>
						<IconHome size={20} color="white" />
					</Link>

					<span className="vp-tb-divider" />

					<div className="vp-tb-id">
						<span className="vp-tb-id__eyebrow">Compare</span>
						<span className="vp-tb-id__val">#{idA} vs #{idB}</span>
					</div>

					<span className="vp-tb-divider" />

					{/* View ▾ — MPR/Axial/Sag/Cor, same set as the single viewer minus 3D
					    (which has no meaning for a two-case side-by-side layout). */}
					<div className="vp-toolgroup" ref={viewFlyout.groupRef}>
						<button
							ref={viewFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${viewFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={viewFlyout.toggle}
							aria-label="View"
							aria-haspopup="menu"
							aria-expanded={viewFlyout.open}
						>
							<span>{VIEW_MODES.find((v) => v.mode === viewMode)?.label ?? "View"}</span>
							<IconChevronDown size={13} />
						</button>
						{viewFlyout.open && viewFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--config"
									role="menu"
									ref={viewFlyout.menuRef}
									style={{ position: "fixed", top: viewFlyout.pos.top, left: viewFlyout.pos.left }}
								>
									<span className="vp-panel__title">View</span>
									<div className="vp-seg" role="group" aria-label="View mode">
										{VIEW_MODES.map((v) => (
											<button
												key={v.mode}
												onClick={() => setViewMode(v.mode)}
												className={`vp-seg__btn ${viewMode === v.mode ? "vp-seg__btn--active" : ""}`}
											>
												{v.label}
											</button>
										))}
									</div>
									<button
										className={`vp-flyout__item ${hoverIdentifyEnabled ? "is-active" : ""}`}
										role="menuitem"
										title="Name the organ under the cursor, in either case"
										onClick={() => {
											setHoverIdentifyEnabled((v) => !v);
											setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));
											viewFlyout.close();
										}}
									>
										<IconScanEye size={18} />
										<span>{hoverIdentifyEnabled ? "Hover identify: on" : "Hover identify"}</span>
									</button>
									<button
										className={`vp-flyout__item ${referenceLinesOn ? "is-active" : ""}`}
										role="menuitem"
										title="Dotted line in each case's other panes for whichever you scroll"
										onClick={() => {
											setReferenceLinesOn((v) => !v);
											viewFlyout.close();
										}}
									>
										<IconGrid3x3 size={18} />
										<span>{referenceLinesOn ? "Reference lines: on" : "Reference lines"}</span>
									</button>
									<button
										className="vp-flyout__item"
										role="menuitem"
										title="The focused pane — last one clicked or scrolled"
										onClick={() => {
											handleRef.current?.flipFocused();
											viewFlyout.close();
										}}
									>
										<IconFlipHorizontal size={18} />
										<span>Flip horizontal</span>
									</button>
									<button
										className="vp-flyout__item"
										role="menuitem"
										title="The focused pane — last one clicked or scrolled"
										onClick={() => {
											handleRef.current?.rotateFocused90();
											viewFlyout.close();
										}}
									>
										<IconRotateClockwise size={18} />
										<span>Rotate 90° clockwise</span>
									</button>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Window ▾ — CT presets. Trigger shows the active preset's name. */}
					<div className="vp-toolgroup" ref={windowFlyout.groupRef}>
						<button
							ref={windowFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${windowFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={windowFlyout.toggle}
							aria-label="CT window preset"
							aria-haspopup="menu"
							aria-expanded={windowFlyout.open}
						>
							<span>{activePreset || "Window"}</span>
							<IconChevronDown size={13} />
						</button>
						{windowFlyout.open && windowFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									role="menu"
									ref={windowFlyout.menuRef}
									style={{ position: "fixed", top: windowFlyout.pos.top, left: windowFlyout.pos.left }}
								>
									{CT_PRESETS.map((preset) => (
										<button
											key={preset.name}
											className={`vp-flyout__item ${activePreset === preset.name ? "is-active" : ""}`}
											role="menuitem"
											onClick={() => applyPreset(preset)}
										>
											<span>{preset.name}</span>
										</button>
									))}
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Adjust ▾ — mask fill opacity, brightness, contrast, zoom, plus center/reset. */}
					<div className="vp-toolgroup" ref={adjustFlyout.groupRef}>
						<button
							ref={adjustFlyout.btnRef}
							className={`vp-tool ${adjustFlyout.open ? "vp-tool--active" : ""}`}
							onClick={adjustFlyout.toggle}
							aria-label="Adjust"
							aria-haspopup="menu"
							aria-expanded={adjustFlyout.open}
						>
							<IconAdjustmentsHorizontal size={20} color={adjustFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Adjust</span>
						</button>
						{adjustFlyout.open && adjustFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--adjust"
									role="menu"
									ref={adjustFlyout.menuRef}
									style={{ position: "fixed", top: adjustFlyout.pos.top, left: adjustFlyout.pos.left }}
								>
									<label className="vp-tb-slider" title="Segmentation fill opacity">
										<span className="vp-tb-slider__label">Fill</span>
										<input
											type="range" min="0" max="100" step="1" className="vp-range"
											aria-label="Segmentation opacity"
											value={opacityValue}
											onChange={handleOpacityChange}
										/>
										<span className="vp-tb-slider__val">{Math.round(opacityValue)}%</span>
									</label>
									<label className="vp-tb-slider" title="Brightness (window level)">
										<span className="vp-tb-slider__label">Brt</span>
										<input
											type="range" min="-1000" max="1000" step="1" className="vp-range"
											aria-label="Brightness"
											value={winCenter * -1}
											onChange={(e) => handleWindowChange(null, Number(e.target.value) * -1)}
										/>
									</label>
									<label className="vp-tb-slider" title="Contrast (window width)">
										<span className="vp-tb-slider__label">Con</span>
										<input
											type="range" min="1" max="2000" step="1" className="vp-range"
											aria-label="Contrast"
											value={winWidth}
											onChange={(e) => handleWindowChange(Number(e.target.value), null)}
										/>
									</label>
									<label className="vp-tb-slider" title="Zoom">
										<span className="vp-tb-slider__label">Zoom</span>
										<input
											type="range" min="0.5" max="2" step="0.05" className="vp-range"
											aria-label="Zoom"
											value={zoom}
											onChange={(e) => setZoom(Number(e.target.value))}
										/>
										<span className="vp-tb-slider__val">{zoom.toFixed(2)}×</span>
									</label>
									<div className="vp-flyout--adjust__actions">
										<button className="vp-tb-mini" onClick={() => handleRef.current?.centerCursor()} title="Center on crosshair">
											Center
										</button>
										<button className="vp-tb-mini" onClick={resetView} title="Reset zoom & pan">
											Reset
										</button>
									</div>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Measure ▾ — distance/angle/probe/ROI/arrow tools + magnify loupe, applied to
					    BOTH cases at once (draw on whichever one you click). */}
					<div className="vp-toolgroup" ref={measureFlyout.groupRef}>
						<button
							ref={measureFlyout.btnRef}
							className={`vp-tool ${activeMeasureTool || measureFlyout.open ? "vp-tool--active" : ""}`}
							onClick={measureFlyout.toggle}
							aria-label="Measurement tools"
							aria-haspopup="menu"
							aria-expanded={measureFlyout.open}
						>
							<ActiveMeasureIcon size={20} color={activeMeasureTool || measureFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Measure</span>
						</button>
						{measureFlyout.open && measureFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									role="menu"
									ref={measureFlyout.menuRef}
									style={{ position: "fixed", top: measureFlyout.pos.top, left: measureFlyout.pos.left }}
								>
									{MEASURE_TOOLS.map(({ name, label, Icon }) => (
										<button
											key={name}
											className={`vp-flyout__item ${activeMeasureTool === name ? "is-active" : ""}`}
											role="menuitem"
											onClick={() => {
												setActiveMeasureTool((p) => (p === name ? null : name));
												measureFlyout.close();
											}}
										>
											<Icon size={18} />
											<span>{label}</span>
										</button>
									))}
									<button
										className="vp-flyout__item"
										role="menuitem"
										onClick={() => {
											handleRef.current?.clearMeasurements();
											measureFlyout.close();
										}}
									>
										<IconTrash size={18} />
										<span>Clear measurements</span>
									</button>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Cine ▾ — the one flyout that stays open on click: a live mini-panel
					    (play/pause + FPS side by side), not a pick-and-dismiss menu. Plays
					    whichever pane was last clicked/scrolled. */}
					<div className="vp-toolgroup" ref={cineFlyout.groupRef}>
						<button
							ref={cineFlyout.btnRef}
							className={`vp-tool ${cinePlaying || cineFlyout.open ? "vp-tool--active" : ""}`}
							onClick={cineFlyout.toggle}
							aria-label="Cine controls"
							aria-haspopup="menu"
							aria-expanded={cineFlyout.open}
						>
							{cinePlaying ? (
								<IconPlayerPause size={20} color={cineFlyout.open ? "#08090b" : "white"} />
							) : (
								<IconPlayerPlay size={20} color={cineFlyout.open ? "#08090b" : "white"} />
							)}
							<span className="vp-tool__tip">
								{cinePlaying ? `Cine playing (${cineFps} fps) — click for controls` : "Cine controls"}
							</span>
						</button>
						{cineFlyout.open && cineFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--cine"
									role="menu"
									ref={cineFlyout.menuRef}
									style={{ position: "fixed", top: cineFlyout.pos.top, left: cineFlyout.pos.left }}
								>
									<button
										className={`vp-tool vp-tool--cine-play ${cinePlaying ? "vp-tool--active" : ""}`}
										onClick={toggleCine}
										aria-label={cinePlaying ? "Pause cine playback" : "Play cine playback"}
									>
										{cinePlaying ? (
											<IconPlayerPause size={20} color="#08090b" />
										) : (
											<IconPlayerPlay size={20} color="white" />
										)}
									</button>
									<label className="vp-tb-slider vp-tb-slider--cine" title="Cine playback speed">
										<span className="vp-tb-slider__label">FPS</span>
										<input
											type="range" min="1" max="100" step="1" className="vp-range"
											aria-label="Cine frames per second"
											value={cineFps}
											onChange={(e) => handleCineFpsChange(Number(e.target.value))}
										/>
										<span className="vp-tb-slider__val">{cineFps}</span>
									</label>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Class Map — the same full-view organ panel as the single viewer. */}
					<button
						className={`vp-tool ${showOrganDetails ? "vp-tool--active" : ""}`}
						onClick={() => setShowOrganDetails((v) => !v)}
						aria-label="Organs"
						aria-pressed={showOrganDetails}
					>
						<IconStack2 size={20} color={showOrganDetails ? "#08090b" : "white"} />
						<span className="vp-tool__tip">Organs</span>
					</button>

					{/* Measurements list — rename/jump/delete each annotation, tagged with which case. */}
					<button
						className={`vp-tool ${showMeasurePanel ? "vp-tool--active" : ""}`}
						onClick={() => setShowMeasurePanel((v) => !v)}
						aria-label="Measurements"
						aria-pressed={showMeasurePanel}
					>
						<IconClipboardList size={20} color={showMeasurePanel ? "#08090b" : "white"} />
						<span className="vp-tool__tip">Measurements</span>
					</button>

					<span className="vp-tb-divider" />

					{/* Sync ▾ — compare-only, no equivalent in the single viewer. Keeps the two
					    cases' navigation in step (proportional slice link, and/or a shared
					    cursor position). */}
					<div className="vp-toolgroup" ref={syncFlyout.groupRef}>
						<button
							ref={syncFlyout.btnRef}
							className={`vp-tool ${syncActive || syncFlyout.open ? "vp-tool--active" : ""}`}
							onClick={syncFlyout.toggle}
							aria-label="Sync"
							aria-haspopup="menu"
							aria-expanded={syncFlyout.open}
						>
							<IconLink size={20} color={syncActive || syncFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Sync</span>
						</button>
						{syncFlyout.open && syncFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									role="menu"
									ref={syncFlyout.menuRef}
									style={{ position: "fixed", top: syncFlyout.pos.top, left: syncFlyout.pos.left }}
								>
									<button
										className={`vp-flyout__item ${linked ? "is-active" : ""}`}
										role="menuitem"
										title="Keep both cases at the same proportional slice position"
										onClick={() => setLinked((v) => !v)}
									>
										<IconLink size={18} />
										<span>{linked ? "Link scroll: on" : "Link scroll"}</span>
									</button>
									<button
										className={`vp-flyout__item ${syncCursor ? "is-active" : ""}`}
										role="menuitem"
										title="Mirror the crosshair position between cases"
										onClick={() => setSyncCursor((v) => !v)}
									>
										<IconPointer size={18} />
										<span>{syncCursor ? "Sync cursor: on" : "Sync cursor"}</span>
									</button>
								</div>,
								document.body
							)}
					</div>
				</div>
			)}

			{/* Keep the collapsed-toolbar control in its own chrome row.  The old
			    floating button sat on top of the first viewport and could obscure
			    the case label/text underneath it. */}
			{bothIds && !showToolbar && (
				<div className="cmv__collapsedbar">
					<button
						className="vp-floating-gear vp-iconbtn"
						title="Show toolbar"
						aria-label="Toggle toolbar"
						onClick={() => setShowToolbar(true)}
					>
						<IconSettings size={20} color="white" />
					</button>
				</div>
			)}

			{!bothIds ? (
				<div className="cmv__msg">
					Provide two case ids in the URL, e.g. <code>/compare-viewer?a=1&amp;b=2</code>.
				</div>
			) : (
				<div className="vp-body">
					{/* Class Map: full-view organ panel (slides over everything), identical to the
					    single viewer. Kept mounted so it can slide in/out. */}
					<OrganCheckbox
						setCheckState={setOrganVisible}
						checkState={organVisible}
						sessionId={undefined}
						setShowOrganDetails={setShowOrganDetails}
						showOrganDetails={showOrganDetails}
						labelColorMap={segmentation_category_colors}
						onJumpToOrgan={handleJumpToOrgan}
					/>

					<div className="vp-stage cmv__grid">
					{[
						{
							id: idA, ax: aAx, sag: aSag, cor: aCor,
							vp: { axial: VIEWPORT_IDS.aAx, sagittal: VIEWPORT_IDS.aSag, coronal: VIEWPORT_IDS.aCor },
						},
						{
							id: idB, ax: bAx, sag: bSag, cor: bCor,
							vp: { axial: VIEWPORT_IDS.bAx, sagittal: VIEWPORT_IDS.bSag, coronal: VIEWPORT_IDS.bCor },
						},
					].map((row, r) => (
						<div
							className="cmv__caserow"
							key={r}
							style={viewMode === "mpr" ? undefined : { gridTemplateColumns: "1fr" }}
						>
							{([
								["Axial", "axial", row.ax],
								["Sagittal", "sagittal", row.sag],
								["Coronal", "coronal", row.cor],
							] as const).map(([label, mode, ref], c) => {
								// Keep every viewport div mounted (Cornerstone needs its element);
								// just hide the planes not in the current view mode.
								const hidden = viewMode !== "mpr" && viewMode !== mode;
								const viewportId = row.vp[mode];
								return (
									<div className="cmv__cell" key={c} style={hidden ? { display: "none" } : undefined}>
										{c === 0 && <span className="cmv__caselabel">Case {row.id}</span>}
										<span className="cmv__planelabel">{label}</span>
										<div
											className={`cmv__viewport${hoverIdentifyEnabled ? " cmv__viewport--hover-identify" : ""}`}
											ref={ref}
											onContextMenu={(e) => e.preventDefault()}
											onMouseMove={handlePaneHover(viewportId)}
											onMouseLeave={handlePaneHoverLeave}
											onMouseDown={handlePaneMouseDown(viewportId)}
										/>
									</div>
								);
							})}
						</div>
					))}

					{status === "loading" && (
						<div className="cmv__overlay">
							<span className="cmv__spinner" /> Loading both cases…
						</div>
					)}
					{status === "error" && (
						<div className="cmv__overlay cmv__overlay--err">
							Couldn't load one or both cases.
							<br />
							<span style={{ opacity: 0.7 }}>Large scans stream slowly from HuggingFace locally.</span>
						</div>
					)}
					</div>

					{showMeasurePanel && (
						<CompareMeasurementPanel
							handle={handleRef.current}
							idA={idA}
							idB={idB}
							onClose={() => setShowMeasurePanel(false)}
						/>
					)}
				</div>
			)}

			{hoverTip.visible && (
				<div
					className="vp-organ-tip"
					style={{ left: hoverTip.x, top: hoverTip.y, borderLeftColor: hoverTip.color }}
				>
					<span className="vp-organ-tip__swatch" style={{ background: hoverTip.color }} />
					{hoverTip.text}
				</div>
			)}
		</div>
	);
}
