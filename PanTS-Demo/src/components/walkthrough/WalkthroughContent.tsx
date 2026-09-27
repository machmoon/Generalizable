import type { WalkthroughStep } from "./ToolWalkthrough";
import type { PrimaryEditTool } from "../viewer/AnnotationToolbar";


// ---------------------------------------------------------------------------
// Overview walkthrough — shown the first time "Annotate" is pressed, and
// replayable any time via its own launcher. Walks through every moving
// piece of the annotation UI: the segments popup (pick or create a target),
// the vertical tool dock, and the per-tool corner panel — including how to
// drag and minimize/expand each of the three.
// ---------------------------------------------------------------------------
export interface OverviewRects {
	popupRect?: DOMRect | null;
	popupDragRect?: DOMRect | null;
	popupMinRect?: DOMRect | null;
	dockRect?: DOMRect | null;
	dockDragRect?: DOMRect | null;
	dockMinRect?: DOMRect | null;
	panelRect?: DOMRect | null;
	panelDragRect?: DOMRect | null;
	panelMinRect?: DOMRect | null;
}

export function buildOverviewSteps(r: OverviewRects): WalkthroughStep[] {
	return [
		{
			title: "Welcome to annotation mode",
			body: (
				<>
					This is a quick tour of the annotation tools — five short steps, then
					you're set. Every panel you'll see can be dragged out of the way and
					minimized, so nothing here is ever stuck blocking your view.
				</>
			),
			note: (
				<>
					There's a live 3D rendering of every annotation you draw, updating as
					you go — a quick way to sanity-check a shape's overall form, not just
					what it looks like on one slice.
				</>
			),
		},
		{
			title: "Pick or create a target",
			body: (
				<>
					The segments popup is where you choose what you're about to annotate.
					Click an existing organ from the list, or add a custom class of your
					own if what you need isn't already there.
				</>
			),
			targetRect: r.popupRect,
			note: <>Want the details on custom classes specifically? There's a dedicated walkthrough for that from the popup itself.</>,
		},
		{
			title: "The segments popup can move",
			body: (
				<>
					Drag anywhere on its header to reposition it when you need it
					somewhere else on screen.
				</>
			),
			targetRect: r.popupDragRect ?? r.popupRect,
		},
		{
			title: "Minimizing the popup",
			body: (
				<>
					Use this button to collapse the popup to a small bar when you need
					the screen space — click it again to expand back to the full list.
				</>
			),
			targetRect: r.popupMinRect ?? r.popupDragRect ?? r.popupRect,
		},
		{
			title: "The tool dock",
			body: (
				<>
					Once a target is picked, this vertical dock lights up with every
					drawing tool — brush, scissors, lasso, level tracing, and more. Click
					a tool to select it; click it again to deselect.
				</>
			),
			targetRect: r.dockRect,
		},
		{
			title: "Dragging the dock",
			body: (
				<>
					Drag the small grip at the top to move the dock to either side of the
					screen — it snaps to whichever edge it's closest to.
				</>
			),
			targetRect: r.dockDragRect ?? r.dockRect,
		},
		{
			title: "Minimizing the dock",
			body: (
				<>
					This button at the bottom of the dock collapses it down to just the
					active tool's icon — click it again to bring back the full list.
				</>
			),
			targetRect: r.dockMinRect ?? r.dockDragRect ?? r.dockRect,
		},
		{
			title: "Each tool opens its own panel",
			body: (
				<>
					Selecting a tool opens a panel in the corner with that tool's
					controls — size, sensitivity, operation, whatever's relevant — plus a
					shared "Applies to" setting that scopes where the tool is allowed to
					act (e.g. only inside the current segment).
				</>
			),
			targetRect: r.panelRect,
		},
		{
			title: "Dragging panels",
			body: (
				<>
					Same idea as the dock: drag the panel's header to move it anywhere on
					screen.
				</>
			),
			targetRect: r.panelDragRect ?? r.panelRect,
		},
		{
			title: "Minimizing panels",
			body: (
				<>
					Use its minimize button to collapse the panel to just the title bar
					without losing your settings — click it again to expand.
				</>
			),
			targetRect: r.panelMinRect ?? r.panelDragRect ?? r.panelRect,
			shortcuts: [
				{ keys: ["Ctrl", "Z"], desc: "Undo the last edit (⌘ on Mac)" },
				{ keys: ["Shift", "Ctrl", "Z"], desc: "Redo" },
				{ keys: ["[", "]"], desc: "Step one slice back / forward" },
				{ keys: ["+", "−"], desc: "Zoom toward the cursor" },
			],
		},
		{
			title: "You're ready to annotate",
			body: (
				<>
					Every individual tool also has its own "Show walkthrough" button in
					its panel — use it any time you want a refresher on exactly what that
					tool does. This overview is replayable too, from the dock's help icon.
				</>
			),
		},
	];
}

