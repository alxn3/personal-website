// Public API barrel for the lens module — the ONLY import surface for pages
// and components ("../lib/lens"). Deep imports into core/, materials/, ops/ or
// story/ are internal to the module.
export { initScene } from "./core/scene";
// Channel registry derivations, so the page can rest animation-owned channels
// to their defaults on switch/None without re-listing them.
export { CHANNEL_DEFAULTS, ANIM_RESET_CHANNELS } from "./core/scene";
export type {
  AccessoryGroup,
  ShadingMode,
  PathViz,
  TransitionName,
} from "./core/scene";
// The op deform host's live knob uniforms. WHICH recipes a scene folds in is
// not exposed: that is process-global state initScene owns, so a page picks
// recipes through `SceneOptions.recipes`.
export { resetRecipeKnobs } from "./ops/host";
export { watchTheme } from "./core/theme";
export { startHeroStory } from "./story/hero-driver";
export type { HeroDriver } from "./story/hero-driver";
export { STORY, TRACK_HEIGHT_CSS, rangeOf } from "./story/story";
// Caption LAYOUT, derived from the same table the canvas reads — see
// story/story.ts.
export { CAPTION_FADE_CSS, bandOf } from "./story/story";
export { MODEL_URL, ACCESSORIES_URL } from "./core/model";
// LAZY ON PURPOSE: the animation families' *_PARAMS tables call recipeKnob()
// at module scope, which Rollup treats as side-effectful, so a static
// re-export would ship the whole bench in the homepage hero's chunk.
// Type exports are erased at build, so they stay direct.
export const loadAnimations = () => import("./animations");
export type { LensAnimation } from "./animations";
