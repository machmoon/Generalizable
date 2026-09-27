import Header from "../../components/Header";
import { useDashboard } from "./hooks/useDashboard";
import LibraryHeader from "./components/LibraryHeader";
import SearchBar from "./components/SearchBar";
import FilterPanel from "./components/FilterPanel";
import ResultsSummary from "./components/ResultsSummary";
import CaseGrid from "./components/CaseGrid";
import Pagination from "./components/Pagination";
import CompareTray from "./components/CompareTray";
import SiteFooter from "../../components/SiteFooter";
import styles from "./Homepage.module.css";
import { PER_PAGE } from "./constants";

export default function Homepage() {
  const dash = useDashboard();

  return (
    <div className="min-h-screen bg-white text-black relative overflow-x-hidden flex flex-col">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className={styles.orb1} />
        <div className={styles.orb2} />
        <div className={styles.orb3} />
      </div>

      <Header />

      <section className="mx-auto w-full max-w-6xl flex-1 px-6 pt-8 pb-16">
        <div className={styles.libraryCard}>
          <LibraryHeader
            showSaved={dash.showSaved}
            setShowSaved={dash.setShowSaved}
            savedCases={dash.savedCases}
            onBrowseAll={dash.handleBrowseAll}
            onShuffle={dash.handleShuffle}
          />

          <SearchBar
            searchId={dash.searchId}
            setSearchId={dash.setSearchId}
            showFilters={dash.showFilters}
            setShowFilters={dash.setShowFilters}
            activeFilterCount={dash.activeFilterCount}
            onSearch={dash.handleSearch}
          />

          {dash.showFilters && (
            <FilterPanel
              filters={dash.filters}
              setFilters={dash.setFilters}
              facetData={dash.facetData}
              toggleMulti={dash.toggleMulti}
            />
          )}

        </div>

        {!dash.showSaved && dash.resultCount !== null && (
          <ResultsSummary
            resultCount={dash.resultCount}
            page={dash.page}
            onReset={dash.handleResetFilters}
          />
        )}

        <CaseGrid
          showSaved={dash.showSaved}
          savedCases={dash.savedCases}
          loading={dash.loading}
          resultCount={dash.resultCount}
          previewIds={dash.previewIds}
          previewMetadata={dash.previewMetadata}
          savedIds={dash.savedIds}
          compareIds={dash.compareIds}
          onToggleSave={dash.handleToggleSave}
          onToggleCompare={dash.toggleCompare}
        />

        {!dash.showSaved && dash.resultCount !== null && dash.resultCount > PER_PAGE && (
          <Pagination
            page={dash.page}
            resultCount={dash.resultCount}
            pageInput={dash.pageInput}
            setPageInput={dash.setPageInput}
            onGoToPage={dash.goToPage}
          />
        )}
      </section>

      {dash.compareIds.length > 0 && (
        <CompareTray
          compareIds={dash.compareIds}
          compareTyped={dash.compareTyped}
          setCompareTyped={dash.setCompareTyped}
          onSubmitTyped={dash.submitTypedCompare}
          onClear={dash.handleClearCompare}
          onCompare={dash.handleCompare}
        />
      )}
      <SiteFooter />
    </div>
  );
}
