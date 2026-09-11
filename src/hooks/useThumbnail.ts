import { useEffect, useRef, useState } from "react";

import { cachedThumbnail, loadThumbnail } from "@/lib/thumbs";

/**
 * Load a page thumbnail once its card is near the viewport.
 *
 * Returns a ref to attach to the card. Decoding only what is actually scrolled
 * to is what keeps a 500-page volume responsive.
 */
export function useThumbnail(path: string, max: number) {
  const [url, setUrl] = useState<string | undefined>(() =>
    cachedThumbnail(path, max),
  );
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const hit = cachedThumbnail(path, max);
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
        loadThumbnail(path, max)
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
  }, [path, max]);

  return { ref, url, failed };
}
