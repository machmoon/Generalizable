import { IconX } from "@tabler/icons-react";
import { PER_PAGE } from "../../constants";
import styles from "./ResultsSummary.module.css";

interface Props {
  resultCount: number;
  page: number;
  onReset: () => void;
}

export default function ResultsSummary({ resultCount, page, onReset }: Props) {
  const pages = Math.max(1, Math.ceil(resultCount / PER_PAGE));
  return (
    <div className={styles.resultsSummary}>
      <span className={styles.resultsText}>
        {resultCount === 0
          ? "No cases match these filters"
          : `${resultCount.toLocaleString()} ${
              resultCount === 1 ? "result" : "results"
            } · page ${page} of ${pages.toLocaleString()}`}
      </span>
      <button onClick={onReset} className={styles.clearBtn}>
        <IconX size={13} />
        Clear filters
      </button>
    </div>
  );
}
