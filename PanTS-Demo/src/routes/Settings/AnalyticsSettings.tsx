import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../contexts/authContext";
import BarList, { type Bar } from "./analytics/BarList";
import Donut from "./analytics/Donut";
import TimeBars from "./analytics/TimeBars";
import TrendLine from "./analytics/TrendLine";
import WorldMap from "./analytics/WorldMap";
import {
	DashboardDisabled, DashboardForbidden, fetchMeta, fetchOverview,
	type Audience, type Filters, type Meta, type Overview,
} from "./analytics/api";
import {
	count, dateInput, delta, duration, eventArea, eventLabel, titleCase,
} from "./analytics/format";
import "./analytics/dashboard.css";

// Usage: who comes to BodyMaps, where from, and what they do once they're here.
//
// Admin-only, and the check is here as well as in the settings nav — hiding a
// link is not access control, and this URL is guessable. The server refuses too;
// this only decides what to draw.
//
// Every panel is drawn from a single /analytics/overview response so they can
// never disagree with each other mid-change.
//
// The order follows the shape of the question, which is also the order Wix's
// traffic overview uses: how many people (with last period beside it), when
// they came, where they were, what they were using — and only then the
// feature-level detail this dashboard already had. Someone opening this page
// wants the first four at a glance; the rest is what they came back for.

const DEFAULT_FILTERS: Filters = {
	from: dateInput(29),
	to: dateInput(0),
	plan: "",
	accountType: "",
	audience: "all",
	allTime: false,
	country: "",
};

const AUDIENCE_LABELS: Record<Audience, string> = {
	all: "Everyone",
	signed_in: "Signed in",
	anonymous: "Signed out",
};

const DEVICE_LABELS: Record<string, string> = {
	desktop: "Desktop",
	mobile: "Phone",
	tablet: "Tablet",
};

// How many of the quietest features to name. All of them would be the whole
// vocabulary listed twice, most of it at zero.
const LEAST_USED_SHOWN = 8;
// The country list beside the map. Past this the tail is one visit each, and
// the map is already showing that they exist.
const COUNTRIES_SHOWN = 12;

