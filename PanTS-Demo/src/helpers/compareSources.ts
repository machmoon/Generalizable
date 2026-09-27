// Shared CT/segmentation source resolution for the comparison viewer. The comparison
// page may warm the small viewer JavaScript chunk, but it deliberately never downloads
// CT data in the background: large speculative requests can delay the reader's chosen
// case and overload a shared server.
import { API_BASE } from "./constants";
import { getPanTSId } from "./utils";

// Local CT preview + full-resolution mask first; HuggingFace mirror fallback. Labelmaps
// stay full resolution because nearest-neighbour downsampling visibly stair-steps organ
// boundaries and can erase small structures.
export async function resolveSources(id: string): Promise<{ ct: string; seg: string }> {
	const localCt = `${API_BASE}/api/get-main-nifti/${id}.nii.gz`;
	const localSeg = `${API_BASE}/api/get-segmentations/${id}.nii.gz`;
	const p = getPanTSId(id);
	const hfCt = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/${p}/ct.nii.gz?download=true`;
	const hfSeg = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/mask_only/${p}/combined_labels.nii.gz?download=true`;
	const ok = await fetch(localCt, { method: "HEAD" })
		.then((r) => r.ok)
		.catch(() => false);
	return ok ? { ct: `${localCt}?res=low`, seg: localSeg } : { ct: hfCt, seg: hfSeg };
}

// Respect the user's data budget: skip prefetch under Save-Data or on very slow (2G)
// connections — the same restraint the browser applies to native prefetch. These volumes
// are large and only *maybe* used, so honouring this matters.
function prefetchAllowed(): boolean {
	if (typeof navigator === "undefined") return false;
	const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
	if (c?.saveData) return false;
	if (typeof c?.effectiveType === "string" && c.effectiveType.includes("2g")) return false;
	return true;
}

// Warm the lazily-loaded viewer chunk so navigating to it doesn't wait on a JS download.
export function prefetchCompareViewerChunk(): void {
	// Skip under vitest — importing the viewer chunk pulls the WebGL stack jsdom can't load.
	if (typeof process !== "undefined" && process.env?.VITEST) return;
	if (!prefetchAllowed()) return;
	import("../routes/CompareViewerPage").catch(() => {});
}
