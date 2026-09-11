import { useEffect, useRef, useState } from "react";

import {
  cachedPreview,
  cachedThumbnail,
  loadPreview,
  loadThumbnail,
} from "@/lib/thumbs";

/**
 * Load an image once its card is near the viewport.
 *
 * Returns a ref to attach to the card. Decoding only what is actually scrolled
 * to is what keeps a 500-page volume responsive, and it matters twice over for
 * remote previews, where each one is a network round trip.
 */
function useLazyImage(
  token: string,
  peek: () => string | undefined,
  load: () => Promise<string>,
  /** False when there is nothing to load, e.g. a series with no cover yet. */
  enabled = true,
) {
  const [url, setUrl] = useState<string | undefined>(peek);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // The loaders close over the current arguments, but the effect must only
  // re-run when those arguments actually change — hence the token.
  const latest = useRef({ peek, load });
  latest.current = { peek, load };

  useEffect(() => {
    if (!enabled) {
      setUrl(undefined);
      return;
    }

    const hit = latest.current.peek();
    setUrl(hit);
    setFailed(false);
    if (hit) return;

    const node = ref.current;
    if (!node) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        latest.current
          .load()
          .then((next) => {
            if (!cancelled) setUrl(next);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      // Start fetching a screenful early so scrolling rarely shows a placeholder.
      { rootMargin: "600px 0px" },
    );

    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [token, enabled]);

  return { ref, url, failed };
}

/** A thumbnail of a page on disk. An empty path simply loads nothing. */
export function useThumbnail(path: string, max: number) {
  return useLazyImage(
    `${max}|${path}`,
    () => cachedThumbnail(path, max),
    () => loadThumbnail(path, max),
    path !== "",
  );
}

/** A preview of an image still out on the web, fetched with its page's referer. */
export function usePreview(url: string, referer: string | null, max: number) {
  return useLazyImage(
    `${max}|${referer ?? ""}|${url}`,
    () => cachedPreview(url, referer, max),
    () => loadPreview(url, referer, max),
  );
}
