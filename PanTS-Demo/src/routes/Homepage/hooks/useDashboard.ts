import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  buildSearchParams,
  type CaseId,
  caseIdToApiId,
  countActiveFilters,
  EMPTY_FILTERS,
  itemToId,
  type MultiFilterKey,
  parseFiltersFromParams,
  type SearchFilters as Filters,
  type SearchItem,
} from "../../../helpers/search";
import { prefetchViewer } from "../../../helpers/prefetchViewer";
import { fetchCurated, getCachedCurated } from "../../../helpers/curatedCache";
import {
  loadSavedCases,
  SAVED_CASES_EVENT,
  type SavedCase,
  toggleSavedCase,
} from "../../../helpers/savedCases";
import type { PreviewType } from "../../../types";
import { API_BASE } from "../../../helpers/constants";
import { CARD_COUNT, PER_PAGE } from "../constants";
import type { FacetData } from "../types";
import { track } from "../../../helpers/analytics";

// Pure so it can seed both the lazy initial state (skips the first-paint skeleton
// entirely when the curated cache is already warm) and the post-fetch ingest path.
function toPreviewData(items: SearchItem[]) {
  const ids: CaseId[] = [];
  const meta: { [key: string]: PreviewType } = {};
  for (const it of items) {
    const id = itemToId(it);
    if (!id) continue;
    ids.push(id);
    meta[id] = {
      sex: it.sex ?? "",
      age: Number(it.age) || 0,
      tumor: it.tumor === 1 ? 1 : it.tumor === 0 ? 0 : null,
    };
  }
  return { ids, meta };
}

