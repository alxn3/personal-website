import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";

// These pin the GLSL semantics the NUM backend must share with the TSL
// backend: the number backend is the executable spec, so every op here must
// match what `three/tsl` computes on the GPU for the same inputs.
describe("NUM algebra — GLSL semantics", () => {
  it("step is 0 iff x < edge (edge-inclusive)", () => {
    expect(NUM.step(0.5, 0.5)).toBe(1);
    expect(NUM.step(0.5, 0.4)).toBe(0);
    expect(NUM.step(0.5, 0.6)).toBe(1);
  });

  it("smoothstep is 0.5 at the midpoint", () => {
    expect(NUM.smoothstep(0, 1, 0.5)).toBe(0.5);
  });

  it("smoothstep clamps outside [e0, e1]", () => {
    expect(NUM.smoothstep(0, 1, -3)).toBe(0);
    expect(NUM.smoothstep(0, 1, 5)).toBe(1);
  });

  it("mix lerps and does NOT clamp t", () => {
    expect(NUM.mix(2, 4, 0.25)).toBe(2.5);
    expect(NUM.mix(0, 10, 2)).toBe(20);
  });

  it("clamp bounds to [lo, hi]", () => {
    expect(NUM.clamp(5, 0, 1)).toBe(1);
    expect(NUM.clamp(-5, 0, 1)).toBe(0);
    expect(NUM.clamp(0.4, 0, 1)).toBe(0.4);
  });

  it("fract = x - floor(x) (positive for negatives)", () => {
    expect(NUM.fract(-0.25)).toBe(0.75);
    expect(NUM.fract(2.75)).toBe(0.75);
  });

  it("atan2 uses (y, x) argument order", () => {
    expect(NUM.atan2(1, 0)).toBe(Math.PI / 2);
    expect(NUM.atan2(0, 1)).toBe(0);
  });

  it("sign(0) is 0", () => {
    expect(NUM.sign(0)).toBe(0);
    expect(NUM.sign(-3)).toBe(-1);
    expect(NUM.sign(3)).toBe(1);
  });
});

describe("NUM algebra — core arithmetic", () => {
  it("lift and lit are identity on numbers", () => {
    expect(NUM.lift(3)).toBe(3);
    expect(NUM.lit(3)).toBe(3);
  });

  it("add/sub/mul/div/neg", () => {
    expect(NUM.add(2, 3)).toBe(5);
    expect(NUM.sub(2, 3)).toBe(-1);
    expect(NUM.mul(2, 3)).toBe(6);
    expect(NUM.div(6, 3)).toBe(2);
    expect(NUM.neg(3)).toBe(-3);
  });

  it("min/max", () => {
    expect(NUM.min(2, 3)).toBe(2);
    expect(NUM.max(2, 3)).toBe(3);
  });

  it("trig, pow, sqrt, floor, abs", () => {
    expect(NUM.sin(0)).toBe(0);
    expect(NUM.cos(0)).toBe(1);
    expect(NUM.pow(2, 10)).toBe(1024);
    expect(NUM.sqrt(9)).toBe(3);
    expect(NUM.floor(2.9)).toBe(2);
    expect(NUM.abs(-4)).toBe(4);
  });
});
