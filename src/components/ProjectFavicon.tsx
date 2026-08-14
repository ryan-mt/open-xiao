import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { getProjectFavicon } from "../auth";

const faviconCache = new Map<string, string | null>();
const faviconRequests = new Map<string, Promise<string | null>>();

function loadProjectFavicon(path: string): Promise<string | null> {
  if (faviconCache.has(path)) return Promise.resolve(faviconCache.get(path) ?? null);
  const pending = faviconRequests.get(path);
  if (pending) return pending;
  const request = getProjectFavicon(path).then((value) => {
    faviconCache.set(path, value);
    faviconRequests.delete(path);
    return value;
  });
  faviconRequests.set(path, request);
  return request;
}

export function ProjectFavicon({
  path,
  size = 14,
  className,
}: {
  path: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(() =>
    path ? (faviconCache.get(path) ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    if (!path) {
      setSrc(null);
      return () => {
        live = false;
      };
    }
    setSrc(faviconCache.get(path) ?? null);
    void loadProjectFavicon(path).then((value) => {
      if (live) setSrc(value);
    });
    return () => {
      live = false;
    };
  }, [path]);

  if (!src || failed) {
    return (
      <Folder
        className={className}
        width={size}
        height={size}
        strokeWidth={1.65}
        aria-hidden
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      className={className}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
