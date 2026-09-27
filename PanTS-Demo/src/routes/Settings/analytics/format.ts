// Turning stored values into something readable at a glance.

/** "4m 12s", "1h 20m", "3.2s" — the largest unit that isn't a lie. */
export const duration = (ms: number): string => {
	if (!ms) return "0s";
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
};

export const count = (n: number): string => n.toLocaleString();

/** First letter up, rest untouched — for plan names, account types, roles. */
export const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Event names are stored as they're fired ("upload_start_inference") because
// that's the string the code uses and the one to grep for. They're only
// prettified at the last moment, here.
const WORDS: Record<string, string> = {
	ai: "AI",
	cta: "CTA",
};

export const eventLabel = (name: string): string => {
	const words = name.split("_").map((w) => WORDS[w] ?? w);
	return [titleCase(words[0]), ...words.slice(1)].join(" ");
};

/** The area of the app an event belongs to, from its prefix. */
export const eventArea = (name: string): string => {
	const area = name.split("_")[0];
	return area === "auth" ? "account" : area;
};

/** "8 Aug" — the axis is a range of days, so the year would be noise. */
export const shortDay = (iso: string): string => {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** YYYY-MM-DD for an <input type="date">, n days back from today. */
export const dateInput = (daysAgo = 0): string => {
	const d = new Date();
	d.setDate(d.getDate() - daysAgo);
	return d.toISOString().slice(0, 10);
};

/** A figure against the same figure last period.
 *
 *  Returns null when there is nothing honest to say: no previous period at all
 *  (this is the first month the site has data for) reads as infinite growth,
 *  and "+100%" off a base of one visit is noise dressed as a trend. Both are
 *  better left blank than stated — the tile still shows the number itself.
 */
export const delta = (current: number, previous: number): {
	pct: number; up: boolean; label: string;
} | null => {
	if (!previous) return null;
	const change = ((current - previous) / previous) * 100;
	if (Math.abs(change) < 1) return null;  // flat; a "+0%" badge is just clutter
	const rounded = Math.round(change);
	return {
		pct: rounded,
		up: rounded > 0,
		label: `${rounded > 0 ? "+" : ""}${rounded}%`,
	};
};
