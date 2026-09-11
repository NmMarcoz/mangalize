import { fetchThumbnail } from "@/lib/api";

/**
 * Thumbnail loading, shared across every card on screen.
 *
 * Each card asking for its own thumbnail independently would fire hundreds of
 * concurrent IPC calls and saturate the blocking thread pool on the Rust side,
 * so requests are funnelled through a small concurrency gate. Results are
 * memoised as object URLs because the grid remounts cards constantly while
 * scrolling and filtering.
 */
const LIMIT = 6;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const waiting: (() => void)[] = [];
let active = 0;

const key = (path: string, max: number) => `${max}|${path}`;

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

export function cachedThumbnail(path: string, max: number): string | undefined {
  return cache.get(key(path, max));
}

export function loadThumbnail(path: string, max: number): Promise<string> {
  const k = key(path, max);

  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);

  const pending = inflight.get(k);
  if (pending) return pending;

  const task = (async () => {
    await acquire();
    try {
      const bytes = await fetchThumbnail(path, max);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      cache.set(k, url);
      return url;
    } finally {
      release();
      inflight.delete(k);
    }
  })();

  inflight.set(k, task);
  return task;
}

/** Drop every cached thumbnail. Called when a different folder is opened. */
export function clearThumbnails() {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}
