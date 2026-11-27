import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropZone, startDrag } from "./drag";

/** Just enough of an element: the tests run without a DOM. */
class FakeElement {
  readonly attributes = new Set<string>();
  style = {};
  className = "";
  textContent = "";
  removed = false;
  constructor(
    readonly parentElement: FakeElement | null = null,
    private readonly control = false,
  ) {}
  setAttribute(name: string) {
    this.attributes.add(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  closest() {
    return this.control ? this : null;
  }
  remove() {
    this.removed = true;
  }
}

describe("pointer drag and drop", () => {
  let under: FakeElement | null;
  let ghosts: FakeElement[];

  beforeEach(() => {
    vi.useFakeTimers();
    under = null;
    ghosts = [];
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", {
      elementFromPoint: () => under,
      createElement: () => new FakeElement(),
      body: { appendChild: (el: FakeElement) => ghosts.push(el) },
      documentElement: { classList: { add: () => {}, remove: () => {} } },
    });
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const fire = (type: string, props: object = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { button: 0, buttons: 1, clientX: 0, clientY: 0 }, props);
    window.dispatchEvent(event);
    return event;
  };
  const press = (target = new FakeElement(), props: object = {}) =>
    startDrag({ button: 0, pointerType: "mouse", clientX: 0, clientY: 0, target, ...props } as never, "t", () => ({ data: "payload", label: "name" }));
  const zone = (type: string, parent: FakeElement | null = null) => {
    const el = new FakeElement(parent);
    const drop = vi.fn();
    const cleanup = dropZone(type, drop)(el as never);
    return { el, drop, cleanup };
  };

  it("drops on the innermost zone of the same type", () => {
    const outer = zone("t");
    const inner = zone("t", outer.el);
    const other = zone("other", inner.el);
    press();
    under = new FakeElement(other.el);
    fire("pointermove", { clientX: 20 });
    expect(inner.el.attributes.has("data-drag-over")).toBe(true);
    expect(ghosts[0].textContent).toBe("name");

    under = outer.el;
    fire("pointermove", { clientX: 30 });
    expect(inner.el.attributes.size).toBe(0);
    expect(outer.el.attributes.has("data-drag-over")).toBe(true);

    fire("pointerup", { clientX: 30 });
    expect(outer.drop).toHaveBeenCalledWith("payload");
    expect(inner.drop).not.toHaveBeenCalled();
    expect(other.drop).not.toHaveBeenCalled();
    expect(outer.el.attributes.size).toBe(0);
    expect(ghosts[0].removed).toBe(true);
  });

  it("leaves a press that barely moves as a click", () => {
    const target = zone("t");
    under = target.el;
    press();
    fire("pointermove", { clientX: 3 });
    fire("pointerup", { clientX: 3 });
    expect(ghosts).toHaveLength(0);
    expect(target.drop).not.toHaveBeenCalled();
    expect(fire("click").defaultPrevented).toBe(false);
  });

  it("swallows only the click that ends a drag", () => {
    press();
    fire("pointermove", { clientX: 20 });
    fire("pointerup", { clientX: 20 });
    expect(fire("click").defaultPrevented).toBe(true);
    vi.runAllTimers();
    expect(fire("click").defaultPrevented).toBe(false);
  });

  it("does not drop after Escape", () => {
    const target = zone("t");
    under = target.el;
    press();
    fire("pointermove", { clientX: 20 });
    fire("keydown", { key: "Escape" });
    expect(target.el.attributes.size).toBe(0);
    fire("pointermove", { clientX: 40 });
    fire("pointerup", { clientX: 40 });
    expect(target.drop).not.toHaveBeenCalled();
  });

  it("gives up when the button was released elsewhere or the window lost focus", () => {
    const target = zone("t");
    under = target.el;
    for (const stop of [() => fire("pointermove", { clientX: 30, buttons: 0 }), () => fire("blur")]) {
      press();
      fire("pointermove", { clientX: 20 });
      stop();
      fire("pointerup", { clientX: 30 });
    }
    expect(target.drop).not.toHaveBeenCalled();
    expect(ghosts.every((g) => g.removed)).toBe(true);
  });

  it("ignores other buttons, touch, and controls inside the source", () => {
    press(undefined, { button: 2 });
    press(undefined, { pointerType: "touch" });
    press(new FakeElement(null, true));
    fire("pointermove", { clientX: 20 });
    expect(ghosts).toHaveLength(0);
  });

  it("forgets a zone once it is cleaned up", () => {
    const target = zone("t");
    target.cleanup?.();
    under = target.el;
    press();
    fire("pointermove", { clientX: 20 });
    fire("pointerup", { clientX: 20 });
    expect(target.drop).not.toHaveBeenCalled();
  });
});
