import Image from "next/image";
import { MediaFrame } from "../../shared/media-frame/MediaFrame";
import { Section } from "../../shared/section/Section";
import styles from "./ControlSection.module.css";

export function ControlSection() {
  return (
    <Section className={styles.controlSection} id="control">
      <div className={styles.controlHeading}>
        <h2>Nothing mutates by accident.</h2>
        <p>
          Ask mode gates commands, file changes, and delegated tasks at the same
          boundary.
        </p>
      </div>

      <div className={styles.controlBody}>
        <div className={styles.controlNotes}>
          <article>
            <h3>Read freely</h3>
            <p>Inspection can continue while risky tools wait for a decision.</p>
          </article>
          <article>
            <h3>Protect sessions</h3>
            <p>
              Provider sessions live in an encrypted local vault backed by the
              operating system credential store.
            </p>
          </article>
        </div>

        <MediaFrame className={styles.settingsFrame}>
          <Image
            src="/security-settings.png"
            alt="Open Xiao settings with notification and provider account controls"
            width={1264}
            height={625}
            sizes="(max-width: 860px) 94vw, 66vw"
          />
        </MediaFrame>
      </div>
    </Section>
  );
}
