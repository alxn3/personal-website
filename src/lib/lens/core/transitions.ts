import type * as THREE from "three/webgpu";
import { band, lerp, smoothstep } from "./math";
// Type-only, so there is no runtime import cycle with scene.ts.
import type { SceneState } from "./scene";

// Shading-swap transitions: short animations that peak at the moment the
// material swap fires, then return. Each run saves what it drives and restores
// it in finish(), unless something else has written it since.

export type TransitionName = "twist" | "blink" | "molt" | "punch";

/** What a transition may touch. `model` is the gltf root (local +Y is the
 *  optical axis). */
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

/** One running transition: update(t) each frame with t in 0..1, the swap
 *  fires when t reaches swapAt, finish() runs once at the end. */
export interface TransitionRun {
  /** total length, ms */
  duration: number;
  /** progress at which the hidden material swap fires */
  swapAt: number;
  update(t: number): void;
  finish(): void;
}

/** Returns null when unavailable, and the swap happens instantly instead. */
export type TransitionFactory = (
  ctx: TransitionContext,
  opts: TransitionOpts,
) => TransitionRun | null;

// Quintic smootherstep; fastest at t = 0.5, where the swap fires.
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// Rises over 0..0.4, holds at 1 over 0.4..0.6, falls over 0.6..1.
const holdPulse = (t: number) => band(t, 0, 1, 0.4);

// Smooth peak at t = 0.5.
const peakPulse = (t: number) => smoothstep(0, 1, 1 - Math.abs(2 * t - 1));

/** Pulse channel `c` up to `peak` and back, over `durationMs`. Value and
 *  target are set together so tick()'s easing leaves the channel alone. */
function channelPulse(
  c: "aperture" | "peel",
  peak: number,
  durationMs: number,
): TransitionFactory {
  return (ctx, opts) => {
    const s = ctx.state;
    const prior = s[c];
    const priorTarget = s[`${c}Target`];
    let written = prior;
    return {
      duration: opts.durationMs ?? durationMs,
      swapAt: 0.5,
      update(t) {
        written = lerp(prior, peak, holdPulse(t));
        s[c] = written;
        s[`${c}Target`] = written;
      },
      finish() {
        if (s[`${c}Target`] === written) {
          s[c] = prior;
          s[`${c}Target`] = priorTarget;
        }
      },
    };
  };
}

export const TRANSITIONS: Record<TransitionName, TransitionFactory> = {
  // Spin whole turns about the optical axis.
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

  // Close the iris, swap while closed, reopen.
  blink: channelPulse("aperture", 1, 300),

  // Partly unroll the shell (`peel`), swap, roll it back.
  molt: channelPulse("peel", 0.4, 450),

  // Widen the fov briefly. Not in story mode, which sets fov every frame.
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
