import { describe, expect, it } from "vitest";
import { STORY, rangeOf } from "../story";

// The ring (docs/superpowers/specs/2026-08-08-story-rework-design.md): scene
// order IS the story — a reorder is a story change, not a refactor.
const ORDER = [
  "hero",
  "zoom",
  "peel",
  "cards",
  "internals",
  "flythrough",
  "constellations",
  "trails",
  "rewrap",
  "capsOn",
];

describe("story structure (the ring)", () => {
  it("keeps the ring's scene order", () => {
    expect(STORY.map((s) => s.id)).toEqual(ORDER);
  });

  it("fuses rewrap into capsOn (one continuous ending move)", () => {
    expect(STORY.find((s) => s.id === "rewrap")?.linkNext).toBe(true);
  });

  it("keeps the sky chapter contiguous", () => {
    expect(rangeOf("constellations").p0).toBeCloseTo(
      rangeOf("flythrough").p1,
      10,
    );
    expect(rangeOf("trails").p0).toBeCloseTo(rangeOf("constellations").p1, 10);
  });

  it("holds the parked pose through the sky chapter (transit 0 must not snap)", () => {
    const fly = STORY.find((s) => s.id === "flythrough")!;
    for (const id of ["constellations", "trails"]) {
      const sc = STORY.find((s) => s.id === id)!;
      expect(sc.transit).toBe(0);
      expect(sc.cam).toEqual(fly.cam);
    }
  });
});
