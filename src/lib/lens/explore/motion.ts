// ============================================================================
// The sanctioned anime.js (v4) surface for the lens DEMO/CHOREOGRAPHY layer:
// timelines, stagger, and house-tuned spring easings. DEMO LAYER ONLY — this
// module (and animejs) must never be imported by tick()/rig/materials code:
// the render loop drives eased SceneState channels and uniforms itself, and
// explore/* is /lens-only, so animejs stays out of the homepage bundle.
//
// Scrub discipline: demos are driven by a bidirectional progress scrub, so
// timelines are built with { autoplay: false } and driven via tl.seek(p ×
// tl.duration) — deterministic at any p, both directions. Autonomous playback
// (tl.play()) is never used; the page's Play button scrubs p itself.
// ============================================================================
export { createTimeline, stagger } from "animejs";
export type { Timeline } from "animejs";
import { spring, type Spring } from "animejs";

/** House spring presets (anime v4 `spring()`), for timeline `ease:` slots.
 *  NOTE: when a tween's ease is a spring, anime derives the tween's duration
 *  from the spring's settling time — the `duration` param is ignored. */
export const springs = {
  /** gentle settle, no visible overshoot ring */
  soft: (): Spring => spring({ stiffness: 90, damping: 14 }),
  /** one clean overshoot — the house "snap into place" */
  snappy: (): Spring => spring({ stiffness: 180, damping: 12 }),
  /** a couple of visible bounces — pops and releases */
  bouncy: (): Spring => spring({ stiffness: 230, damping: 9 }),
};

/**
 * A spring as a PURE scrub easing: t (0..1) → value (0 → 1, overshooting past
 * 1 on the way and settling exactly at 1). For mapping a demo's scrub segment
 * through a springy release without any autonomous playback — deterministic
 * and bidirectional by construction.
 */
export function springEaseFn(
  stiffness: number,
  damping: number,
): (t: number) => number {
  const s = spring({ stiffness, damping });
  return (t) => s.ease(Math.min(1, Math.max(0, t)));
}
