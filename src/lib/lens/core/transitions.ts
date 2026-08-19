import type * as THREE from "three/webgpu";
import { band, lerp, smoothstep } from "./math";
// Type-only — erased at build, so no runtime cycle with the orchestrator.
import type { SceneState } from "./scene";

// Look-swap transitions: short rAF choreographies that make a shading change
// read as one gesture. Each drives EXISTING objects/channels (never a new
// shader graph) toward a hidden/peak moment, where scene.swapShading fires the
// material rebuild, then eases home.
//
// CONTRACT PER RUN: snapshot what you drive at creation and restore it
// bit-exactly in finish(), but ONLY where your write is still the last one
// (compare against the value you last wrote), so a slider that grabbed the
// channel mid-burst is never clobbered.

export type TransitionName = "twist" | "blink" | "molt" | "punch";

/** What a transition may touch. `model` is the gltf root — its local +Y is the
 *  optical axis, and rolling about it is rig-safe. */
export interface TransitionContext {
  state: SceneState;
  camera: THREE.PerspectiveCamera;
  model: THREE.Object3D;
  storyMode: boolean;
}

export interface TransitionOpts {
  durationMs?: number;
  /** twist only: full integer turns per swap (default 1) */
  turns?: number;
}

/** One in-flight choreography. The runner calls update(t) every rAF with raw
 *  progress t∈[0,1], fires the material swap when t first crosses swapAt, and
 *  calls finish() exactly once at t=1 (or on teardown). */
export interface TransitionRun {
  /** total length, ms */
  duration: number;
  /** progress at which the hidden material swap fires */
  swapAt: number;
  update(t: number): void;
  finish(): void;
}

/** null = unusable right now (e.g. punch under the story camera) — the runner
 *  falls back to an instant swap. */
export type TransitionFactory = (
  ctx: TransitionContext,
  opts: TransitionOpts,
) => TransitionRun | null;

// Quintic smootherstep: zero velocity AND acceleration at both ends, angular
// velocity peaks exactly at t=0.5 — the swap hides inside the fastest motion.
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// Pulse with a held plateau: rises 0→0.4, HOLDS 0.4→0.6 (the swap beat sits
// fully inside the hold), falls 0.6→1. Built on math.ts band().
const holdPulse = (t: number) => band(t, 0, 1, 0.4);

// Sharp in/out peak at t=0.5 with a zero-slope crest (smoothstepped triangle) —
// a brief dwell at the extreme that the swap lands in.
const peakPulse = (t: number) => smoothstep(0, 1, 1 - Math.abs(2 * t - 1));

// Write value AND target together so tick()'s per-frame ease is a no-op on the
// channel and the burst is exactly the curve authored here.
const drive = (s: SceneState, c: "aperture" | "peel", v: number) => {
  s[c] = v;
  s[`${c}Target`] = v;
};

export const TRANSITIONS: Record<TransitionName, TransitionFactory> = {
  // Whip-spin about the optical axis, whole turns only — the markings are not
  // rotationally symmetric, so finish() restores the saved rotation rather
  // than trusting float accumulation.
  twist(ctx, opts) {
    const model = ctx.model;
    const base = model.rotation.y;
    const total = Math.PI * 2 * Math.max(1, Math.round(opts.turns ?? 1));
    let written = base;
    return {
      duration: opts.durationMs ?? 420,
      swapAt: 0.5,
      update(t) {
        written = base + total * smoother(t);
        model.rotation.y = written;
      },
      finish() {
        if (model.rotation.y === written) model.rotation.y = base;
      },
    };
  },

  // THE lens-native cut: the real iris geometry snaps closed, the swap fires
  // at the fully-stopped-down beat, then it reopens — a camera blink.
  blink(ctx, opts) {
    const s = ctx.state;
    const prior = s.aperture;
    const priorTarget = s.apertureTarget;
    let written = prior;
    return {
      duration: opts.durationMs ?? 300,
      swapAt: 0.5,
      update(t) {
        written = lerp(prior, 1, holdPulse(t));
        drive(s, "aperture", written);
      },
      finish() {
        if (s.apertureTarget === written) {
          s.aperture = prior;
          s.apertureTarget = priorTarget;
        }
      },
    };
  },

  // The lens sheds its skin into the new look: a pulse into the `peel`
  // channel's staggered unroll, swap at the apex, then it re-rolls. Must stay
  // on `peel`, whose unroll is scoped to the shell cast — `assemble`'s
  // unscoped ladder translates the whole model and moves the framing under
  // the swap.
  molt(ctx, opts) {
    const s = ctx.state;
    const prior = s.peel;
    const priorTarget = s.peelTarget;
    let written = prior;
    return {
      duration: opts.durationMs ?? 450,
      swapAt: 0.5,
      update(t) {
        written = lerp(prior, 0.4, holdPulse(t));
        drive(s, "peel", written);
      },
      finish() {
        if (s.peelTarget === written) {
          s.peel = prior;
          s.peelTarget = priorTarget;
        }
      },
    };
  },

  // FOV zoom-punch: the camera lurches wide with a sharp in/out, swap at the
  // extreme. Free-orbit only — the story framing writes fov every frame, so
  // under storyMode this declines and the runner cuts instantly.
  punch(ctx, opts) {
    if (ctx.storyMode) return null;
    const cam = ctx.camera;
    const prior = cam.fov;
    let written = prior;
    return {
      duration: opts.durationMs ?? 360,
      swapAt: 0.5,
      update(t) {
        written = prior + 12 * peakPulse(t);
        cam.fov = written;
        cam.updateProjectionMatrix();
      },
      finish() {
        if (cam.fov === written) {
          cam.fov = prior;
          cam.updateProjectionMatrix();
        }
      },
    };
  },
};
