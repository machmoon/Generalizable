import {
  CONTACT_LINK_TEXT,
  CONTACT_URL,
  FOOTER_INQUIRY_LEAD,
  NONCLINICAL_WARNING,
} from "../../helpers/copy";
import styles from "./SiteFooter.module.css";

/**
 * Slim one-line site-wide footer: the nonclinical notice on the left, the
 * inquiry route on the right. The mission line lives in the landing subtitle
 * now, so it is not repeated here. Strings live in helpers/copy.ts.
 */
function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span className={styles.notice}>{NONCLINICAL_WARNING}</span>
      <span className={styles.partner}>
        {FOOTER_INQUIRY_LEAD}{" "}
        <a
          className={styles.link}
          href={CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {CONTACT_LINK_TEXT}
        </a>
        .
      </span>
    </footer>
  );
}

export default SiteFooter;
