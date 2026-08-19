// The animation-authoring kit: the LensAnimation contract plus the
// slider↔uniform param table every animation file shares.
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
  /** Read a param's CURRENT physical value off its uniform — the truth after
   *  knob-limit clamping, which is what the slider readout shows. */
  readParam?(id: string): number | undefined;
  /** THE MECHANISMS STAY MANUAL: the page keeps the zoom/focus/aperture
   *  sliders live while this animation is selected, so an animation that sets
   *  it MUST NOT drive those channels in apply(). */
  manualMech?: boolean;
  /** Selected/deselected. Anything turned ON in enter() MUST be turned off in
   *  exit(): the seated render has to be reachable by selecting None. */
  enter?(): void;
  exit?(): void;
}

// Slider ↔ uniform mapping, declared ONCE per param: b + v·k, or pow^v. The
// default slider position and setParam derive from the same entry, so an
// untouched slider reproduces the uniform's own default and cannot pop.
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
/** Readout format: three significant digits, trailing zeros dropped. */
export const fmtParam = (v: number): string => String(Number(v.toPrecision(3)));