// ---------------------------------------------------------------------------
// Custom class walkthrough — creating and managing a custom segmentation
// class from the segments popup.
// ---------------------------------------------------------------------------
export interface CustomClassRects {
	addClassRect?: DOMRect | null;
	tableRect?: DOMRect | null;
}

export function buildCustomClassSteps(r: CustomClassRects): WalkthroughStep[] {
	return [
		{
			title: "Add a custom class",
			body: (
				<>
					Not every structure you need is in the catalog. Use the "Add class"
					control in the segments popup to create your own — give it a name and
					it's immediately available as a target, exactly like a catalog organ.
				</>
			),
			targetRect: r.addClassRect,
		},
		{
			title: "Pick a color",
			body: (
				<>
					Each class gets a color swatch so it's easy to tell apart in both the
					2D slices and the 3D rendering. Click the swatch next to its name at
					any time to change it.
				</>
			),
			targetRect: r.tableRect,
		},
		{
			title: "Rename, hide, or delete",
			body: (
				<>
					Double-click a class's name to rename it in place. The eye icon
					toggles its visibility without deleting anything, and the trash icon
					removes it for good.
				</>
			),
			targetRect: r.tableRect,
			note: <>A custom class behaves identically to a catalog organ everywhere else — every tool, every masking option works the same on it.</>,
		},
		{
			title: "Scope it like anything else",
			body: (
				<>
					Once selected, a custom class shows up in every tool's "Applies to"
					control just like a built-in organ — you can restrict brushing,
					scissors, and every other tool to it directly.
				</>
			),
		},
	];
}

// ---------------------------------------------------------------------------
// Existing organ walkthrough — picking an already-segmented catalog organ
// to edit, from the segments popup's "Existing organ" tab.
// ---------------------------------------------------------------------------
export interface ExistingOrganRects {
	listRect?: DOMRect | null;
	tabsRect?: DOMRect | null;
}

export function buildExistingOrganSteps(r: ExistingOrganRects): WalkthroughStep[] {
	return [
		{
			title: "Edit an already-segmented organ",
			body: (
				<>
					The "Existing organ" tab lists every organ this scan already has a
					segmentation for — pick one here to edit it directly, instead of
					creating a new custom class from scratch.
				</>
			),
			targetRect: r.listRect,
		},
		{
			title: "Select one to target it",
			body: (
				<>
					Click any organ in the list to make it the active target — the tool
					dock lights up and every drawing tool now applies to that organ. Click
					it again to deselect.
				</>
			),
			targetRect: r.listRect,
			note: <>A small target icon marks whichever organ is currently active, exactly like it does on the Custom tab.</>,
		},
		{
			title: "Switch tabs any time",
			body: (
				<>
					Use these tabs to jump between editing an existing organ and creating
					or picking a custom class — your selection on one tab isn't lost when
					you switch to the other.
				</>
			),
			targetRect: r.tabsRect,
		},
	];
}

// ---------------------------------------------------------------------------
// Per-tool walkthroughs. Every tool shares the same three rects: the corner
// panel as a whole (its controls), the "Applies to" masking select (shared
// across every tool), and — for the two slice-anchor tools — the slice
// counter overlay in the corner of each 2D view.
// ---------------------------------------------------------------------------
export interface ToolRects {
	panelRect?: DOMRect | null;
	fieldRect?: DOMRect | null;
	maskingRect?: DOMRect | null;
	sliceJumpRect?: DOMRect | null;
}

const maskingStep = (r: ToolRects): WalkthroughStep => ({
	title: "Choose where it can act",
	body: (
		<>
			"Applies to" scopes every tool the same way — restrict it to only the
			active segment, only outside it, only visible segments, and so on. It
			defaults to "Everywhere".
		</>
	),
	targetRect: r.maskingRect,
});

