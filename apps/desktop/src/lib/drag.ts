// In-app drag and drop built on pointer events. HTML5 drag and drop does not work in
// WebView2 (Windows) while Tauri's file drop handler is on, and that handler is what
// delivers files dropped from Explorer.

import type { PointerEvent as ReactPointerEvent } from "react";

/** Pointer travel in pixels before a press becomes a drag. */
const THRESHOLD = 5;

interface Zone {
  type: string;
  drop: (data: string) => void;
}

const zones = new WeakMap<Element, Zone>();

/**
 * Ref callback making an element accept drags of `type`. While such a drag is over
 * it, the element has the `data-drag-over` attribute.
 */
export function dropZone(type: string, drop: (data: string) => void) {
  return (el: Element | null) => {
    if (!el) return;
    zones.set(el, { type, drop });
    return () => void zones.delete(el);
  };
}

/** The innermost element at a point that accepts `type`. */
function zoneAt(x: number, y: number, type: string): Element | null {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    if (zones.get(el)?.type === type) return el;
  }
  return null;
}

/** Releasing a drag over its source must not also count as a click. */
function swallowClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, true);
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

/**
 * `onPointerDown` handler of a drag source. `payload` is read once the pointer has
 * moved far enough; `label` is shown next to the pointer.
 */
export function startDrag(down: ReactPointerEvent, type: string, payload: () => { data: string; label: string }) {
  if (down.button !== 0 || down.pointerType === "touch") return;
  // Pressing a control inside the source (a tab's close button) is not a drag.
  if ((down.target as Element).closest("button, input, select, textarea")) return;
  const { clientX: startX, clientY: startY } = down;
  let drag: { data: string; ghost: HTMLElement } | null = null;
  let over: Element | null = null;
  let cancelled = false;

  const hover = (el: Element | null) => {
    if (el === over) return;
    over?.removeAttribute("data-drag-over");
    el?.setAttribute("data-drag-over", "");
    over = el;
  };
  const clear = () => {
    hover(null);
    drag?.ghost.remove();
    document.documentElement.classList.remove("dragging");
  };
  const end = () => {
    clear();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", end);
    window.removeEventListener("blur", end);
    window.removeEventListener("keydown", key, true);
  };

  const move = (e: PointerEvent) => {
    // The button was released without us seeing it.
    if (!(e.buttons & 1)) return end();
    if (cancelled) return;
    if (!drag) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      const { data, label } = payload();
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.documentElement.classList.add("dragging");
      drag = { data, ghost };
    }
    drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    hover(zoneAt(e.clientX, e.clientY, type));
  };

  const up = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const dragged = drag;
    const target = dragged && !cancelled ? zoneAt(e.clientX, e.clientY, type) : null;
    end();
    if (!dragged) return;
    swallowClick();
    if (target) zones.get(target)?.drop(dragged.data);
  };

  // Escape abandons the drag; listening goes on so the release is not taken as a click.
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drag || cancelled) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    clear();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
  window.addEventListener("keydown", key, true);
}
