// ============================================================================
// scene-kit: the ergonomics layer under the /lens demos. Scenes stay typed TS
// (demos.ts) — this kit only absorbs the four bookkeeping chores that made the
// hand-written compositions long and haunted:
//
//   1. AUTO-RESTORE — the api handed to enter/apply RECORDS every write; on
//      deselect the kit undoes them in reverse. exit() becomes optional (kept
//      for truly custom teardown, e.g. disposing an object the demo created).
//   2. spans()     — one declaration owns segment state, boundary gestures,
//      mid-gesture retarget, multi-boundary jumps, and reduced-motion.
//   3. posePath()  — camera keyframes lerped into a CameraPose, with `dist`
//      derived from a `frame` size (frame/tan(fov/2)) so framing holds as fov
//      drifts and ortho→perspective reads as one move.
//   4. drive()     — writes a channel's value AND target together, so a scrubbed
//      frame is a pure function of p (no target-easing scrub history).
//
// Demos call the kit through the FREE-FUNCTION VERBS at the bottom of this
// file (setShading, drive, spans, …) — no api parameter to thread. The page
// shim brackets every demo callback in withKit(), which points the verbs at
// the selection's recording api.
//
// House rule: this file must stay SMALLER than the boilerplate it deletes.
// ============================================================================
import type { Object3D } from "three/webgpu";
import { lerp } from "../core/math";
import type {
  CameraPose,
  SceneHandle,
  SceneState,
  ShadingMode,
  TransitionName,
} from "../core/scene";
import type { DemoApi } from "./demos";
import type { PageWipeCfg } from "./page-wipe";
import type { PageTextCfg } from "./page-text";

// The plain (non-`*Target`) channel names — what drive() addresses.
type DriveChannel = Exclude<keyof SceneState, `${string}Target`>;
// A shader uniform as demos write it: a mutable { value } (scalar or a
// three math object with copy()/clone()).
interface UniformRef<T> {
  value: T;
}

// ---------------------------------------------------------------------------
// posePath: camera keyframes → (p) => CameraPose.
// ---------------------------------------------------------------------------
interface Pose {
  az?: number;
  el?: number;
  fov?: number;
  targetY?: number;
  /** on-screen framing size — dist = frame/tan(fov/2), recomputed from the
   *  interpolated fov each frame (holds the subject size as fov drifts). */
  frame?: number;
  /** explicit distance — wins over frame. */
  dist?: number;
}
export interface PoseKey {
  p: number;
  /** OMITTED fields carry forward from the previous key, so a key lists only
   *  what CHANGES; `dist`/`frame` are mutually exclusive (setting one drops the
   *  carried other). Omit `pose` entirely to HOLD. The first key must give
   *  az/el (and fov unless the boot fov is intended). */
  pose?: Pose;
  /** shapes the segment ENDING at this key (default linear). */
  ease?: (t: number) => number;
}

const distOf = (pose: Pose, fov: number) =>
  pose.dist ?? (pose.frame ?? 0) / Math.tan((fov * Math.PI) / 360);

/** Build a pose sampler from ascending keys. Between two keys every field is
 *  lerped under the destination key's ease; `dist` is lerped between each end's
 *  distOf() evaluated at the CURRENT fov, so a frame-locked end tracks the
 *  drifting fov while a fixed-dist end holds — the exact ortho→perspective /
 *  frame idiom the hand-stacked lerps encoded. Clamps outside the key range. */
export function posePath(
  keys: PoseKey[],
  bootFov = 45,
): (p: number) => CameraPose {
  // resolve carry-forward once: each key inherits the prior key's resolved pose
  const R: { p: number; pose: Pose; ease?: (t: number) => number }[] = [];
  let carry: Pose = {};
  for (const k of keys) {
    const pose: Pose = { ...carry, ...k.pose };
    if (k.pose?.dist !== undefined) delete pose.frame;
    if (k.pose?.frame !== undefined) delete pose.dist;
    carry = pose;
    R.push({ p: k.p, pose, ease: k.ease });
  }
  return (p) => {
    let i = 0;
    while (i < R.length - 1 && p > R[i + 1].p) i++;
    const a = R[i];
    const b = R[Math.min(i + 1, R.length - 1)];
    const span = b.p - a.p;
    const u = span > 1e-6 ? Math.min(1, Math.max(0, (p - a.p) / span)) : 0;
    const e = b.ease ? b.ease(u) : u;
    const fov = lerp(a.pose.fov ?? bootFov, b.pose.fov ?? bootFov, e);
    return {
      azimuth: lerp(a.pose.az ?? 0, b.pose.az ?? 0, e),
      elevation: lerp(a.pose.el ?? 0, b.pose.el ?? 0, e),
      distance: lerp(distOf(a.pose, fov), distOf(b.pose, fov), e),
      fov,
      targetY: lerp(a.pose.targetY ?? 0, b.pose.targetY ?? 0, e),
    };
  };
}

