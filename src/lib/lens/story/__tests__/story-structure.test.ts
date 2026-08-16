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

  it("fuses rewrap into capsOn, and that pair ONLY", () => {
    // A fused pair is one continuous camera move across a scene boundary. The
    // ending needs one; nothing else does, and a linked head pays for it by
    // being in motion for its whole range — it cannot park, so it cannot HOLD a
    // pose. That is why the peel→cards seam, which wants continuity as much as
    // any boundary in the story, is shaped with transits and waypoints instead:
    // the peel's nose-up settle is its scene's subject.
    expect(STORY.filter((s) => s.linkNext).map((s) => s.id)).toEqual([
      "rewrap",
    ]);
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
