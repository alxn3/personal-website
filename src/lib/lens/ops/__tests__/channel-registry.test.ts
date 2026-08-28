import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { makeRecipes } from "../recipes";
import { RECIPE_NAMES as HOST_RECIPE_NAMES } from "../host";
import { CHANNEL_DEFAULTS } from "../../core/scene";

// THE ONE-REGISTRY CHANNEL LAW, enforced in BOTH directions (README.md's first
// law). core/scene's CHANNEL_REGISTRY is the single list of channels, and every
// MOTION channel is its op recipe's channel uniform one-for-one — there is no
// shim between them, so the two sets must agree exactly:
//
//   • a recipe with no registry row is unreachable — nothing can scrub it;
//   • a motion row with no recipe drives a channel uniform that no pipeline
//     reads, which looks like a dead slider (the failure the classic system
//     shipped for a while: a JS ladder and a shader channel moving the same
//     pieces, kept in sync by hand).
//
// The only registry rows that are NOT recipes are the three MECHANISM channels
// (zoom/focus/aperture — bespoke mechanical drives in ops/mechanism.ts, not a
// per-channel table) and `story`, the scroll fraction the hero camera reads.
// This file is the enforcement the "no other file needs an edit" claim in
// README's "Add a slider / channel" row rests on: scene.ts's driveChannels()
// bridges registry → recipeChannel by LOOPING ops/host's RECIPE_NAMES, so the
// bridge covers exactly the recipes that exist as long as that list and the
// registry agree — which is what the checks below pin, in both directions.

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
    // Pins the exemption list itself: a new mechanism channel (or a new
    // non-motion scalar) has to be added here deliberately rather than silently
    // widening the gap the check above allows.
    const rest = Object.keys(CHANNEL_DEFAULTS)
      .filter((c) => !RECIPE_NAMES.includes(c))
      .sort();
    expect(rest).toEqual([...NON_RECIPE_CHANNELS].sort());
  });

  it("the host's RECIPE_NAMES is the recipe table, and the bridge covers it", () => {
    // driveChannels() drives `RECIPE_NAMES`, not five hand-written lines, so the
    // list IS the bridge: it has to be the whole recipe table (no recipe left
    // undriven) and every name on it has to be a registry channel scene.ts can
    // read off SceneState.
    expect([...HOST_RECIPE_NAMES].sort()).toEqual(RECIPE_NAMES);
    for (const name of HOST_RECIPE_NAMES)
      expect(
        Object.prototype.hasOwnProperty.call(CHANNEL_DEFAULTS, name),
        `RECIPE_NAMES has "${name}" but CHANNEL_DEFAULTS does not — the bridge would read undefined`,
      ).toBe(true);
  });

  it("every recipe channel rests at 0 — the bit-exact seated identity", () => {
    // A motion channel's rest value is not a taste call: ops/host's hard idle
    // gate (step(1e-6, channel)) is what makes the seated render bit-exact, and
    // it only fires at exactly 0.
    for (const name of RECIPE_NAMES)
      expect(
        CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS],
        `${name} must rest at 0`,
      ).toBe(0);
  });
});
