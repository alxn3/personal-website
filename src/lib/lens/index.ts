// The lens module's public API: pages and components import only from here.
export { initScene } from "./core/scene";
export { CHANNEL_DEFAULTS, ANIM_RESET_CHANNELS } from "./core/scene";
export type {
  AccessoryGroup,
  ShadingMode,
  PathViz,
  TransitionName,
} from "./core/scene";
export { resetRecipeKnobs } from "./ops/host";
export { watchTheme } from "./core/theme";
export { startHeroStory } from "./story/hero-driver";
export type { HeroDriver } from "./story/hero-driver";
export { STORY, TRACK_HEIGHT_CSS, rangeOf } from "./story/story";
export { CAPTION_FADE_CSS, bandOf } from "./story/story";
export { MODEL_URL, ACCESSORIES_URL } from "./core/model";
// Lazy, so the animation tables stay out of the homepage bundle.
export const loadAnimations = () => import("./animations");
export type { LensAnimation } from "./animations";
