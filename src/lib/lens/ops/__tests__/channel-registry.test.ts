import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { makeRecipes } from "../recipes";
import { RECIPE_NAMES as HOST_RECIPE_NAMES } from "../host";
import { CHANNEL_DEFAULTS } from "../../core/scene";

// core/scene's channel registry must list exactly the recipes, plus the
// mechanism channels and `story` (the scroll fraction).

const RECIPE_NAMES = Object.keys(makeRecipes(NUM)).sort();
// A new non-recipe channel must be added here on purpose.
const NON_RECIPE_CHANNELS = ["zoom", "focus", "aperture", "huddle", "story"];

describe("the channel registry and the recipe set are the same list", () => {
  it("the registry is exactly the recipes plus the mechanism channels and `story`", () => {
    expect(Object.keys(CHANNEL_DEFAULTS).sort()).toEqual(
      [...RECIPE_NAMES, ...NON_RECIPE_CHANNELS].sort(),
    );
  });

  it("the host's RECIPE_NAMES is the recipe table", () => {
    // driveChannels() loops RECIPE_NAMES, so every name must be a registry channel.
    expect([...HOST_RECIPE_NAMES].sort()).toEqual(RECIPE_NAMES);
  });

  it("every recipe channel rests at 0 (exactly seated)", () => {
    for (const name of RECIPE_NAMES)
      expect(
        CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS],
        `${name} must rest at 0`,
      ).toBe(0);
  });
});
