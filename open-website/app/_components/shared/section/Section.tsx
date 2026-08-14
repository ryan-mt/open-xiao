import type { ReactNode } from "react";
import styles from "./Section.module.css";

type SectionProps = {
  children: ReactNode;
  className?: string;
  id?: string;
};

export function Section({ children, className, id }: SectionProps) {
  return (
    <section className={`${styles.section} ${className ?? ""}`} id={id}>
      {children}
    </section>
  );
}