const undoShortcuts = [
	{ keys: ["Ctrl", "Z"], desc: "Undo the last edit (⌘ on Mac)" },
	{ keys: ["Shift", "Ctrl", "Z"], desc: "Redo" },
];

const sliceJumpNote = (
	<>
		You don't have to click through slice by slice — click directly on the
		slice counter in the corner of any 2D view to type an exact slice number.
	</>
);

export function buildToolSteps(tool: Exclude<PrimaryEditTool, null>, r: ToolRects): WalkthroughStep[] {
	switch (tool) {
		case "paint":
			return [
				{
					title: "Paint with a round brush",
					body: <>Click and drag on any slice to paint into the active target. The brush is a round, size-adjustable disc.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Adjust brush size",
					body: (
						<>
							Drag the slider or type an exact millimeter value. Mid-stroke,
							skip the slider entirely with the keyboard.
						</>
					),
					targetRect: r.fieldRect ?? r.panelRect,
					shortcuts: [{ keys: ["Shift", "[", "/", "]"], desc: "Shrink / grow the brush by 2mm" }],
				},
				maskingStep(r),
				{
					title: "Useful shortcuts while painting",
					body: <>These work throughout — not just while the Brush is active.</>,
					shortcuts: [
						...undoShortcuts,
						{ keys: ["[", "]"], desc: "Step one slice" },
						{ keys: ["+", "−"], desc: "Zoom toward the cursor" },
					],
					note: <>Every brush stroke also updates the live 3D rendering in real time.</>,
				},
			];

		case "erase":
			return [
				{
					title: "Erase with a round brush",
					body: <>Same control as the Brush, but it clears voxels from the active target instead of adding them.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Adjust eraser size",
					body: <>Drag the slider or type an exact millimeter value.</>,
					targetRect: r.fieldRect ?? r.panelRect,
					shortcuts: [{ keys: ["Shift", "[", "/", "]"], desc: "Shrink / grow the eraser by 2mm" }],
				},
				maskingStep(r),
				{
					title: "Useful shortcuts",
					body: <>These work throughout — not just while Erase is active.</>,
					shortcuts: [...undoShortcuts, { keys: ["[", "]"], desc: "Step one slice" }],
				},
			];

		case "scissors":
			return [
				{
					title: "Cut through the whole segment",
					body: (
						<>
							Draw a shape on the current slice; the cut applies through the
							entire segment from this viewpoint, not just this one slice.
						</>
					),
					targetRect: r.panelRect,
				},
				{
					title: "Choose the operation",
					body: <>Erase or fill, inside or outside the shape you draw — four combinations covering most cuts.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Magnetic edge snap",
					body: <>Turn this on and each point you place snaps to the nearest strong intensity edge, like a magnetic lasso — much faster for tracing organ or bone boundaries.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
				{
					title: "Closing and undoing a shape",
					body: <>Click back on the red start point to close the shape and commit the cut.</>,
					shortcuts: [{ keys: ["Ctrl", "Z"], desc: "Undo the last placed point while drawing" }],
				},
			];

		case "levelTracing":
			return [
				{
					title: "Trace by intensity",
					body: <>Hover to preview the region of matching intensity around the cursor, click to apply it.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Choose the operation",
					body: <>Fill or erase, inside or outside the traced region.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Sensitivity",
					body: <>Higher sensitivity traces a wider range of intensities around the cursor — raise it if the region stops short of where you'd expect.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
				{
					title: "Shortcuts",
					body: <>Standard editing shortcuts apply here too.</>,
					shortcuts: undoShortcuts,
				},
			];

		case "margin":
			return [
				{
					title: "Grow or shrink a boundary",
					body: <>Expand the segment outward, or pull it inward, by a fixed margin in millimeters.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Set the margin",
					body: <>Drag the slider or type an exact value, then press Apply.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
			];

		case "smoothing":
			return [
				{
					title: "Smooth boundaries",
					body: <>Rounds off jagged edges left behind by manual brush or scissors work.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Kernel size",
					body: <>Larger values smooth more aggressively — start small and increase only if it's still rough.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
			];

		case "islands":
			return [
				{
					title: "Manage disconnected pieces",
					body: <>An "island" is any disconnected blob within a segment — useful for cleaning up stray voxels or splitting a segment apart.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Choose an operation",
					body: (
						<>
							Keep only the largest island, remove everything under a minimum
							size, or click to pick a specific island to keep, remove, or
							split off on its own.
						</>
					),
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Picking an island",
					body: <>When an operation needs a specific island, click "Start picking" then click directly on it in any 2D view.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
			];

		case "logicalOperators":
			return [
				{
					title: "Combine or transform segments",
					body: <>Copy another segment's shape, merge one into this one, invert, clear, or fully fill this segment.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Pick a source segment",
					body: <>Copy and Add both need a second segment to work with — pick it from the dropdown that appears.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Read the plain-English summary",
					body: <>The panel always spells out exactly what Apply is about to do before you press it — check it if you're ever unsure.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Bypass masking (advanced)",
					body: <>Normally an operation can't overwrite another segment's voxels. Flip this switch to allow it to — use with care.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
			];

		case "growFromSeeds":
			return [
				{
					title: "Grow a region from a few clicks",
					body: <>Mark a few points inside what you want filled, optionally mark points to exclude, then fill — a fast way to rough in a shape.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Step 1 — mark inside",
					body: <>Drop a few points anywhere inside the region. A handful of points spread around works better than a single click.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Step 2 — mark outside (optional)",
					body: <>If a neighboring structure keeps bleeding in, dot it here to keep it excluded. Skip this step if you don't need it.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Step 3 — fill",
					body: <>Grows outward from your inside points, staying clear of anything marked outside, on the current slice or across the whole volume depending on scope.</>,
					targetRect: r.fieldRect ?? r.panelRect,
					note: <>"Start over" at any point clears every mark and resets to step 1.</>,
				},
			];

		case "fillBetweenSlices":
			return [
				{
					title: "Interpolate between two slices",
					body: <>Draw the shape on two slices and this fills in every slice between them automatically.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Pick your two slices",
					body: <>Press Start, then click the shape on the first slice, then click the shape on the last slice — both need the shape already drawn.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Jumping to a specific slice",
					body: <>Navigating to the right slice first makes picking much faster.</>,
					targetRect: r.sliceJumpRect,
					note: sliceJumpNote,
					shortcuts: [
						{ keys: ["[", "]"], desc: "Step one slice" },
						{ keys: ["Shift", "[", "/", "]"], desc: "Step ten slices" },
						{ keys: ["Home", "End"], desc: "Jump to first / last slice" },
					],
				},
				{
					title: "Run it",
					body: <>Once both slices are picked, press "Interpolate" — you can always "Start over" to pick different slices.</>,
				},
			];

		case "copyAcrossSlices":
			return [
				{
					title: "Copy a shape across a range",
					body: <>Copies the exact shape from one slice onto every slice up to another — unlike interpolation, the destination doesn't need anything drawn on it already.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Pick source and destination",
					body: <>Press Start, click the shape on the source slice, then click anywhere on the destination slice.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Jumping to a specific slice",
					body: <>Navigating to the right slice first makes picking much faster.</>,
					targetRect: r.sliceJumpRect,
					note: sliceJumpNote,
					shortcuts: [
						{ keys: ["[", "]"], desc: "Step one slice" },
						{ keys: ["Shift", "[", "/", "]"], desc: "Step ten slices" },
						{ keys: ["Home", "End"], desc: "Jump to first / last slice" },
					],
				},
				{
					title: "Run it",
					body: <>Once both slices are picked, press "Copy across slices".</>,
				},
			];

		case "hollow":
			return [
				{
					title: "Turn a solid segment into a shell",
					body: <>Replaces the segment with a uniform-thickness shell — useful for wall thickness or 3D-printable casings.</>,
					targetRect: r.panelRect,
				},
				{
					title: "Choose the surface",
					body: <>Inside, medial, or outside — controls whether the shell grows inward from the current boundary, outward, or straddles it.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				{
					title: "Set thickness",
					body: <>Drag the slider or type an exact value in millimeters.</>,
					targetRect: r.fieldRect ?? r.panelRect,
				},
				maskingStep(r),
			];

		default:
			return [
				{
					title: "This tool",
					body: <>Adjust the controls in the panel, then press Apply.</>,
					targetRect: r.panelRect,
				},
				maskingStep(r),
			];
	}
}