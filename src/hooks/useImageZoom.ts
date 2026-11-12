import { useEffect, useRef, useState } from "react";

const MAX_SCALE = 4;

interface Zoom {
  scale: number;
  x: number;
  y: number;
}

const IDLE: Zoom = { scale: 1, x: 0, y: 0 };

/** Below this the float noise from wheel/pinch maths never quite lands on 1. */
const SNAP_EPSILON = 0.02;

/**
 * How far below 1 the element may be zoomed: down to where it fits its
 * container, and no further.
 *
 * Normally 1 — a fitted page already fits. "Original size" is the exception:
 * a 2400px scan is twice a phone's width even at one image pixel per screen
 * pixel, and with a floor of 1 the reader opened it cropped to its middle with
 * no way to see the rest.
 */
function minScale(node: HTMLElement): number {
  const box = node.parentElement;
  if (!box || !node.clientWidth || !node.clientHeight) return 1;
  return Math.min(1, box.clientWidth / node.clientWidth, box.clientHeight / node.clientHeight);
}

/**
 * How far the element may be panned on one axis before empty space would show
 * at an edge: the larger of how far it overhangs its own box (a zoomed fitted
 * page) and how far it overhangs its container (an original-size one).
 */
function overhang(size: number, container: number, scale: number): number {
  return Math.max(0, (size * (scale - 1)) / 2, (size * scale - container) / 2);
}

function clampZoom(next: Zoom, node: HTMLElement): Zoom {
  const clamped = Math.min(MAX_SCALE, Math.max(minScale(node), next.scale));
  const scale = Math.abs(clamped - 1) < SNAP_EPSILON ? 1 : clamped;
  const box = node.parentElement;
  const overhangX = overhang(node.clientWidth, box?.clientWidth ?? node.clientWidth, scale);
  const overhangY = overhang(node.clientHeight, box?.clientHeight ?? node.clientHeight, scale);
  if (scale === 1 && !overhangX && !overhangY) return IDLE;
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
 * Deliberately inert while the element fits: every listener below either does
 * nothing or calls `stopPropagation` only once it has decided to own the
 * gesture (a two-finger touch, or a drag on an element bigger than its
 * container). For a fitted page at scale 1 — the overwhelming majority of the
 * time — an event is left to bubble exactly as it did before this existed, so
 * the reader's tap-to-turn-page, swipe-to-turn and chrome-toggle handling above
 * it needs no changes and no knowledge that zoom exists at all beyond rendering
 * a reset button once `zoomed` says there is something to reset. A tap is
 * never claimed at scale 1, so on an overflowing page the edges still turn it.
 */
export function useImageZoom<T extends HTMLElement>() {
  // State rather than a ref object: the image usually mounts a render or two
  // after the hook does (a spinner first, while the page loads), and an effect
  // keyed on nothing would have run against a null ref and never again.
  const [node, setNode] = useState<T | null>(null);
  const [zoom, setZoom] = useState<Zoom>(IDLE);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!node) return;

    const apply = (next: Zoom) => {
      zoomRef.current = next;
      setZoom(next);
    };

    /** Zooms by `factor`, keeping the point under `(clientX, clientY)` fixed. */
    const zoomAt = (factor: number, clientX: number, clientY: number) => {
      const current = zoomRef.current;
      // The rect is of the element as already transformed, so its centre has
      // moved by the current pan; the maths below wants the untransformed one.
      const rect = node.getBoundingClientRect();
      const originX = clientX - (rect.left + rect.width / 2) + current.x;
      const originY = clientY - (rect.top + rect.height / 2) + current.y;
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

    /** Whether there is anything off-screen for a drag to bring into view. */
    const pannable = () => {
      const { scale } = zoomRef.current;
      const box = node.parentElement;
      if (!box) return scale > 1;
      return (
        overhang(node.clientWidth, box.clientWidth, scale) > 0 ||
        overhang(node.clientHeight, box.clientHeight, scale) > 0
      );
    };

    const onWheel = (event: WheelEvent) => {
      // Plain scrolling is not zoom — only the gesture every OS already uses
      // for it: an explicit ctrl/cmd held down, which is also what a trackpad
      // pinch reports as.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    };

    // Mouse panning, once there is something to pan to. A plain click at
    // scale 1 is left alone — that is the reader's own tap-to-turn-page and
    // chrome toggle.
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
      if (!pannable()) return;
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
      const moved = mouseMoved;
      mouseMoved = false;
      if (!moved && zoomRef.current.scale === 1) return;
      event.preventDefault();
      event.stopPropagation();
      if (!moved) apply(IDLE);
    };

    // Pinch: two touches whose distance apart between events gives the zoom
    // factor directly. Pan: one touch, only when the element overflows — on a
    // fitted page at scale 1 a single touch belongs to whichever gesture the
    // reading mode itself gives it, so it is never claimed here.
    let pinchDistance: number | null = null;
    let touchFrom: { x: number; y: number } | null = null;
    let touchMoved = false;
    // Outlives `pinchDistance`, which clears as the first finger lifts: the
    // last one lifting still ends a pinch, not a tap, even back at scale 1.
    let pinched = false;

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
        pinched = true;
        touchFrom = null;
      } else if (event.touches.length === 1 && (pannable() || zoomRef.current.scale !== 1)) {
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
      const zoomed = zoomRef.current.scale !== 1;
      if (zoomed || touchMoved || pinched) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (event.touches.length < 2) pinchDistance = null;
      if (event.touches.length === 0) {
        // A tap — no real movement — resets rather than leaving the reader
        // stuck zoomed with no obvious way out on a touch device.
        if (zoomed && touchFrom && !touchMoved) apply(IDLE);
        touchFrom = null;
        touchMoved = false;
        pinched = false;
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
  }, [node]);

  const zoomed = zoom.scale !== 1;
  // An original-size page pans at scale 1, so a transform is not only a zoom.
  const moved = zoomed || zoom.x !== 0 || zoom.y !== 0;
  return {
    ref: setNode,
    zoomed,
    style: moved ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined,
    reset: () => {
      zoomRef.current = IDLE;
      setZoom(IDLE);
    },
  };
}
