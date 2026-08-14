import { APP_BASE_NAME, APP_BRAND_LOGO_SRC } from "../branding";

type Props = {
  size?: number;
  className?: string;
  title?: string;
};

export function AppLogo({
  size = 24,
  className,
  title = APP_BASE_NAME,
}: Props) {
  return (
    <img
      src={APP_BRAND_LOGO_SRC}
      width={size}
      height={size}
      alt={title}
      className={className}
      draggable={false}
      style={{ borderRadius: Math.round(size * 0.22) }}
    />
  );
}
