import { describe, expect, it } from "vitest";
import {
  CHANNEL_EASE,
  EASE_DT_MAX_MS,
  EASE_FRAME_MS,
  easeK,
  easeStep,
} from "../scene";
import { lerp } from "../math";

// easeStep, which tick() uses for every channel: exact at 60 Hz, the same at
// any frame rate, and exactly at rest once settled.

/** frames until `|target − value|` first drops under `eps`, at `hz` */
const settleMs = (hz: number, eps = 1e-3) => {
  const dt = 1000 / hz;
  let v = 1;
  let frames = 0;
  while (Math.abs(v) >= eps && frames < 10_000) {
    v = easeStep(v, 0, dt);
    frames++;
  }
  return frames * dt;
};

describe("the channel ease", () => {
  it("is exactly CHANNEL_EASE on a 60 Hz frame — bit-for-bit what it was", () => {
    expect(easeK(EASE_FRAME_MS)).toBe(CHANNEL_EASE);
    expect(easeStep(0.5, 1, EASE_FRAME_MS)).toBe(lerp(0.5, 1, CHANNEL_EASE));
  });

  it("settles in the same wall time at 60 and 120 Hz, within one 60 Hz frame", () => {
    const t60 = settleMs(60);
    const t120 = settleMs(120);
    expect(Math.abs(t60 - t120)).toBeLessThanOrEqual(EASE_FRAME_MS);
    // …and at 30 Hz, where a per-frame constant would settle twice as slowly
    expect(Math.abs(settleMs(30) - t60)).toBeLessThanOrEqual(1000 / 30);
    // the ease is a real one: the residual halves in a few frames, not one
    expect(t60).toBeGreaterThan(10 * EASE_FRAME_MS);
  });

  it("closes the same share of the distance per unit time at any rate", () => {
    // two 120 Hz steps ARE one 60 Hz step
    const dt = EASE_FRAME_MS / 2;
    const two = easeStep(easeStep(1, 0, dt), 0, dt);
    expect(two).toBeCloseTo(easeStep(1, 0, EASE_FRAME_MS), 12);
  });

  it("lands EXACTLY on the target and then stands still", () => {
    let v = 1;
    let frames = 0;
    while (v !== 0 && frames < 10_000) {
      v = easeStep(v, 0, EASE_FRAME_MS);
      frames++;
    }
    expect(Object.is(v, 0)).toBe(true);
    expect(frames).toBeLessThan(60);
    // at rest the step changes nothing
    expect(easeStep(0, 0, EASE_FRAME_MS)).toBe(0);
    expect(easeStep(0.37, 0.37, 7)).toBe(0.37);
  });

  it("clamps a long gap so a tab coming back glides instead of snapping", () => {
    expect(easeK(EASE_DT_MAX_MS)).toBeLessThan(1);
    expect(easeStep(1, 0, EASE_DT_MAX_MS)).toBeGreaterThan(0);
  });
});
