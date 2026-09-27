/**
 * Converts a raw organ filename/key (e.g. "adrenal_gland-left") into a
 * clean, capitalized display name ("Adrenal Gland Left").
 */
export function filenameToName(filename: string): string {
	const base = filename.replace(/\.nii(\.gz)?$/i, "");
	return base
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}