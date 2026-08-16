// The animation-authoring kit: the LensAnimation contract plus the slider↔uniform
// param table shared by every animation file (animations.ts and the *-anims.ts
// families beside it).
import type { Channel, SceneState } from "./core/scene";

/** Write a channel's value AND target so a scrubbed frame is a pure function
 *  of p (the page already eases p — see lens.astro makeScrubGlide). */
export const drive = (st: SceneState, ch: Channel, v: number) => {
  st[ch] = v;
  st[`${ch}Target`] = v;
};

export interface LensAnimation {
  id: string;
  label: string;
  hint?: string;
  /** Live-tweakable shader knobs for this animation. `value` is the default
   *  slider position (0..100); `phys` is the PHYSICAL value behind it (the
   *  uniform's own unit — mm, radians, fractions — for the readout beside the
   *  slider); `setParam` receives the position normalized (0..1). */
  params?: {
    id: string;
    label: string;
    hint?: string;
    value: number;
    phys: number;
  }[];
  /** Drive channels from progress `p` (0..1) through `drive(state, …)`. May
   *  also push uniforms directly (the page invalidates after every apply). */
  apply(p: number, state: SceneState): void;
  /** Push a `params` slider (v normalized 0..1) into its backing uniform. */
  setParam?(id: string, v: number): void;
  /** Read a param's CURRENT physical value back off its uniform — the truth
   *  after KNOB_LIMITS clamping, which is what the slider readout shows and
   *  what a default worth baking looks like. */
  readParam?(id: string): number | undefined;
  /** The MECHANISMS STAY MANUAL: this animation does not drive zoom/focus/
   *  aperture, so the page keeps their Controls sliders live while it is
   *  selected — the mechanisms compose with the pose (tuning the rose with
   *  the aperture half-shut is the use case). `explode` stays
   *  animation-owned either way. An animation that sets this MUST NOT
   *  drive(zoom/focus/aperture) in apply(). */
  manualMech?: boolean;
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
    phys: u.value,
  }));
export const setParamOf = (specs: ParamSpec[]) => (id: string, v: number) => {
  const spec = specs.find((s) => s.id === id);
  if (spec) spec.u.value = applyMap(spec.map, v);
};
export const readParamOf = (specs: ParamSpec[]) => (id: string) =>
  specs.find((s) => s.id === id)?.u.value;
/** The readout format: three significant digits, trailing zeros dropped — the
 *  same number a knobDefault would be written as. */
export const fmtParam = (v: number): string => String(Number(v.toPrecision(3)));
