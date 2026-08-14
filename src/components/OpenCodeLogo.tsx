type Props = {
  size?: number;
  className?: string;
};

/** Official OpenCode mark from the OpenCode brand assets. */
export function OpenCodeLogo({ size = 16, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 40"
      fill="none"
      aria-hidden
      className={className}
    >
      <path className="opencode-logo__inner" d="M24 32H8V16H24V32Z" />
      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="currentColor" />
    </svg>
  );
}