// ---------------------------------------------------------------------------
// spans: shading sequenced across p-boundaries. One boundary crossed by a
// single step fires a choreographed cut; a jump over >1 boundary (or entry, or
// reduced-motion) lands the look instantly. The `present` side effect (page
// ground/caption) fires at the swap BEAT so it cuts together with the material.
// ---------------------------------------------------------------------------
export interface ShadingSpansCfg {
  /** ascending p-boundaries; N boundaries ⇒ N+1 spans. */
  at: number[];
  /** shading mode presented in each span (length at.length + 1). */
  looks: ShadingMode[];
  /** transition for a single-boundary STEP across boundary `b` moving `up`;
   *  omit / return undefined ⇒ instant cut (no gesture). */
  cut?: (b: number, up: boolean) => TransitionName | undefined;
  /** beat-synced side effect (fires at the swap beat during a gesture, or
   *  immediately on an instant land). */
  present?: (seg: number) => void;
}

// ---------------------------------------------------------------------------
// The recording api + its teardown. createDemoKit wraps the page's base
// DemoApi once; each demo selection calls begin() then, on deselect,
// restore() (after the demo's optional exit()).
// ---------------------------------------------------------------------------
export interface KitApi {
  state: SceneState;
  /** the raw scene — for reads (getShading, partNames) and writes the kit does
   *  not need to restore (swapShading retargets, setPartOffset cleared by
   *  clearPartOffsets, invalidate). Recorded writes go through the kit methods
   *  below, never through api.scene. */
  scene: SceneHandle;
  setPageWipe(cfg: PageWipeCfg | null): void;
  setPageText(cfg: PageTextCfg | null): void;
  setCameraPose(pose: CameraPose | null): void;
  setTransparentBackground(on: boolean): void;
  setModelOrientation(
    euler: { x?: number; y?: number; z?: number } | null,
  ): void;
  setIsolate(group: "glass" | "optics" | "silhouette" | null): void;
  setShading(mode: ShadingMode): void;
  setOverlayPass(pass: Parameters<SceneHandle["setOverlayPass"]>[0]): void;
  addOverlay(obj: Object3D): void;
  removeOverlay(obj: Object3D): void;
  /** write a uniform's .value (snapshotting the prior once). */
  set<T>(u: UniformRef<T>, v: T): void;
  /** set a channel's value AND target — a scrubbed frame is a pure function of
   *  p. Restores the prior target (the value eases home) on teardown. */
  drive(channel: DriveChannel, v: number): void;
  /** boundary machinery — see ShadingSpansCfg. */
  spans(cfg: ShadingSpansCfg): { apply(p: number): void };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object";
const cloneVal = <T>(v: T): T =>
  isObj(v) && typeof v.clone === "function" ? (v.clone() as T) : v;
const writeVal = <T>(u: UniformRef<T>, v: T) => {
  if (isObj(u.value) && typeof u.value.copy === "function")
    (u.value as unknown as { copy(x: T): void }).copy(v);
  else u.value = v;
};

export function createDemoKit(base: DemoApi): {
  api: KitApi;
  begin(): void;
  restore(): void;
} {
  const { scene, state } = base;
  const reduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // First write of each keyed target pushes its inverse; restore() runs the
  // inverses in REVERSE order (mirror of how the writes stacked).
  //
  // Two rules keep a recorded inverse from being SKIPPED, because a skipped one
  // is not equally harmful across the write kinds: every symbol-keyed undo below
  // writes a constant REST value (the bench is at rest whenever a demo is
  // selected), so missing one still lands at rest on the next teardown — it
  // self-heals. set()/drive() invert to a MEASURED prior instead, and a demo
  // writes its uniforms FIRST in enter(), so they are undone LAST. Skip one and
  // the box stays dirty AND the next demo's set() snapshots the dirty value as
  // its own "prior" — the leak is then permanent (a knob soloing a mask until
  // reload, silently corrupting every later scrub). Hence: (1) an undo that
  // throws must not strand the ones after it, and (2) a recording is never
  // DISCARDED, only run.
  let undos: (() => void)[] = [];
  const seen = new Set<unknown>();
  const once = (key: unknown, undo: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    undos.push(undo);
  };
  // one key per singleton target (rest value is the inverse — the bench sits at
  // rest whenever a demo is selected, so the "prior" is definitionally rest).
  const K = {
    pose: Symbol("pose"),
    bg: Symbol("bg"),
    orient: Symbol("orient"),
    iso: Symbol("iso"),
    overlay: Symbol("overlay"),
    shading: Symbol("shading"),
    wipe: Symbol("wipe"),
    text: Symbol("text"),
  };

  const api: KitApi = {
    state,
    scene,
    setCameraPose(pose) {
      once(K.pose, () => scene.setCameraPose(null));
      scene.setCameraPose(pose);
    },
    setTransparentBackground(on) {
      once(K.bg, () => scene.setTransparentBackground(false));
      scene.setTransparentBackground(on);
    },
    setModelOrientation(euler) {
      once(K.orient, () => scene.setModelOrientation(null));
      scene.setModelOrientation(euler);
    },
    setIsolate(group) {
      once(K.iso, () => scene.setIsolate(null));
      scene.setIsolate(group);
    },
    setOverlayPass(pass) {
      once(K.overlay, () => scene.setOverlayPass(null));
      scene.setOverlayPass(pass);
    },
    setShading(mode) {
      const prior = scene.getShading();
      // restore instant + a retarget-only swap (lands a swap still in flight)
      once(K.shading, () => {
        scene.setShading(prior);
        scene.swapShading(prior);
      });
      scene.setShading(mode);
    },
    setPageWipe(cfg) {
      once(K.wipe, () => base.setPageWipe(null));
      base.setPageWipe(cfg);
    },
    setPageText(cfg) {
      once(K.text, () => base.setPageText(null));
      base.setPageText(cfg);
    },
    addOverlay(obj) {
      once(obj, () => scene.removeOverlay(obj));
      scene.addOverlay(obj);
    },
    removeOverlay(obj) {
      scene.removeOverlay(obj);
    },
    set(u, v) {
      const prior = cloneVal(u.value);
      once(u, () => writeVal(u, prior));
      writeVal(u, v);
      scene.invalidate();
    },
    drive(channel, v) {
      const tk = `${channel}Target` as keyof SceneState;
      const priorTarget = state[tk] as number;
      once(channel, () => {
        (state[tk] as number) = priorTarget;
      });
      (state[channel] as number) = v;
      (state[tk] as number) = v;
    },
    spans(cfg) {
      const segOf = (p: number) => {
        let s = 0;
        while (s < cfg.at.length && p >= cfg.at[s]) s++;
        return s;
      };
      let cur: number | null = null; // authoritative scrub segment
      let presented = -1; // segment the page side currently shows
      let pending = -1; // live retarget for an in-flight gesture's onProgress
      // the swap beat fires from the transition tick — outside any withKit
      // bracket — so re-enter this recorder's scope around the callback
      const present = cfg.present
        ? (seg: number) => withKit(api, () => cfg.present!(seg))
        : undefined;
      const land = (seg: number) => {
        api.setShading(cfg.looks[seg]); // records the bench look once
        scene.swapShading(cfg.looks[seg]); // retarget-only follow-up
        presented = pending = seg;
        present?.(seg);
      };
      return {
        apply(p: number) {
          const seg = segOf(p);
          if (seg === cur) return;
          const step = cur != null && !reduced() && Math.abs(seg - cur) === 1;
          const tr = step
            ? cfg.cut?.(Math.min(seg, cur as number), seg > (cur as number))
            : undefined;
          if (!step || !tr) {
            land(seg);
          } else {
            pending = seg;
            scene.swapShading(cfg.looks[seg], {
              transition: tr,
              // live `pending`, not a captured seg: a retargeted in-flight swap
              // keeps its ORIGINAL onProgress, which must flip to the LATEST
              // pending at the beat (swapShading ignores a re-passed onProgress).
              onProgress: (t) => {
                if (t >= 0.5 && presented !== pending) {
                  presented = pending;
                  present?.(pending);
                }
              },
            });
          }
          cur = seg;
        },
      };
    },
  };

  // Detach the recording FIRST, so an undo that itself writes through the kit
  // (a shading transition's beat-synced `present` re-entering the bracket from
  // its own tick) records into the NEXT recording rather than one being drained.
  const runUndos = () => {
    const pending = undos;
    undos = [];
    seen.clear();
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        pending[i]();
      } catch (err) {
        console.warn("lens demo kit: an auto-restore step failed", err);
      }
    }
  };

  return {
    api,
    // Undo, never discard: a write that landed after the last restore() — a
    // late transition beat, a bind()ed async tick — is recorded into a fresh
    // recording, and dropping it would strand it forever.
    begin: runUndos,
    restore: runUndos,
  };
}

