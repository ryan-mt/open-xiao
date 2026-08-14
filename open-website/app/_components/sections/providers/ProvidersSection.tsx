import Image from "next/image";
import { MediaFrame } from "../../shared/media-frame/MediaFrame";
import { Section } from "../../shared/section/Section";
import styles from "./ProvidersSection.module.css";

export function ProvidersSection() {
  return (
    <Section className={styles.providerSection} id="providers">
      <div className={styles.providerHeading}>
        <h2>Choose the model without hiding the route.</h2>
        <p>
          Separate catalogs and sign-in paths make the provider behind each
          request obvious.
        </p>
      </div>

      <div className={styles.providerShowcase}>
        <article className={styles.providerNote}>
          <h3>Grok</h3>
          <p>Sign in with SuperGrok and choose from the xAI catalog.</p>
        </article>

        <MediaFrame className={styles.providerFrame}>
          <Image
            src="/provider-catalog.png"
            alt="Open Xiao model picker with separate Grok and OpenAI catalogs"
            width={1264}
            height={625}
            sizes="(max-width: 860px) 94vw, 58vw"
          />
        </MediaFrame>

        <article className={styles.providerNote}>
          <h3>OpenAI</h3>
          <p>Use ChatGPT OAuth and call the Responses API directly.</p>
        </article>
      </div>
    </Section>
  );
}
