/**
 * Shared machinery for loading images through the backend.
 *
 * Every card on screen asking for its own image would fire hundreds of
 * concurrent IPC calls and saturate the blocking thread pool on the Rust side,
 * so requests are funnelled through a small concurrency gate. Results are
 * memoised as object URLs because grids remount cards constantly while
 * scrolling and filtering.
 *
 * Page thumbnails and remote page previews both need exactly this, so the gate
 * lives here and each caller supplies only its own fetch.
 */

/** How many decodes to have in flight at once. */
const LIMIT = 6;

export interface ImageCache {
  /** The cached object URL, if this image has already been loaded. */
  peek(key: string): string | undefined;
  /** Load it, sharing the work if it is already in flight. */
  load(key: string): Promise<string>;
  /** Drop everything. Called when the user moves to a different set of images. */
  clear(): void;
}

/**
 * Build a cache over `fetcher`, which is handed the key and returns raw bytes.
 */
export function createImageCache(
  fetcher: (key: string) => Promise<ArrayBuffer>,
): ImageCache {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  function acquire(): Promise<void> {
    if (active < LIMIT) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  }

  return {
    peek: (key) => cache.get(key),

    load(key) {
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);

      const pending = inflight.get(key);
      if (pending) return pending;

      const task = (async () => {
        await acquire();
        try {
          const bytes = await fetcher(key);
          const url = URL.createObjectURL(
            new Blob([bytes], { type: "image/jpeg" }),
          );
          cache.set(key, url);
          return url;
        } finally {
          release();
          inflight.delete(key);
        }
      })();

      inflight.set(key, task);
      return task;
    },

    clear() {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    },
  };
}
