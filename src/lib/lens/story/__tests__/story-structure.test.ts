import { describe, expect, it } from "vitest";
import {
  STORY,
  atFrac,
  pulseFn,
  rangeOf,
  span,
  storyWindows,
} from "../story";
import { WINK_SPAN } from "../envelopes";

// Scene order is the story; reordering is a story change.
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

  it("holds the parked pose through the sky chapter (transit 0 must not snap)", () => {
    const fly = STORY.find((s) => s.id === "flythrough")!;
    for (const id of ["constellations", "trails"]) {
      const sc = STORY.find((s) => s.id === id)!;
      expect(sc.transit).toBe(0);
      expect(sc.cam).toEqual(fly.cam);
    }
  });
});

describe("the window registry", () => {
  it("refuses a second window under an existing name", () => {
    expect(() => span("wink", [0.1, 0.2])).toThrow(/already registered/);
    expect(storyWindows().find((w) => w.name === "wink")).toEqual({
      name: "wink",
      p0: WINK_SPAN[0],
      p1: WINK_SPAN[1],
    });
    // re-registering with the same edges is allowed
    expect(span("wink", [WINK_SPAN[0], WINK_SPAN[1]])).toEqual(WINK_SPAN);
  });

  it("refuses a pulse whose fall opens before its rise is spent", () => {
    expect(() =>
      pulseFn(
        { rise: ["zoom", 0.2, 0.8], fall: ["zoom", 0.7, 0.9] },
        "test.overlap",
      ),
    ).toThrow(/before its rise is spent/);
    expect(
      pulseFn(
        { rise: ["zoom", 0.2, 0.8], fall: ["zoom", 0.8, 0.9] },
        "test.touching",
      )(atFrac(rangeOf("zoom"), 0.5)),
    ).toBeGreaterThan(0);
  });
});
