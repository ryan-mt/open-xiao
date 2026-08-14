import { Brand } from "../../shared/brand/Brand";
import { CallToAction } from "../../shared/call-to-action/CallToAction";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.siteHeader}>
      <nav className={styles.nav} aria-label="Primary navigation">
        <Brand ariaLabel="Open Xiao home" href="#top" imageSize={28} />

        <div className={styles.navLinks}>
          <a href="#workspace">Workspace</a>
          <a href="#providers">Providers</a>
          <a href="#control">Control</a>
        </div>

        <CallToAction href="#start" showArrow variant="compact">
          Build from source
        </CallToAction>
      </nav>
    </header>
  );
}
