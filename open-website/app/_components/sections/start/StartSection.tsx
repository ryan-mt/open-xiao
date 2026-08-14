import { Section } from "../../shared/section/Section";
import styles from "./StartSection.module.css";

export function StartSection() {
  return (
    <Section className={styles.startSection} id="start">
      <div className={styles.startCopy}>
        <h2>Start where the code lives.</h2>
        <p>
          Install the prerequisites, clone the repository, then run the desktop
          client from the project root.
        </p>
        <ul aria-label="Build requirements">
          <li>Node.js 20+</li>
          <li>Stable Rust</li>
          <li>WebView2</li>
          <li>Tauri 2 prerequisites</li>
        </ul>
      </div>

      <div className={styles.codePanel} aria-label="Open Xiao setup commands">
        <div className={styles.codeLabel}>PowerShell</div>
        <pre>
          <code>{`npm install\nnpm run app`}</code>
        </pre>
      </div>
    </Section>
  );
}
