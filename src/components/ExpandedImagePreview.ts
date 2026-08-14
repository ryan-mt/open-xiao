export type ExpandedImageItem = {
  src: string;
  name: string;
};

export type ExpandedImagePreview = {
  images: ExpandedImageItem[];
  index: number;
};

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; dataUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewable = images.flatMap((image) =>
    image.dataUrl
      ? [{ id: image.id, src: image.dataUrl, name: image.name }]
      : [],
  );
  if (previewable.length === 0) return null;
  const selectedIndex = previewable.findIndex(
    (image) => image.id === selectedImageId,
  );
  if (selectedIndex < 0) return null;
  return {
    images: previewable.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
