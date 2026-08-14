import { useEffect, useRef, useState } from "react";

/**
 * Keep a node mounted through its exit animation.
 * `present` is true while open or while closing; `visible` drives the open CSS state.
 */
export function usePresence(
  open: boolean,
  exitMs = 220,
): { present: boolean; visible: boolean } {
  const [present, setPresent] = useState(open);
  const [visible, setVisible] = useState(open);
  const presentRef = useRef(present);
  presentRef.current = present;

  useEffect(() => {
    if (open) {
      setPresent(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }

    setVisible(false);
    if (!presentRef.current) return;

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = reduced ? 0 : exitMs;
    const timer = window.setTimeout(() => setPresent(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  return { present: open || present, visible };
}
