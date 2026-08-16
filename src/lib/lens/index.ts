// Public API barrel for the lens module.
// Pages and components import ONLY from this barrel ("../lib/lens");
// deep imports into core/, materials/, or story/ are internal to the module.
export { initScene } from "./core/scene";
// Channel registry derivations: the page rests animation-owned channels to
// their defaults on switch/None without re-listing them (the old four-list trap).
export { CHANNEL_DEFAULTS, ANIM_RESET_CHANNELS } from "./core/scene";
export type {
  AccessoryGroup,
  ShadingMode,
  PathViz,
  TransitionName,
} from "./core/scene";
// The op deform host (ops/host.ts): the live channel/knob uniforms the pages
// scrub. WHICH recipes a scene folds in is not out here — `setActiveRecipes` is
// process-global state that initScene owns and calls in load order, so a page
// choosing recipes does it through `SceneOptions.recipes`.
export { resetRecipeKnobs } from "./ops/host";
export { watchTheme } from "./core/theme";
export { startHeroStory } from "./story/hero-driver";
export type { HeroDriver } from "./story/hero-driver";
export { STORY, TRACK_HEIGHT_CSS, rangeOf } from "./story/story";
// Caption bands: the hero's caption LAYOUT, derived from the same table the
// canvas reads. LensStory/LensSceneContent place their band elements from
// these at build time — see story/story.ts.
export { CAPTION_FADE_CSS, bandOf } from "./story/story";
export { MODEL_URL, ACCESSORIES_URL } from "./core/model";
// The /lens-only animation bench, loaded LAZILY on purpose: the animation
// families' *_PARAMS tables call recipeKnob() at module scope, which is
// side-effectful to Rollup — tree-shaking can NOT drop them from a static
// graph, so a static `ANIMATIONS` re-export shipped the whole bench layer in
// the shared chunk the homepage hero loads. Only lens.astro consumes it
// (dev/analysis.ts reaches it through its own dynamic chain).
// Type exports are erased at build, so they stay direct.
export const loadAnimations = () => import("./animations");
export type { LensAnimation } from "./animations";
