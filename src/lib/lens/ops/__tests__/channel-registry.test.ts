import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { makeRecipes } from "../recipes";
import { RECIPE_NAMES as HOST_RECIPE_NAMES } from "../host";
import { CHANNEL_DEFAULTS } from "../../core/scene";

// THE ONE-REGISTRY CHANNEL LAW, in both directions: core/scene's
// CHANNEL_REGISTRY is the single list of channels and every MOTION channel is
// its op recipe's channel uniform one-for-one, so the two sets must agree
// exactly. The only non-recipe rows are the mechanism channels
// (zoom/focus/aperture/huddle) and `story`, the scroll fraction.

const RECIPE_NAMES = Object.keys(makeRecipes(NUM)).sort();
const NON_RECIPE_CHANNELS = ["zoom", "focus", "aperture", "huddle", "story"];

describe("the channel registry and the recipe set are the same list", () => {
  it("every recipe has a registry row", () => {
    for (const name of RECIPE_NAMES)
      expect(
        Object.prototype.hasOwnProperty.call(CHANNEL_DEFAULTS, name),
        `recipe "${name}" has no CHANNEL_REGISTRY row — nothing can scrub it`,
      ).toBe(true);
  });

  it("every registry row but the mechanism channels and `story` is a recipe", () => {
    const motion = Object.keys(CHANNEL_DEFAULTS)
      .filter((c) => !NON_RECIPE_CHANNELS.includes(c))
      .sort();
    expect(motion).toEqual(RECIPE_NAMES);
  });

  it("the non-recipe rows are exactly the mechanism channels plus `story`", () => {
    // Pins the exemption list itself, so a new non-recipe channel has to be
    // added here deliberately.
    const rest = Object.keys(CHANNEL_DEFAULTS)
      .filter((c) => !RECIPE_NAMES.includes(c))
      .sort();
    expect(rest).toEqual([...NON_RECIPE_CHANNELS].sort());
  });

  it("the host's RECIPE_NAMES is the recipe table, and the bridge covers it", () => {
    // driveChannels() loops RECIPE_NAMES, so the list IS the bridge: it must be
    // the whole recipe table and every name on it a registry channel.
    expect([...HOST_RECIPE_NAMES].sort()).toEqual(RECIPE_NAMES);
    for (const name of HOST_RECIPE_NAMES)
      expect(
        Object.prototype.hasOwnProperty.call(CHANNEL_DEFAULTS, name),
        `RECIPE_NAMES has "${name}" but CHANNEL_DEFAULTS does not — the bridge would read undefined`,
      ).toBe(true);
  });

  it("every recipe channel rests at 0 — the bit-exact seated identity", () => {
    // ops/host's idle gate — step(1e-6, channel) — fires only at exactly 0.
    for (const name of RECIPE_NAMES)
      expect(
        CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS],
        `${name} must rest at 0`,
      ).toBe(0);
  });
});