const AnalyticsSettings: React.FC = () => {
	const { user } = useAuth();
	const isAdmin = !!user?.roles.includes("admin");

	const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
	const [meta, setMeta] = useState<Meta | null>(null);
	const [data, setData] = useState<Overview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fatal, setFatal] = useState(false);
	const [loading, setLoading] = useState(true);

	const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
		setFilters((f) => ({ ...f, [key]: value }));

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [m, o] = await Promise.all([fetchMeta(), fetchOverview(filters)]);
			setMeta(m);
			setData(o);
			setFatal(false);
		} catch (e) {
			// Switched off, or not yours: both are settled answers, so the page
			// says so once instead of offering a retry that will fail the same way.
			setFatal(e instanceof DashboardDisabled || e instanceof DashboardForbidden);
			setError(e instanceof Error ? e.message : "Something went wrong.");
			setData(null);
		} finally {
			setLoading(false);
		}
	}, [filters]);

	useEffect(() => {
		if (isAdmin) load();
	}, [isAdmin, load]);

	if (!isAdmin) {
		return (
			<div className="set-group">
				<h2 className="set-heading">Usage</h2>
				<p className="set-sub">You need an admin account to see this.</p>
			</div>
		);
	}

	const totals = data?.totals;
	const previous = data?.previous;

	// The country currently drilled into, if it's in the response. Read from the
	// data rather than kept in its own state, so the heading can never name a
	// country the figures below it aren't actually about.
	const selectedCountry = filters.country
		? data?.by_country.find((c) => c.country_code === filters.country)
		: undefined;

	const countryBars: Bar[] = (data?.by_country ?? [])
		.slice(0, COUNTRIES_SHOWN)
		.map((c) => ({
			label: c.country_name,
			value: c.sessions,
			note: `${count(c.people)} ${c.people === 1 ? "person" : "people"}`,
			title: `${c.country_name}: ${count(c.sessions)} visits by ${count(c.people)} people`,
		}));

	const cityBars: Bar[] = (data?.by_city ?? []).map((c) => ({
		label: [c.city, c.region].filter(Boolean).join(", "),
		value: c.sessions,
		note: `${count(c.people)} ${c.people === 1 ? "person" : "people"}`,
	}));

	// Time is reported per route, and a route is how a feature is reached — so
	// this is "where the time goes", which is the question actually being asked.
	const timeBars: Bar[] = (data?.time_by_route ?? []).map((r) => ({
		label: r.route,
		value: r.total_ms,
		display: duration(r.total_ms),
		note: `${count(r.views)} ${r.views === 1 ? "visit" : "visits"} · ${duration(r.avg_ms)} avg`,
		title: `${r.route}: ${duration(r.total_ms)} across ${count(r.views)} visits by ${count(r.people)} people`,
	}));

	const actionBars: Bar[] = (data?.top_actions ?? []).map((a) => ({
		label: eventLabel(a.name),
		value: a.count,
		note: `${titleCase(eventArea(a.name))} · ${count(a.people)} ${a.people === 1 ? "person" : "people"}`,
		title: `${a.name} — ${count(a.count)} times by ${count(a.people)} people`,
	}));

	// The least-used list has to be built against the full vocabulary, not
	// against the response: a feature nobody touched has no row in top_actions
	// at all, and those zeroes are the most interesting rows on the page.
	const counted = new Map((data?.top_actions ?? []).map((a) => [a.name, a]));
	const leastBars: Bar[] = data
		? (meta?.action_names ?? [])
			.map((name) => ({ name, hit: counted.get(name) }))
			.sort((a, b) => (a.hit?.count ?? 0) - (b.hit?.count ?? 0))
			.slice(0, LEAST_USED_SHOWN)
			.map(({ name, hit }) => ({
				label: eventLabel(name),
				value: hit?.count ?? 0,
				note: hit
					? `${titleCase(eventArea(name))} · ${count(hit.people)} ${hit.people === 1 ? "person" : "people"}`
					: `${titleCase(eventArea(name))} · nobody`,
				title: hit
					? `${name} — ${count(hit.count)} times by ${count(hit.people)} people`
					: `${name} — not used once in this range`,
			}))
		: [];

	const planBars: Bar[] = (data?.by_plan ?? []).map((p) => ({
		label: titleCase(p.plan),
		value: p.events,
		note: `${count(p.people)} ${p.people === 1 ? "person" : "people"}`,
	}));

	const typeBars: Bar[] = (data?.by_account_type ?? []).map((t) => ({
		label: titleCase(t.account_type),
		value: t.events,
		note: `${count(t.people)} ${t.people === 1 ? "person" : "people"}`,
	}));

	const filtered = filters.plan || filters.accountType || filters.audience !== "all"
		|| filters.country;

	return (
		<div className="dash">
			<div className="set-group">
				<h2 className="set-heading">Usage</h2>
				<p className="set-sub">
					Who comes to BodyMaps, where from, and what they do once they're here.
					Visible to admins only.
				</p>
			</div>

			{/* Filters sit in one row above everything they affect. */}
			<div className="dash-filters">
				<label className="dash-field">
					<span className="dash-field-label">From</span>
					<input
						type="date" className="set-input dash-input"
						value={filters.from} max={filters.to} disabled={filters.allTime}
						onChange={(e) => set("from", e.target.value)}
					/>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">To</span>
					<input
						type="date" className="set-input dash-input"
						value={filters.to} min={filters.from} max={dateInput(0)}
						disabled={filters.allTime}
						onChange={(e) => set("to", e.target.value)}
					/>
				</label>
				<div className="dash-field">
					<span className="dash-field-label">Range</span>
					<div className="set-segmented dash-segmented">
						{([false, true] as const).map((all) => (
							<button
								key={String(all)}
								type="button"
								className={`set-segmented-btn${filters.allTime === all ? " set-segmented-btn--on" : ""}`}
								aria-pressed={filters.allTime === all}
								onClick={() => set("allTime", all)}
							>
								{all ? "All time" : "These dates"}
							</button>
						))}
					</div>
				</div>
				<label className="dash-field">
					<span className="dash-field-label">Plan</span>
					<select
						className="set-select dash-input" value={filters.plan}
						onChange={(e) => set("plan", e.target.value)}
					>
						<option value="">All plans</option>
						{(meta?.plans ?? []).map((p) => (
							<option key={p} value={p}>{titleCase(p)}</option>
						))}
					</select>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">Account type</span>
					<select
						className="set-select dash-input" value={filters.accountType}
						onChange={(e) => set("accountType", e.target.value)}
					>
						<option value="">All types</option>
						{(meta?.account_types ?? []).map((t) => (
							<option key={t} value={t}>{titleCase(t)}</option>
						))}
					</select>
				</label>
				<label className="dash-field">
					<span className="dash-field-label">Audience</span>
					<select
						className="set-select dash-input" value={filters.audience}
						onChange={(e) => set("audience", e.target.value as Audience)}
					>
						{(meta?.audiences ?? (["all", "signed_in", "anonymous"] as Audience[])).map((a) => (
							<option key={a} value={a}>{AUDIENCE_LABELS[a] ?? a}</option>
						))}
					</select>
				</label>
				{filtered && (
					<button
						type="button" className="set-btn dash-reset"
						onClick={() => setFilters((f) => ({
							...f, plan: "", accountType: "", audience: "all", country: "",
						}))}
					>
						Clear filters
					</button>
				)}
			</div>

			{error && (
				<div className="set-banner set-banner--error dash-banner">
					{error}{" "}
					{!fatal && (
						<button type="button" className="dash-retry" onClick={load}>Try again</button>
					)}
				</div>
			)}

			{loading && !data && !error && <p className="dash-empty">Loading…</p>}

			{data && (
				<>
					{/* A country picked on the map filters everything below, so it
					    is said once here rather than repeated on every panel. */}
					{selectedCountry && (
						<div className="dash-scope">
							Showing <strong>{selectedCountry.country_name}</strong> only.{" "}
							<button
								type="button" className="dash-retry"
								onClick={() => set("country", "")}
							>
								Show the whole world
							</button>
						</div>
					)}

					<div className="dash-tiles">
						<Tile
							label="Visits"
							value={count(totals!.sessions)}
							change={delta(totals!.sessions, previous!.sessions)}
						/>
						<Tile
							label="People"
							value={count(totals!.people)}
							note={`${count(totals!.signed_in_people)} signed in`}
							change={delta(totals!.people, previous!.people)}
						/>
						<Tile
							label="Events"
							value={count(totals!.events)}
							change={delta(totals!.events, previous!.events)}
						/>
						<Tile label="Time in app" value={duration(totals!.time_ms)} />
					</div>

					<section className="dash-panel">
						<h2 className="set-heading">Activity</h2>
						<p className="set-sub">Events per day across the selected range.</p>
						<TrendLine points={data.daily} />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Where visitors are</h2>
						<p className="set-sub">
							Worked out from each visitor's IP address on our own server.
							Accurate to a city at best, and a VPN reports wherever it exits.
							Click a country to see only its traffic.
						</p>
						<div className="dash-map-row">
							<WorldMap
								rows={data.by_country}
								selected={filters.country}
								onSelect={(code) => set("country", code)}
							/>
							<div className="dash-map-side">
								<h3 className="dash-subheading">
									{selectedCountry ? `Cities in ${selectedCountry.country_name}` : "Top countries"}
								</h3>
								<BarList
									bars={selectedCountry ? cityBars : countryBars}
									empty={
										selectedCountry
											? "No city could be resolved for this country."
											: "No locations recorded in this range."
									}
								/>
							</div>
						</div>
					</section>

					<div className="dash-split">
						<section className="dash-panel">
							<h2 className="set-heading">Device</h2>
							<p className="set-sub">
								Counted per visit, from the browser's user agent.
							</p>
							<Donut
								slices={data.by_device.map((d) => ({
									label: DEVICE_LABELS[d.device_type] ?? titleCase(d.device_type),
									value: d.sessions,
								}))}
								empty="No device recorded in this range."
							/>
						</section>

						<section className="dash-panel">
							<h2 className="set-heading">New vs returning</h2>
							<p className="set-sub">
								"Returning" means this browser was seen here before the range
								began — a cleared cookie starts someone over as new.
							</p>
							<Donut
								slices={[
									{ label: "Returning", value: data.new_vs_returning.returning },
									{ label: "New", value: data.new_vs_returning.new },
								]}
								empty="Nobody visited in this range."
							/>
						</section>
					</div>

					<section className="dash-panel">
						<h2 className="set-heading">When people visit</h2>
						<p className="set-sub">Visits by day of the week, or by hour.</p>
						<TimeBars weekday={data.by_weekday} hour={data.by_hour} />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Most-used features</h2>
						<p className="set-sub">
							Counted per event, with the number of distinct people beside it —
							one person clicking forty times is not forty people.
						</p>
						<BarList bars={actionBars} empty="No actions recorded in this range." />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Least-used features</h2>
						<p className="set-sub">
							The quietest {LEAST_USED_SHOWN} tracked actions. "Nobody" means not
							once in this range — either it's hard to find, or it isn't wanted.
						</p>
						<BarList bars={leastBars} empty="Nothing is tracked yet." />
					</section>

					<section className="dash-panel">
						<h2 className="set-heading">Where the time goes</h2>
						<p className="set-sub">
							Total time on each route, counted only while the tab was in front.
						</p>
						<BarList bars={timeBars} empty="No page views recorded in this range." />
					</section>

					<div className="dash-split">
						<section className="dash-panel">
							<h2 className="set-heading">By plan</h2>
							<p className="set-sub">
								The plan each person was on when the event was recorded.
							</p>
							<BarList bars={planBars} />
						</section>

						<section className="dash-panel">
							<h2 className="set-heading">By account type</h2>
							<p className="set-sub">
								Self-reported. "Not set" is a signed-in user who never chose one.
							</p>
							<BarList bars={typeBars} />
						</section>
					</div>
				</>
			)}
		</div>
	);
};

const Tile: React.FC<{
	label: string;
	value: string;
	note?: string;
	/** Against the previous period of the same length. Null when there is
	 *  nothing honest to say — see format.delta. */
	change?: ReturnType<typeof delta>;
}> = ({ label, value, note, change }) => (
	<div className="dash-tile">
		<span className="dash-tile-label">{label}</span>
		<span className="dash-tile-value">{value}</span>
		{change && (
			<span
				className={`dash-delta${change.up ? " dash-delta--up" : " dash-delta--down"}`}
				title="Compared with the previous period of the same length"
			>
				{change.up ? "▲" : "▼"} {change.label}
			</span>
		)}
		{note && <span className="dash-tile-note">{note}</span>}
	</div>
);

export default AnalyticsSettings;
