import styles from "./FactRail.module.css";

export function FactRail() {
  return (
    <section className={styles.factRail} aria-labelledby="principles-title">
      <div className={styles.factInner}>
        <h2 id="principles-title">
          Local when it runs. Explicit when it changes.
        </h2>

        <div className={styles.facts}>
          <article>
            <strong>Local workspace</strong>
            <p>Tools and Git run against the project you choose.</p>
          </article>
          <article>
            <strong>Ask mode</strong>
            <p>Mutation waits for a clear approval.</p>
          </article>
          <article>
            <strong>Provider choice</strong>
            <p>Grok and OpenAI stay on distinct paths.</p>
          </article>
        </div>
      </div>
    </section>
  );
}
