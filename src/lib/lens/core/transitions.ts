import type * as THREE from "three/webgpu";
import { band, lerp, smoothstep } from "./math";
// Type-only — erased at build, so no runtime cycle with the orchestrator.
import type { SceneState } from "./scene";

// ============================================================================
// Look-swap transitions: short rAF choreographies that make a shading change
// feel like ONE sharp gesture. Each entry drives EXISTING objects/channels
// (model roll, iris, a recipe channel, camera fov — never new shader graphs) toward a
// hidden/peak moment, where the runner (scene.swapShading) fires the instant
// wholesale material rebuild, then eases home. The cut lands inside the
// fastest/most-occluded beat, so it reads as part of the motion.
//
// Contract per run: snapshot everything you drive at creation, restore it
// BIT-EXACTLY in finish() — but only where your write is still the last one
// (compare against the value you last wrote), so a slider/demo that grabbed
// the channel mid-burst is never clobbered. While running, last-writer-wins
// per frame is acceptable for these ~300-450ms bursts.
// ============================================================================

export type TransitionName = "twist" | "blink" | "molt" | "punch";

/** What a transition may touch. `model` is the gltf root — its local +Y is the
 *  optical axis, and rolling about it is rig-safe (see scene.ts). */
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

// Drive a channel by writing value AND target together: tick()'s per-frame
// ease (lerp toward target) then becomes a no-op on that channel regardless of
// callback order, so the burst is exactly the curve authored here.
const drive = (s: SceneState, c: "aperture" | "rollout", v: number) => {
  s[c] = v;
  s[`${c}Target`] = v;
};

export const TRANSITIONS: Record<TransitionName, TransitionFactory> = {
  // Whip-spin about the optical axis: an integer number of turns, so the model
  // lands back on its EXACT starting orientation (the markings are not
  // rotationally symmetric — finish() restores the saved rotation rather than
  // trusting float accumulation).
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

  // The lens sheds its skin into the new look: a fast pulse into rollout's
  // staggered unroll wave — the shells peel open in rank order, in place — with
  // the swap at the apex (the peel IS the reveal), then everything re-rolls.
  // Amplitude 0.4 is a judgment call. assemble was tried and rejected: its unscoped ladder TRANSLATES the whole model, which
  // breaks the Lookbook demo's fixed framing.
  molt(ctx, opts) {
    const s = ctx.state;
    const prior = s.rollout;
    const priorTarget = s.rolloutTarget;
    let written = prior;
    return {
      duration: opts.durationMs ?? 450,
      swapAt: 0.5,
      update(t) {
        written = lerp(prior, 0.4, holdPulse(t));
        drive(s, "rollout", written);
      },
      finish() {
        if (s.rolloutTarget === written) {
          s.rollout = prior;
          s.rolloutTarget = priorTarget;
        }
      },
    };
  },

  // FOV zoom-punch: the camera lurches wide (+12°) with a sharp in/out, swap
  // at the extreme. Free-orbit only — the story/hero framing writes fov every
  // frame and owns the camera, so under storyMode this declines (instant swap).
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
