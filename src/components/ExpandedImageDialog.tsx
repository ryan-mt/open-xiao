import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

type Props = {
  preview: ExpandedImagePreview;
  onClose: () => void;
};

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: Props) {
  const [offset, setOffset] = useState(0);
  const index =
    (preview.index + offset + preview.images.length) % preview.images.length;

  const navigate = useCallback((direction: -1 | 1) => {
    setOffset((current) => current + direction);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigate(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigate(1);
    };
    // Capture so Escape closes the lightbox before App's window handler can
    // stop the active stream or close panels (see SettingsModal).
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigate, onClose, preview.images.length]);

  const item = preview.images[index];
  if (!item || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button
        type="button"
        className="img-lightbox__backdrop"
        aria-label="Close image preview"
        onClick={onClose}
      />
      {preview.images.length > 1 ? (
        <button
          type="button"
          className="img-lightbox__nav img-lightbox__nav--prev"
          aria-label="Previous image"
          onClick={() => navigate(-1)}
        >
          ‹
        </button>
      ) : null}
      <div className="img-lightbox__frame">
        <button
          type="button"
          className="img-lightbox__close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          ×
        </button>
        <img
          src={item.src}
          alt={item.name}
          className="img-lightbox__img"
          draggable={false}
        />
        <p className="img-lightbox__caption">
          {item.name}
          {preview.images.length > 1
            ? ` (${index + 1}/${preview.images.length})`
            : ""}
        </p>
      </div>
      {preview.images.length > 1 ? (
        <button
          type="button"
          className="img-lightbox__nav img-lightbox__nav--next"
          aria-label="Next image"
          onClick={() => navigate(1)}
        >
          ›
        </button>
      ) : null}
    </div>,
    document.body,
  );
});
