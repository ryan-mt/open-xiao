import { Brand } from "../../shared/brand/Brand";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Brand ariaLabel="Back to the top" href="#top" imageSize={28} />
      <p>Local tools. Visible decisions.</p>
      <nav aria-label="Footer navigation">
        <a href="#workspace">Workspace</a>
        <a href="#providers">Providers</a>
        <a href="#start">Build from source</a>
      </nav>
    </footer>
  );
}