// ---------------------------------------------------------------------------
// Free-function verbs. Demo code just says what happens — setShading("flat"),
// drive("bend", v) — against an implicit current recorder that withKit() sets
// for the duration of each demo callback (and that the kit re-enters around
// callbacks it fires later, e.g. spans' beat-synced present). Synchronous
// only: a verb called from an unbracketed async callback throws instead of
// silently escaping the recorder.
// ---------------------------------------------------------------------------
let current: KitApi | null = null;

/** Bracket fn so the verbs below target `api` (the page shim does this
 *  around every demo enter/apply/exit call). */
export function withKit<T>(api: KitApi, fn: () => T): T {
  const prev = current;
  current = api;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

const kit = (): KitApi => {
  if (!current)
    throw new Error(
      "scene-kit verb called outside a demo's enter/apply/exit (async callback?)",
    );
  return current;
};

/** the live scene state — reads; recorded channel writes go through drive(). */
export const state = (): SceneState => kit().state;
/** the raw scene — reads and un-recorded writes only (see KitApi.scene). */
export const scene = (): SceneHandle => kit().scene;
export const setPageWipe: KitApi["setPageWipe"] = (cfg) =>
  kit().setPageWipe(cfg);
export const setPageText: KitApi["setPageText"] = (cfg) =>
  kit().setPageText(cfg);
export const setCameraPose: KitApi["setCameraPose"] = (pose) =>
  kit().setCameraPose(pose);
export const setTransparentBackground: KitApi["setTransparentBackground"] = (
  on,
) => kit().setTransparentBackground(on);
export const setModelOrientation: KitApi["setModelOrientation"] = (euler) =>
  kit().setModelOrientation(euler);
export const setIsolate: KitApi["setIsolate"] = (group) =>
  kit().setIsolate(group);
export const setShading: KitApi["setShading"] = (mode) =>
  kit().setShading(mode);
export const setOverlayPass: KitApi["setOverlayPass"] = (pass) =>
  kit().setOverlayPass(pass);
export const addOverlay: KitApi["addOverlay"] = (obj) => kit().addOverlay(obj);
export const removeOverlay: KitApi["removeOverlay"] = (obj) =>
  kit().removeOverlay(obj);
export const set = <T>(u: UniformRef<T>, v: T): void => kit().set(u, v);
export const drive: KitApi["drive"] = (channel, v) => kit().drive(channel, v);
export const spans: KitApi["spans"] = (cfg) => kit().spans(cfg);

/** Capture the current bracket and return fn wrapped to re-enter it whenever
 *  it fires later — the escape hatch for genuinely async demo motion (an
 *  anime.js autoplay/spring tick, a timeout): `onUpdate: bind(() =>
 *  drive("bend", o.v))`. Scrub-driven timelines (built in enter, seek()ed in
 *  apply) never need it — their callbacks already run inside the bracket. */
export function bind<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const api = kit();
  return (...args) => withKit(api, () => fn(...args));
}
