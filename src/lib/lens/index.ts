// Public API barrel for the lens module.
// Pages and components import ONLY from this barrel ("../lib/lens");
// deep imports into core/, materials/, or story/ are internal to the module.
export { initScene } from "./core/scene";
export type {
  AccessoryGroup,
  ShadingMode,
  PathViz,
  CameraPose,
  PartOffset,
  SwapShadingOptions,
  TransitionName,
} from "./core/scene";
export { watchTheme } from "./core/theme";
export { startHeroStory } from "./story/hero-driver";
export type { HeroDriver } from "./story/hero-driver";
export { STORY, TRACK_HEIGHT_CSS, rangeOf } from "./story/story";
export { MODEL_URL, ACCESSORIES_URL } from "./core/model";
export { ANIMATIONS, type LensAnimation } from "./animations";
// Demo compositions (camera choreo + model animation + page wipe + palette).
// Loaded LAZILY on purpose: the demo layer carries anime.js (explore/motion.ts)
// and a static re-export would drag it into the SHARED lens chunk the homepage
// hero also loads. The dynamic import splits demos + anime.js into their own
// chunk that only /lens fetches (frontmatter await is server-side/build-time).
// Type exports are erased at build, so they stay direct.
export const loadDemos = () => import("./explore/demos");
export type { LensDemo, DemoApi } from "./explore/demos";
export { setPageWipe } from "./explore/page-wipe";
export type { PageWipeCfg } from "./explore/page-wipe";
// Page-owned display/caption text layers (the "type-sandwich" — huge type behind
// the lens, caption in front), driven by demos alongside the wipe.
export { setPageText } from "./explore/page-text";
export type { PageTextCfg, TextSpec } from "./explore/page-text";
// The wipe primitive (materials/wipe.ts): split-line uniforms + the backdrop
// setter, for hero-animation authoring. WIPE_BACKDROPS pairs palettes with
// backdrop colors.
export {
  uWipe,
  uWipeSkew,
  uWipeFeather,
  uWipeOn,
  uWipeExplode,
  uWipeUnwrap,
  uWipeFormation,
  uWipeBackdrop,
  uWipeBgBelow,
  uWipeBgTo,
  setWipeBackdrop,
} from "./materials/wipe";
export { WIPE_BACKDROPS } from "./materials/shading";
// Cardify photo hook: swap a card's placeholder for a real photo by atlas tile
// (the placeholder numeral is tile + 1) — see materials/cards.ts.
export { setCardPhoto } from "./materials/cards";
