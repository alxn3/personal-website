// A recording SceneHandle for the story tests: setters log their last value and
// the evaluate/frame callbacks are kept so a test can run them. `installHeroDom`
// stubs the DOM that hero-driver and the card field use; `lin` samples a range.

import type * as THREE from "three/webgpu";
import type { SceneHandle } from "../../core/scene";
import { CHANNEL_DEFAULTS } from "../../core/scene";

type EvaluateCb = (pE: number, dt: number) => boolean | void;
type FrameCb = Parameters<SceneHandle["onFrame"]>[0];

export interface FakeScene {
  scene: SceneHandle;
  state: Record<string, number>;
  evaluateCbs: EvaluateCb[];
  frameCbs: FrameCb[];
  /** the last value each setter was handed, by setter name */
  writes: Record<string, unknown>;
  /** every setter call's name, in order */
  calls: string[];
  /** overlays attached at the scene root, on the model, and on the starfield */
  overlays: Set<THREE.Object3D>;
  modelOverlays: Set<THREE.Object3D>;
  skyChildren: Set<THREE.Object3D>;
  /** whether starfieldAttach succeeds (the starfield is "mounted") */
  starfieldMounted: boolean;
  /** run every evaluate callback in registration order */
  evaluate(pE: number, dt?: number): boolean;
  /** run every frame callback — after the render */
  frame(dt?: number): void;
}

/** `over` replaces any of the scene's members. */
export function fakeScene(over: Record<string, unknown> = {}): FakeScene {
  const state: Record<string, number> = {};
  for (const [c, v] of Object.entries(CHANNEL_DEFAULTS)) {
    state[c] = v;
    state[`${c}Target`] = v;
  }
  const evaluateCbs: EvaluateCb[] = [];
  const frameCbs: FrameCb[] = [];
  const writes: Record<string, unknown> = {};
  const calls: string[] = [];
  const overlays = new Set<THREE.Object3D>();
  const modelOverlays = new Set<THREE.Object3D>();
  const skyChildren = new Set<THREE.Object3D>();
  const fake = {
    starfieldMounted: true,
  } as FakeScene;
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(name);
      writes[name] = args.length === 1 ? args[0] : args;
    };
  const project = () => null;
  const scene = {
    state,
    onEvaluate: (cb: EvaluateCb) => void evaluateCbs.push(cb),
    onFrame: (cb: FrameCb) => void frameCbs.push(cb),
    ...Object.fromEntries(
      [
        "invalidate",
        "setInkMix",
        "setStoryFov",
        "setStoryCentre",
        "setDust",
        "setGlassTransmissive",
        "setGlassFade",
        "setGlassElementFade",
        "setGlassGlint",
        "setBodyFade",
        "setShellFade",
        "setInteriorFade",
        "setRoomLight",
        "setLensDolly",
        "setSkyDim",
        "warmDraw",
      ].map((n) => [n, rec(n)]),
    ),
    setModelOrientation: (e: { x: number; y: number; z: number } | null) => {
      calls.push("setModelOrientation");
      writes.setModelOrientation = e === null ? null : { ...e };
    },
    worldAxialSpans: () => ({}),
    enableStarfield: (on: boolean) => {
      calls.push("enableStarfield");
      writes.enableStarfield = on;
      fake.starfieldMounted = on;
      return Promise.resolve(true);
    },
    enableWormholePost: (on: boolean) => {
      calls.push("enableWormholePost");
      writes.enableWormholePost = on;
      return Promise.resolve(true);
    },
    buildWormholePost: () => Promise.resolve(true),
    warmFly: () => Promise.resolve(true),
    addOverlay: (o: THREE.Object3D) => void overlays.add(o),
    removeOverlay: (o: THREE.Object3D) => void overlays.delete(o),
    addModelOverlay: (o: THREE.Object3D) => void modelOverlays.add(o),
    removeModelOverlay: (o: THREE.Object3D) => void modelOverlays.delete(o),
    starfieldAttach: (o: THREE.Object3D) => {
      if (!fake.starfieldMounted) return false;
      skyChildren.add(o);
      return true;
    },
    starfieldDetach: (o: THREE.Object3D) => void skyChildren.delete(o),
    frameHalf: () => 0.58,
    frameAspect: () => 16 / 9,
    ...over,
  } as unknown as SceneHandle;
  Object.assign(fake, {
    scene,
    state,
    evaluateCbs,
    frameCbs,
    writes,
    calls,
    overlays,
    modelOverlays,
    skyChildren,
    evaluate(pE: number, dt = 16) {
      let live = false;
      for (const cb of evaluateCbs) if (cb(pE, dt)) live = true;
      return live;
    },
    frame(dt = 16) {
      for (const cb of frameCbs) cb(project, dt);
    },
  });
  return fake;
}

