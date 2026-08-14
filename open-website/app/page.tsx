import { SiteFooter } from "./_components/chrome/site-footer/SiteFooter";
import { SiteHeader } from "./_components/chrome/site-header/SiteHeader";
import { ControlSection } from "./_components/sections/control/ControlSection";
import { FactRail } from "./_components/sections/fact-rail/FactRail";
import { FlowSection } from "./_components/sections/flow/FlowSection";
import { HeroSection } from "./_components/sections/hero/HeroSection";
import { ProvidersSection } from "./_components/sections/providers/ProvidersSection";
import { StartSection } from "./_components/sections/start/StartSection";
import { WorkspaceSection } from "./_components/sections/workspace/WorkspaceSection";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>

      <SiteHeader />

      <main id="main">
        <HeroSection />
        <FactRail />
        <WorkspaceSection />
        <ProvidersSection />
        <ControlSection />
        <FlowSection />
        <StartSection />
      </main>

      <SiteFooter />
    </div>
  );
}
