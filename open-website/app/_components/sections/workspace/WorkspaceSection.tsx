import { Section } from "../../shared/section/Section";
import styles from "./WorkspaceSection.module.css";

export function WorkspaceSection() {
  return (
    <Section className={styles.workspaceSection} id="workspace">
      <div className={styles.workspaceIntro}>
        <p className={styles.eyebrow}>One working surface</p>
        <h2>The work never disappears behind the agent.</h2>
        <p className={styles.workspaceLead}>
          Context, tool activity, plans, and code changes remain close enough to
          inspect while the task moves.
        </p>
      </div>

      <div className={styles.workspaceMap}>
        <article className={styles.primaryCapability}>
          <p>Project context</p>
          <h3>Every thread belongs to the workspace where the work happens.</h3>
        </article>

        <div className={styles.capabilityList}>
          <article>
            <h3>Native project tools</h3>
            <p>Read files and run commands without losing the conversation.</p>
          </article>
          <article>
            <h3>Git workspaces</h3>
            <p>Use worktrees to isolate agent work from the active checkout.</p>
          </article>
          <article>
            <h3>Plan and review</h3>
            <p>Keep intent, progress, and the final diff within reach.</p>
          </article>
        </div>
      </div>
    </Section>
  );
}
