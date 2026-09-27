import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { flush, routePattern, trackPageView } from "../helpers/analytics";

// Turns navigation into "time spent here" numbers. Mounted once, inside the
// router, renders nothing.
//
// Time is only counted while the tab is actually in front. Without that, a tab
// left open overnight would report the viewer as the most-used feature in the
// product by a wide margin, which is true of the tab and false of the person.
const AnalyticsRouteTracker: React.FC = () => {
	const { pathname } = useLocation();
	// Held in refs, not state: this component must never re-render anything.
	const route = useRef<string | null>(null);
	const since = useRef<number>(Date.now());

	useEffect(() => {
		// Close out the previous route before opening the new one.
		const record = () => {
			if (route.current) trackPageView(route.current, Date.now() - since.current);
		};

		record();
		route.current = routePattern(pathname);
		since.current = Date.now();

		return record;
		// Only on a route change: the effect's whole job is the transition.
	}, [pathname]);

	useEffect(() => {
		const onHidden = () => {
			if (document.visibilityState !== "hidden") {
				// Back in front: start a fresh stretch rather than counting the
				// time the tab spent in the background.
				since.current = Date.now();
				return;
			}
			if (route.current) trackPageView(route.current, Date.now() - since.current);
			since.current = Date.now();
			// The tab may not come back — get what we have to the server now.
			flush(true);
		};

		document.addEventListener("visibilitychange", onHidden);
		// pagehide rather than unload: unload doesn't fire on mobile Safari.
		window.addEventListener("pagehide", onHidden);
		return () => {
			document.removeEventListener("visibilitychange", onHidden);
			window.removeEventListener("pagehide", onHidden);
		};
	}, []);

	return null;
};

export default AnalyticsRouteTracker;
