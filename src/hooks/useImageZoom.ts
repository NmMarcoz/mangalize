import { useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;

interface Zoom {
  scale: number;
  x: number;
  y: number;
}

const IDLE: Zoom = { scale: 1, x: 0, y: 0 };

/** Below this the float noise from wheel/pinch maths never quite lands on 1. */
const SNAP_EPSILON = 0.02;

function clampZoom(next: Zoom, node: HTMLElement): Zoom {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
  if (scale - MIN_SCALE < SNAP_EPSILON) return IDLE;
  // However far the scaled element now overhangs its own box on each axis is
  // exactly how far it may be panned before empty space would show at an edge.
  const overhangX = (node.clientWidth * (scale - 1)) / 2;
  const overhangY = (node.clientHeight * (scale - 1)) / 2;
  return {
    scale,
    x: Math.min(overhangX, Math.max(-overhangX, next.x)),
    y: Math.min(overhangY, Math.max(-overhangY, next.y)),
  };
}

/**
 * Pinch-to-zoom, ctrl/cmd+wheel, and drag-to-pan for a single image element.
 *
 * Attached with native listeners via a ref rather than React's touch/wheel
 * props: React marks its own touch listeners passive, which silently drops
 * `preventDefault` and leaves a scroll container underneath free to fight the
 * gesture. `{ passive: false }` here is what actually stops that.
 *
 * Deliberately inert at scale 1: every listener below either does nothing or
 * calls `stopPropagation` only once it has decided to own the gesture (a
 * two-finger touch, or a drag that starts already zoomed in). At scale 1 —
 * the overwhelming majority of the time — an event is left to bubble exactly
 * as it did before this existed, so the reader's tap-to-turn-page,
 * swipe-to-turn and chrome-toggle handling above it needs no changes and no
 * knowledge that zoom exists at all beyond rendering a reset button once
 * `zoomed` says there is something to reset.
 */
export function useImageZoom<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [zoom, setZoom] = useState<Zoom>(IDLE);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const apply = (next: Zoom) => {
      zoomRef.current = next;
      setZoom(next);
    };

    /** Zooms by `factor`, keeping the point under `(clientX, clientY)` fixed. */
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const rect = node.getBoundingClientRect();
      const originX = clientX - (rect.left + rect.width / 2);
      const originY = clientY - (rect.top + rect.height / 2);
      const current = zoomRef.current;
      const scale = current.scale * factor;
      apply(
        clampZoom(
          {
            scale,
            x: originX - (originX - current.x) * (scale / current.scale),
            y: originY - (originY - current.y) * (scale / current.scale),
          },
          node,
        ),
      );
    };

    const panBy = (dx: number, dy: number) => {
      const current = zoomRef.current;
      apply(clampZoom({ scale: current.scale, x: current.x + dx, y: current.y + dy }, node));
    };

    const onWheel = (event: WheelEvent) => {
      // Plain scrolling is not zoom — only the gesture every OS already uses
      // for it: an explicit ctrl/cmd held down, which is also what a trackpad
      // pinch reports as.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    };

    // Mouse panning, once already zoomed. A plain click at scale 1 is left
    // alone — that is the reader's own tap-to-turn-page and chrome toggle.
    let mouseFrom: { x: number; y: number } | null = null;
    let mouseMoved = false;

    const onMouseMove = (event: MouseEvent) => {
      if (!mouseFrom) return;
      panBy(event.clientX - mouseFrom.x, event.clientY - mouseFrom.y);
      mouseFrom = { x: event.clientX, y: event.clientY };
      mouseMoved = true;
    };
    const onMouseUp = () => {
      mouseFrom = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (zoomRef.current.scale <= 1) return;
      event.preventDefault();
      mouseFrom = { x: event.clientX, y: event.clientY };
      mouseMoved = false;
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp, { once: true });
    };
    // A click that turns out to have been the start of a pan must not also
    // reach the reader's own click handling underneath (page turn, chrome
    // toggle) — and neither should the plain tap that resets zoom.
    const onClick = (event: MouseEvent) => {
      if (zoomRef.current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      if (!mouseMoved) apply(IDLE);
    };

    // Pinch: two touches whose distance apart between events gives the zoom
    // factor directly. Pan: one touch, only once already zoomed — at scale 1
    // a single touch belongs to whichever gesture the reading mode itself
    // gives it, so it is never claimed here.
    let pinchDistance: number | null = null;
    let touchFrom: { x: number; y: number } | null = null;
    let touchMoved = false;

    const distance = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const midpoint = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        event.stopPropagation();
        pinchDistance = distance(event.touches);
        touchFrom = null;
      } else if (event.touches.length === 1 && zoomRef.current.scale > 1) {
        event.stopPropagation();
        touchFrom = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        touchMoved = false;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && pinchDistance !== null) {
        event.preventDefault();
        event.stopPropagation();
        const next = distance(event.touches);
        const mid = midpoint(event.touches);
        zoomAt(next / pinchDistance, mid.x, mid.y);
        pinchDistance = next;
      } else if (event.touches.length === 1 && touchFrom) {
        event.preventDefault();
        event.stopPropagation();
        const touch = event.touches[0];
        panBy(touch.clientX - touchFrom.x, touch.clientY - touchFrom.y);
        touchFrom = { x: touch.clientX, y: touch.clientY };
        touchMoved = true;
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      // Cancels the synthetic click a touch would otherwise generate, which
      // would otherwise land on the reader's own tap handling right after —
      // a tap that only just zoomed or panned must not also turn the page.
      if (zoomRef.current.scale > 1 || pinchDistance !== null) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.touches.length < 2) pinchDistance = null;
      if (event.touches.length === 0) {
        // A tap — no real movement — resets rather than leaving the reader
        // stuck zoomed in with no obvious way out on a touch device.
        if (touchFrom && !touchMoved) apply(IDLE);
        touchFrom = null;
      }
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("mousedown", onMouseDown);
    node.addEventListener("click", onClick);
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd, { passive: false });
    node.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("mousedown", onMouseDown);
      node.removeEventListener("click", onClick);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const zoomed = zoom.scale > 1;
  return {
    ref,
    zoomed,
    style: zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined,
    reset: () => {
      zoomRef.current = IDLE;
      setZoom(IDLE);
    },
  };
}
