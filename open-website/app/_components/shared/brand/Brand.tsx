import Image from "next/image";
import styles from "./Brand.module.css";

type BrandProps = {
  ariaLabel: string;
  href: string;
  imageSize: number;
};

export function Brand({ ariaLabel, href, imageSize }: BrandProps) {
  return (
    <a className={styles.brand} href={href} aria-label={ariaLabel}>
      <Image
        src="/xiao-mark-96.webp"
        alt=""
        width={imageSize}
        height={imageSize}
      />
      <span>
        Open <strong>Xiao</strong>
      </span>
    </a>
  );
}