/** n + 1 evenly spaced samples from a to b, both included. */
export const lin = (a: number, b: number, n: number): number[] =>
  Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

/** A 2D context that swallows every call: the card faces and the sky's type
 *  paint into it, and only `measureText` needs a shape back. */
const canvasStub = () => ({
  width: 0,
  height: 0,
  getContext: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : () => ({ width: 8 })),
      set: (t, k: string, v) => ((t[k] = v), true),
    }),
});

export interface HeroDom {
  hud: { textContent: string };
  /** the pin elements, in `opts.pins` order; `style` keeps the last writes */
  pins: { style: Record<string, unknown> }[];
  /** dispatch a scroll: the driver's listener, then any rAF it queued */
  scroll(y: number): void;
  /** dispatch the scroll event alone, before the frame's rAF callbacks */
  scrollEvent(y: number): void;
  setDark(dark: boolean): void;
}

/** The hero markup hero-driver.ts queries, plus the globals the riders reach
 *  for. `p = (scrollY − trackTop) / (trackHeight − innerHeight)`. */
export function installHeroDom(opts: {
  scrollY: number;
  trackTop?: number;
  trackHeight?: number;
  innerHeight?: number;
  /** LensPin elements on the stage; `display` is their computed display */
  pins?: { beat: string; track: string; display?: string }[];
}): HeroDom {
  const trackTop = opts.trackTop ?? 0;
  const trackHeight = opts.trackHeight ?? 11_000;
  const innerHeight = opts.innerHeight ?? 1000;
  const g = globalThis as unknown as Record<string, unknown>;
  const el = (extra: Record<string, unknown> = {}) => ({
    style: { setProperty() {} } as Record<string, unknown>,
    textContent: "",
    dataset: {},
    classList: { toggle() {}, contains: () => dark },
    querySelectorAll: () => [],
    querySelector: () => null,
    ...extra,
  });
  let dark = false;
  const track = el({
    getBoundingClientRect: () => ({ top: trackTop - (g.scrollY as number) }),
    offsetHeight: trackHeight,
  });
  const pins = (opts.pins ?? []).map(({ beat, track, display }) =>
    el({ dataset: { beat, track }, display: display ?? "block" }),
  );
  const byId: Record<string, unknown> = {
    "lens-track": track,
    "lens-stage": el({
      querySelectorAll: (sel: string) => (sel === "[data-track]" ? pins : []),
    }),
    hud: el(),
    "scene-rail": el(),
    "scroll-cue": el(),
  };
  const listeners: Record<string, (() => void)[]> = {};
  let raf: (() => void) | null = null;
  const win = {
    scrollY: opts.scrollY,
    innerHeight,
    devicePixelRatio: 1,
    addEventListener: (type: string, cb: () => void) =>
      void (listeners[type] ??= []).push(cb),
    removeEventListener() {},
  };
  Object.assign(g, {
    window: Object.assign(g, win),
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      documentElement: el(),
      createElement: canvasStub,
      fonts: { ready: Promise.resolve() },
      head: { append() {} },
      body: { append() {} },
    },
    location: { search: "" },
    getComputedStyle: (e: { display?: string }) => ({ display: e.display }),
    requestAnimationFrame: (cb: () => void) => void (raf = cb),
    ResizeObserver: class {
      observe() {}
    },
    MutationObserver: class {
      observe() {}
    },
    Image: class {
      crossOrigin = "";
      src = "";
      onload: (() => void) | null = null;
    },
  });
  return {
    hud: byId.hud as { textContent: string },
    pins: pins as unknown as HeroDom["pins"],
    scroll(y) {
      this.scrollEvent(y);
      raf?.();
      raf = null;
    },
    scrollEvent(y) {
      (g as { scrollY: number }).scrollY = y;
      for (const cb of listeners.scroll ?? []) cb();
    },
    setDark(d) {
      dark = d;
    },
  };
}
