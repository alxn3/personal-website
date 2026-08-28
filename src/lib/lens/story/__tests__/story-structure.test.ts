import { describe, expect, it } from "vitest";
import { STORY } from "../story";

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

  it("fuses NO pair — every boundary is shaped with transits and holds", () => {
    // A fused pair is one continuous camera move across a scene boundary, and
    // it costs the head its ability to park: one ease over the pair means no
    // still frame inside it. The ending is what wanted the fusion and is now
    // exactly what cannot afford it — it holds for the anticipation beat, then
    // follows the pieces down — so every seam is shaped with `camHold`,
    // transits and waypoints instead.
    expect(STORY.filter((s) => s.linkNext).map((s) => s.id)).toEqual([]);
    // …and a held move must still have a move left to make.
    for (const sc of STORY)
      if (sc.camHold !== undefined)
        expect(sc.camHold, `${sc.id} camHold`).toBeLessThan(sc.transit);
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
