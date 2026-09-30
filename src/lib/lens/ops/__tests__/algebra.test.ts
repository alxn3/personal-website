import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";

// NUM must follow GLSL semantics where they differ from plain JS.
describe("NUM algebra — GLSL semantics", () => {
  it.each([
    ["step is edge-inclusive", NUM.step(0.5, 0.5), 1],
    ["step is 0 below the edge", NUM.step(0.5, 0.4), 0],
    ["step is 1 above the edge", NUM.step(0.5, 0.6), 1],
    ["smoothstep is 0.5 at the midpoint", NUM.smoothstep(0, 1, 0.5), 0.5],
    ["smoothstep clamps below e0", NUM.smoothstep(0, 1, -3), 0],
    ["smoothstep clamps above e1", NUM.smoothstep(0, 1, 5), 1],
    ["mix lerps", NUM.mix(2, 4, 0.25), 2.5],
    ["mix does NOT clamp t", NUM.mix(0, 10, 2), 20],
    ["clamp caps at hi", NUM.clamp(5, 0, 1), 1],
    ["clamp floors at lo", NUM.clamp(-5, 0, 1), 0],
    ["clamp passes the inside", NUM.clamp(0.4, 0, 1), 0.4],
    ["fract is x − floor(x) for negatives", NUM.fract(-0.25), 0.75],
    ["fract of a positive", NUM.fract(2.75), 0.75],
    ["atan2 takes (y, x)", NUM.atan2(1, 0), Math.PI / 2],
    ["atan2 of the +x axis", NUM.atan2(0, 1), 0],
  ])("%s", (_, got, want) => {
    expect(got).toBe(want);
  });
});
