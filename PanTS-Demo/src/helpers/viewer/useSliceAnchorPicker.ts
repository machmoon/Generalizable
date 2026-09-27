// Powers the guided "click the shape on the first/last slice" flow shared by
// CopyAcrossSlicesFlyout and FillBetweenSlicesFlyout. The user never types a
// pane name or a slice number — they click directly in whichever pane it's
// easiest to see the class in, and this resolves pane + slice index for them
// via pickSliceAnchorAtClientPoint.
import { useEffect, useRef, useState } from "react";
import { pickSliceAnchorAtClientPoint, type CinePane } from "../CornerstoneNifti2";

export type SliceAnchor = { pane: CinePane; sliceIndex: number };
type Step = "first" | "last";
type Phase = "idle" | "picking" | "ready";

interface Options {
	segmentIndex: number;
	lastRequiresSegment: boolean;
	/** Every rejected click (wrong spot, wrong pane, same slice, etc.) is reported here — never silent. */
	onError: (detail: string) => void;
}

export function useSliceAnchorPicker({ segmentIndex, lastRequiresSegment, onError }: Options) {
	const [step, setStep] = useState<Step>("first");
	const [phase, setPhase] = useState<Phase>("idle");
	const [first, setFirst] = useState<SliceAnchor | null>(null);
	const [last, setLast] = useState<SliceAnchor | null>(null);
	const stepRef = useRef(step);
	stepRef.current = step;
	const firstRef = useRef(first);
	firstRef.current = first;

	// onError is an inline arrow in every caller, so its identity changes on
	// every parent render — including renders caused by the error state this
	// callback itself sets. If it were a dependency of the listener effect
	// below, every error would tear down and re-add the window listener,
	// and any click landing in that gap would be silently dropped. That's
	// what produced "step 2 does nothing, no error at all" — the listener
	// simply wasn't attached at the instant of the click. Route calls
	// through a ref instead so the effect never resubscribes because of it.
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	useEffect(() => {
		if (phase !== "picking") return;

		const onClick = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (target?.closest?.("[data-guided-overlay]")) return;

			const hit = pickSliceAnchorAtClientPoint(e.clientX, e.clientY);
			if (!hit) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();

			const isFirstStep = stepRef.current === "first";
			const needsSegment = isFirstStep || lastRequiresSegment;
			if (needsSegment && hit.segmentAtPoint !== segmentIndex) {
				onErrorRef.current(
					isFirstStep
						? "Valid class is not drawn here"
						: "Valid class is not drawn here"
				);
				return;
			}

			if (isFirstStep) {
				setFirst({ pane: hit.pane, sliceIndex: hit.sliceIndex });
				setStep("last");
				return; // stay in picking mode for the second click
			}

			// step === "last"
			if (firstRef.current && hit.pane !== firstRef.current.pane) {
				onErrorRef.current(`Click in the same view (${firstRef.current.pane}) as the first slice.`);
				return;
			}
			if (firstRef.current && hit.sliceIndex === firstRef.current.sliceIndex) {
				onErrorRef.current("That's the same slice — scroll to a different one first.");
				return;
			}
			setLast({ pane: hit.pane, sliceIndex: hit.sliceIndex });
			setPhase("ready");
		};

		window.addEventListener("pointerdown", onClick, true);
		return () => window.removeEventListener("pointerdown", onClick, true);
	}, [phase, segmentIndex, lastRequiresSegment]);

	const startPicking = () => {
		setPhase("picking");
		setStep(first ? "last" : "first");
	};
	const cancelPicking = () => setPhase(first && last ? "ready" : "idle");

	const reset = () => {
		setFirst(null);
		setLast(null);
		setStep("first");
		setPhase("idle");
	};

	return {
		phase,
		step,
		first,
		last,
		startPicking,
		cancelPicking,
		reset,
	};
}