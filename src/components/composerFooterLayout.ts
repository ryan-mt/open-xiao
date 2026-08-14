export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;

export function shouldUseCompactComposerFooter(
  width: number | null,
): boolean {
  return width !== null && width < COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
}
