import { useCallback, useEffect, useRef } from "react";

/**
 * Where each scrollable screen was left.
 *
 * Module-level rather than React state on purpose: a screen's scroll offset
 * outlives the component that had it — that is the entire point — and nothing
 * should re-render because it changed.
 *
 * Not persisted across launches. Coming back to the app is a different thing
 * from coming back from a chapter, and restoring a month-old scroll into a list
 * that has since changed would be worse than starting at the top.
 */
const offsets = new Map<string, number>();

/** Forget a screen's position, for when its content is about to change wholesale. */
export function forgetScroll(key: string) {
  offsets.delete(key);
}

/**
 * Keep a scroll container where the user left it.
 *
 * Returns a ref to put on the scrolling element. Restoring is deferred until
 * the element actually has the height to scroll: a list that is still loading
 * is zero tall, and setting `scrollTop` on it silently does nothing.
 *
 * `ready` is what says the content is there — pass the loaded list, or a count.
 * While it is false nothing is restored, and once it is true the position is
 * applied once.
 */
export function useRestoredScroll<T extends HTMLElement>(key: string, ready: boolean) {
  const ref = useRef<T | null>(null);
  const restored = useRef(false);

  // Remember continuously rather than on unmount: React may drop the element
  // before any cleanup that wanted to read it runs.
  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node && restored.current) offsets.set(key, node.scrollTop);
  }, [key]);

  useEffect(() => {
    const node = ref.current;
    if (!node || restored.current || !ready) return;

    const wanted = offsets.get(key) ?? 0;
    restored.current = true;
    if (wanted === 0) return;

    // After paint, so the list has its height. Clamped because the content may
    // legitimately be shorter than it was.
    requestAnimationFrame(() => {
      const target = ref.current;
      if (target) target.scrollTop = Math.min(wanted, target.scrollHeight);
    });
  }, [key, ready]);

  return { ref, onScroll };
}
