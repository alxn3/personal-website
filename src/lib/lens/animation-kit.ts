// The animation-authoring kit: the LensAnimation contract plus the slider↔uniform
// param table shared by every animation file (animations.ts and explore/*).
import type { SceneState } from "./core/scene";

export interface LensAnimation {
  id: string;
  label: string;
  hint?: string;
  /** Live-tweakable shader knobs for this animation. `value` is the default
   *  slider position (0..100); `setParam` receives it normalized (0..1). */
  params?: { id: string; label: string; hint?: string; value: number }[];
  /** Set `state.<channel>Target` values from progress `p` (0..1). May also push
   *  uniforms directly (the page invalidates after every apply). */
  apply(p: number, state: SceneState): void;
  /** Push a `params` slider (v normalized 0..1) into its backing uniform. */
  setParam?(id: string, v: number): void;
  /** Lifecycle: called when the animation is selected/deselected. Anything an
   *  animation turns ON here (wipe, backdrop, palettes) it MUST turn off in
   *  exit() — the seated render must be reachable from any animation by
   *  selecting None. */
  enter?(): void;
  exit?(): void;
}

// Slider ↔ uniform mapping, declared ONCE per param: uniform = b + v·k (linear)
// or pow^v (exponential). Both the default slider position and setParam derive
// from the same table, so an untouched slider always reproduces its uniform's
// own default and the first touch can never pop.
export type ParamMap = { k: number; b?: number } | { pow: number };
export const applyMap = (m: ParamMap, v: number) =>
  "pow" in m ? Math.pow(m.pow, v) : (m.b ?? 0) + v * m.k;
export const invertMap = (m: ParamMap, u: number) =>
  "pow" in m ? Math.log(u) / Math.log(m.pow) : (u - (m.b ?? 0)) / m.k;

export interface ParamSpec {
  id: string;
  label: string;
  hint?: string;
  u: { value: number };
  map: ParamMap;
}

export const paramsOf = (specs: ParamSpec[]) =>
  specs.map(({ id, label, hint, u, map }) => ({
    id,
    label,
    hint,
    value: Math.round(invertMap(map, u.value) * 100),
  }));
export const setParamOf = (specs: ParamSpec[]) => (id: string, v: number) => {
  const spec = specs.find((s) => s.id === id);
  if (spec) spec.u.value = applyMap(spec.map, v);
};
