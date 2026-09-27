import type { CaseId } from "../../../../helpers/search";
import styles from "./CompareTray.module.css";

interface Props {
  compareIds: CaseId[];
  compareTyped: string;
  setCompareTyped: (s: string) => void;
  onSubmitTyped: () => void;
  onClear: () => void;
  onCompare: () => void;
}

export default function CompareTray({
  compareIds,
  compareTyped,
  setCompareTyped,
  onSubmitTyped,
  onClear,
  onCompare,
}: Props) {
  return (
    <div className={styles.compareTray}>
      <span className={styles.compareTrayIds}>
        {compareIds.map((id) => `#${id}`).join("  vs  ")}
      </span>
      {compareIds.length < 2 && (
        <form
          className={styles.compareTrayForm}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitTyped();
          }}
        >
          <input
            value={compareTyped}
            onChange={(e) => setCompareTyped(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="type case #"
            inputMode="numeric"
            aria-label="Add a case by number"
            className={styles.compareTrayInput}
          />
          <button
            type="submit"
            disabled={compareTyped.trim() === ""}
            className={styles.compareTrayAddBtn}
          >
            Add
          </button>
        </form>
      )}
      <button onClick={onClear} className={styles.compareTrayBtn}>
        Clear
      </button>
      <button
        disabled={compareIds.length < 2}
        onClick={onCompare}
        className={styles.compareTrayCompareBtn}
      >
        Compare →
      </button>
    </div>
  );
}
