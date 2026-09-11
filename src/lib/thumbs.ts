import { fetchThumbnail } from "@/lib/api";
import { createImageCache } from "@/lib/imagecache";
import { previewImage } from "@/lib/library";

/**
 * Thumbnails of files on disk, and previews of images still out on the web.
 *
 * Both go through the same concurrency gate — see `imagecache.ts` for why — and
 * differ only in how the bytes are obtained. Local thumbnails are keyed by
 * `width|path`; remote previews by `width|referer|url`, because the same image
 * fetched without its page's `Referer` is frequently a 403 rather than a page.
 */

const local = createImageCache((key) => {
  const [max, path] = splitKey(key);
  return fetchThumbnail(path, Number(max));
});

const remote = createImageCache((key) => {
  const [max, referer, url] = splitKey(key, 3);
  return previewImage(url, referer || null, Number(max));
});

/** Split on the first `n - 1` separators, leaving the payload intact. */
function splitKey(key: string, parts = 2): string[] {
  const head: string[] = [];
  let rest = key;
  for (let i = 0; i < parts - 1; i += 1) {
    const at = rest.indexOf("|");
    head.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return [...head, rest];
}

const localKey = (path: string, max: number) => `${max}|${path}`;
const remoteKey = (url: string, referer: string | null, max: number) =>
  `${max}|${referer ?? ""}|${url}`;

export function cachedThumbnail(path: string, max: number) {
  return local.peek(localKey(path, max));
}

export function loadThumbnail(path: string, max: number) {
  return local.load(localKey(path, max));
}

export function cachedPreview(url: string, referer: string | null, max: number) {
  return remote.peek(remoteKey(url, referer, max));
}

export function loadPreview(url: string, referer: string | null, max: number) {
  return remote.load(remoteKey(url, referer, max));
}

/** Drop every cached thumbnail. Called when a different folder is opened. */
export function clearThumbnails() {
  local.clear();
}
