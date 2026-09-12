// Public API barrel for the lens module — the only import surface for pages
// and components. Deep imports into core/, materials/, ops/ or story/ are
// internal to the module.
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
// The op deform host's live knob uniforms. Which recipes a scene folds in is
// not exposed — a page picks recipes through `SceneOptions.recipes`.
export { resetRecipeKnobs } from "./ops/host";
export { watchTheme } from "./core/theme";
export { startHeroStory } from "./story/hero-driver";
export type { HeroDriver } from "./story/hero-driver";
export { STORY, TRACK_HEIGHT_CSS, rangeOf } from "./story/story";
// Caption layout, derived from the same table the canvas reads.
export { CAPTION_FADE_CSS, bandOf } from "./story/story";
export { MODEL_URL, ACCESSORIES_URL } from "./core/model";
// Lazy on purpose: the animation families' *_PARAMS tables call recipeKnob() at
// module scope, so a static re-export would ship the whole bench in the hero's
// chunk. Type exports are erased at build, so they stay direct.
export const loadAnimations = () => import("./animations");
export type { LensAnimation } from "./animations";
