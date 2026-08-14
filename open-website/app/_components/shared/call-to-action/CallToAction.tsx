import type { ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import styles from "./CallToAction.module.css";

type CallToActionProps = {
  children: ReactNode;
  href: string;
  showArrow?: boolean;
  variant: "compact" | "primary" | "secondary";
};

export function CallToAction({
  children,
  href,
  showArrow = false,
  variant,
}: CallToActionProps) {
  return (
    <a className={`${styles.base} ${styles[variant]}`} href={href}>
      {children}
      {showArrow ? (
        <ArrowRight size={variant === "compact" ? 16 : 18} weight="bold" aria-hidden="true" />
      ) : null}
    </a>
  );
}