export function useDashboard() {
  const navigation = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => parseFiltersFromParams(searchParams));
  // Only the curated (no-filter) view is cacheable; a filtered/deep-linked URL
  // always does a live fetch, same as before. `filters` was just initialized from
  // the same searchParams, so reuse it instead of re-parsing.
  const initialCached = countActiveFilters(filters) === 0 ? getCachedCurated() : null;
  const initialData = initialCached ? toPreviewData(initialCached) : null;
  const [previewIds, setPreviewIds] = useState<CaseId[]>(initialData?.ids ?? []);
  const [previewMetadata, setPreviewMetadata] = useState<{ [key: string]: PreviewType }>(
    initialData?.meta ?? {},
  );
  const [loading, setLoading] = useState(!initialData);
  const [searchId, setSearchId] = useState<number>(0);
  const [showFilters, setShowFilters] = useState(false);
  const [facetData, setFacetData] = useState<FacetData | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [recentShuffleIds, setRecentShuffleIds] = useState<CaseId[]>([]);

  const [savedCases, setSavedCases] = useState<SavedCase[]>(loadSavedCases);
  const [showSaved, setShowSaved] = useState(false);
  const savedIds = new Set(savedCases.map((c) => c.id));

  // Keep in sync when a bookmark is toggled here or in another tab.
  useEffect(() => {
    const refresh = () => setSavedCases(loadSavedCases());
    window.addEventListener(SAVED_CASES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SAVED_CASES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleToggleSave = (id: CaseId, meta?: PreviewType) => {
    const m = meta ?? previewMetadata[id];
    toggleSavedCase({ id, sex: m?.sex ?? "", age: m?.age ?? 0, tumor: m?.tumor ?? null });
  };

  // Cases picked for side-by-side comparison (max 2). Adding a third drops the oldest.
  const [compareIds, setCompareIds] = useState<CaseId[]>([]);
  const [compareTyped, setCompareTyped] = useState("");

  const toggleCompare = (id: CaseId) => {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2),
    );
  };

  const addCompareId = (id: CaseId) => {
    setCompareIds((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-2)));
  };

  const submitTypedCompare = () => {
    const raw = compareTyped.trim();
    if (raw.toUpperCase().startsWith("CV")) {
      addCompareId(raw);
    } else {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) addCompareId(n);
    }
    setCompareTyped("");
  };

  const handleClearCompare = () => setCompareIds([]);

  const ingestItems = (items: SearchItem[]) => {
    const { ids, meta } = toPreviewData(items);
    setPreviewMetadata(meta);
    setPreviewIds(ids);
    setLoading(false);
    return ids;
  };

  // Curated cases: fullest-body scans split half tumor / half no-tumor, interleaved.
  // Reads the shared module-scope cache first: if the app-boot idle warm-up (or an
  // earlier mount) already resolved it, this renders synchronously from memory with
  // no spinner and no network round trip -- the fix for Team/Overview -> Dataset
  // tab switches paying a full refetch every time despite the data being static.
  const loadCurated = async () => {
    const cached = getCachedCurated();
    if (cached) {
      ingestItems(cached);
      return;
    }
    setLoading(true);
    setPreviewMetadata({});
    try {
      ingestItems(await fetchCurated());
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const runSearch = async (f: Filters, p = 1) => {
    setLoading(true);
    setPreviewMetadata({});
    try {
      const params = buildSearchParams(f, { sortBy: "quality", perPage: PER_PAGE });
      params.set("page", String(p));
      const res = await fetch(`${API_BASE}/api/search?${params.toString()}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      setResultCount(data.total ?? 0);
      setPage(data.page ?? p);
      ingestItems(data.items ?? []);
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const goToPage = (p: number) => {
    const pages = resultCount ? Math.max(1, Math.ceil(resultCount / PER_PAGE)) : 1;
    const next = Math.min(Math.max(1, p), pages);
    runSearch(filters, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Facet option lists + baseline counts — fetched once, unfiltered, so available
  // pills and their counts stay stable regardless of which filter is active.
  const loadFacetOptions = async () => {
    try {
      const params = new URLSearchParams();
      params.set("fields", "tumor,sex,manufacturer,ct_phase,site_nat,year");
      params.set("top_k", "8");
      const res = await fetch(`${API_BASE}/api/facets?${params.toString()}`);
      const data = await res.json();
      setFacetData({
        counts: data.facets ?? {},
        unknown: data.unknown_counts ?? {},
        total: data.total ?? 0,
        datasetCounts: data.dataset_counts ?? {},
      });
    } catch (e) {
      console.error(e);
    }
  };

  // On mount: restore URL filters if present, otherwise show curated grid.
  useEffect(() => {
    const urlFilters = parseFiltersFromParams(searchParams);
    if (countActiveFilters(urlFilters) > 0) {
      setShowFilters(true);
      runSearch(urlFilters);
    } else {
      loadCurated();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch static option lists the first time the filter panel opens.
  useEffect(() => {
    if (showFilters && !facetData) loadFacetOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFilters]);

  // Warm the code-split viewer chunk while idle so the first case-open is instant.
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback;
    const id = ric ? ric(() => prefetchViewer()) : window.setTimeout(prefetchViewer, 1500);
    return () => {
      if (ric) w.cancelIdleCallback?.(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  const handleShuffle = async () => {
    setLoading(true);
    setPreviewMetadata({});
    setResultCount(null);
    setPage(1);
    setFilters(EMPTY_FILTERS);
    setSearchParams({});
    try {
      const params = new URLSearchParams({
        n: String(CARD_COUNT),
        k: "120",
        scope: "all",
      });
      if (recentShuffleIds.length) {
        params.set("recent", recentShuffleIds.map(caseIdToApiId).join(","));
      }
      const res = await fetch(`${API_BASE}/api/random?${params.toString()}`);
      if (!res.ok) throw new Error(`Shuffle failed (${res.status})`);
      const data = await res.json();
      const ids = ingestItems(data.items ?? []);
      setRecentShuffleIds((previous) => {
        const deduped: CaseId[] = [];
        for (const id of [...previous, ...ids]) {
          const existing = deduped.findIndex((candidate) => candidate === id);
          if (existing >= 0) deduped.splice(existing, 1);
          deduped.push(id);
        }
        return deduped.slice(-32);
      });
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const handleBrowseAll = () => {
    setFilters(EMPTY_FILTERS);
    setSearchParams({});
    runSearch(EMPTY_FILTERS, 1);
  };

  const activeFilterCount = countActiveFilters(filters);

  const toggleMulti = (key: MultiFilterKey, value: string) => {
    setFilters((f) => {
      const has = f[key].includes(value);
      return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
    });
  };

  const handleApplyFilters = () => {
    setSearchParams(buildSearchParams(filters));
    runSearch(filters, 1);
    setShowFilters(false);
  };

  const handleResetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setResultCount(null);
    setPage(1);
    setSearchParams({});
    loadCurated();
  };

  const handleSearch = () => {
    track("dataset_search");
    if (searchId) {
      const clamped = Math.max(1, Math.min(9901, searchId));
      navigation("/case/" + clamped);
      return;
    }
    handleApplyFilters();
  };

  const handleCompare = () => {
    track("dataset_open_compare");
    navigation(`/compare?a=${compareIds[0]}&b=${compareIds[1]}`);
  };

  return {
    previewIds,
    previewMetadata,
    loading,
    searchId,
    setSearchId,
    showFilters,
    setShowFilters,
    filters,
    setFilters,
    facetData,
    activeFilterCount,
    page,
    pageInput,
    setPageInput,
    resultCount,
    savedCases,
    showSaved,
    setShowSaved,
    savedIds,
    compareIds,
    compareTyped,
    setCompareTyped,
    handleToggleSave,
    toggleCompare,
    submitTypedCompare,
    handleClearCompare,
    handleShuffle,
    handleBrowseAll,
    handleResetFilters,
    handleSearch,
    handleCompare,
    goToPage,
    toggleMulti,
  };
}
