import Image from "next/image";
import { Section } from "../../shared/section/Section";
import styles from "./FlowSection.module.css";

export function FlowSection() {
  return (
    <Section className={styles.flowSection}>
      <div className={styles.flowHeading}>
        <p className={styles.eyebrow}>From prompt to diff</p>
        <h2>A work loop you can inspect.</h2>
      </div>

      <figure className={styles.flowVisual}>
        <Image
          src="/control-planes.webp"
          alt="Four smoked acrylic planes coordinated through one local control point"
          width={1717}
          height={916}
          sizes="(max-width: 620px) 94vw, 86vw"
        />
        <figcaption>One control point keeps every handoff visible.</figcaption>
      </figure>

      <ol className={styles.flowList}>
        <li>
          <h3>Open a project</h3>
          <p>Start inside the workspace that owns the task.</p>
        </li>
        <li>
          <h3>Choose the route</h3>
          <p>Select a provider, model, and permission mode.</p>
        </li>
        <li>
          <h3>Work in context</h3>
          <p>Keep messages and tool activity together.</p>
        </li>
        <li>
          <h3>Review the result</h3>
          <p>Inspect the plan and changes before moving on.</p>
        </li>
      </ol>
    </Section>
  );
}
