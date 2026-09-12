import { describe, expect, it } from "vitest";
import { STORY } from "../story";

// Scene order IS the story — a reorder is a story change, not a refactor.
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

  it("a held move still has a move left to make", () => {
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
