import type { ReactNode } from "react";
import styles from "./MediaFrame.module.css";

type MediaFrameProps = {
  children: ReactNode;
  className?: string;
};

export function MediaFrame({ children, className }: MediaFrameProps) {
  return <div className={`${styles.frame} ${className ?? ""}`}>{children}</div>;
}
