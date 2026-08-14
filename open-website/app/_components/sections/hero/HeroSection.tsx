import Image from "next/image";
import { CallToAction } from "../../shared/call-to-action/CallToAction";
import styles from "./HeroSection.module.css";

export function HeroSection() {
  return (
    <section className={styles.hero} id="top">
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <h1>
            <span>Run agents.</span>
            <span>Stay in command.</span>
          </h1>
          <p className={styles.heroLead}>
            Open Xiao brings models, project tools, Git, and review into one
            local Windows workspace.
          </p>
          <div className={styles.heroActions}>
            <CallToAction href="#workspace" showArrow variant="primary">
              See Open Xiao
            </CallToAction>
            <CallToAction href="#start" variant="secondary">
              Build from source
            </CallToAction>
          </div>
        </div>

        <figure className={styles.heroStage}>
          <Image
            src="/xiao-workspace.png"
            alt="Open Xiao desktop workspace with project navigation and agent controls"
            width={1264}
            height={625}
            sizes="(max-width: 900px) 94vw, 62vw"
            preload
          />
        </figure>
      </div>
    </section>
  );
}
