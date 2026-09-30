// The /lens viewer's animations: each maps a progress value (0..1) to channel
// values, plus sliders for its recipe's knobs.
import { smoothstep } from "./core/math";
import type { Channel, SceneState } from "./core/scene";
// recipeKnob clamps, so keep each map inside the knob's limits (else the
// slider has a dead zone).
import { recipeKnob } from "./ops/host";

export interface LensAnimation {
  id: string;
  label: string;
  hint?: string;
  /** Slider knobs: `value` is the slider position (0..100), `phys` the
   *  uniform's value. */
  params?: {
    id: string;
    label: string;
    hint?: string;
    value: number;
    phys: number;
  }[];
  /** Set channels for progress `p` (0..1), via `drive`. */
  apply(p: number, state: SceneState): void;
  /** Set a param from its slider position `v` (0..1). */
  setParam?(id: string, v: number): void;
  /** A param's current uniform value (after clamping). */
  readParam?(id: string): number | undefined;
  /** Leave the zoom/focus/aperture sliders to the user (don't drive them). */
  manualMech?: boolean;
  /** Called on select/deselect; exit() must undo whatever enter() did. */
  enter?(): void;
  exit?(): void;
}

/** Set a channel's value and target together (no easing). */
const drive = (st: SceneState, ch: Channel, v: number) => {
  st[ch] = v;
  st[`${ch}Target`] = v;
};

// Slider (0..1) to uniform: b + v*k, or pow^v.
type ParamMap = { k: number; b?: number } | { pow: number };
const applyMap = (m: ParamMap, v: number) =>
  "pow" in m ? Math.pow(m.pow, v) : (m.b ?? 0) + v * m.k;
const invertMap = (m: ParamMap, u: number) =>
  "pow" in m ? Math.log(u) / Math.log(m.pow) : (u - (m.b ?? 0)) / m.k;

interface ParamSpec {
  id: string;
  label: string;
  hint?: string;
  u: { value: number };
  map: ParamMap;
}

/** An animation's slider fields for a list of knobs. */
const sliders = (specs: ParamSpec[]) => ({
  params: specs.map(({ id, label, hint, u, map }) => ({
    id,
    label,
    hint,
    value: Math.round(invertMap(map, u.value) * 100),
    phys: u.value,
  })),
  setParam(id: string, v: number) {
    const spec = specs.find((s) => s.id === id);
    if (spec) spec.u.value = applyMap(spec.map, v);
  },
  readParam: (id: string) => specs.find((s) => s.id === id)?.u.value,
});

/** Three significant digits, trailing zeros dropped. */
export const fmtParam = (v: number): string => String(Number(v.toPrecision(3)));

const TAU = Math.PI * 2;

const ASSEMBLE_PARAMS: ParamSpec[] = [
  {
    id: "spread",
    label: "Throw",
    hint: "hug — thrown clear",
    u: recipeKnob("assemble", "spreadThrow"),
    map: { k: 4 },
  },
  {
    id: "sep",
    label: "Slide",
    hint: "none — drifted wide",
    u: recipeKnob("assemble", "sep"),
    map: { k: 1 },
  },
  {
    id: "swirl",
    label: "Swirl",
    hint: "straight in — orbits in",
    u: recipeKnob("assemble", "swirl"),
    map: { k: 2 },
  },
  {
    id: "rewind",
    label: "Rewind",
    hint: "settles dead — breathes out",
    u: recipeKnob("assemble", "rewind"),
    map: { k: 1.9 },
  },
  // exponential, so the top of the slider is fully flat
  {
    id: "flatten",
    label: "Flatten",
    hint: "on the barrel — flat arc",
    u: recipeKnob("assemble", "flatten"),
    map: { pow: 30 },
  },
  {
    id: "depth",
    label: "Depth",
    hint: "flat — deep stack",
    u: recipeKnob("assemble", "depth"),
    map: { k: 2 },
  },
  // capped at 1: the roll radius reaches 0 past 5/3
  {
    id: "curl",
    label: "Curl",
    hint: "unrolled — tight roll",
    u: recipeKnob("assemble", "curl"),
    map: { k: 1 },
  },
  // 1 - stagger - 0.25 must stay positive
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: recipeKnob("assemble", "stagger"),
    map: { k: 0.75 },
  },
  // inverted: more roll-on = lower split
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: recipeKnob("assemble", "split"),
    map: { b: 0.95, k: -0.8 },
  },
  // floored at 0.1 so the bottom is not a dead zone
  {
    id: "overlap",
    label: "Reel-in",
    hint: "rigid — bends home",
    u: recipeKnob("assemble", "overlap"),
    map: { b: 0.1, k: 0.9 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: recipeKnob("assemble", "snap"),
    map: { k: 1 },
  },
  // TAU = all sectors; lower it to animate one sector only
  {
    id: "maskWidth",
    label: "Sector width",
    hint: "one sector — all",
    u: recipeKnob("assemble", "maskWidth"),
    map: { k: TAU },
  },
  {
    id: "maskCenter",
    label: "Sector centre",
    hint: "−π — +π",
    u: recipeKnob("assemble", "maskCenter"),
    map: { b: -Math.PI, k: TAU },
  },
];

// The rose bloom (ops/recipes.ts `rose`). Each knob's default must land on an
// integer slider stop, or the slider jumps on first touch.
const ROSE_PARAMS: ParamSpec[] = [
  {
    id: "lift",
    label: "Lift",
    hint: "shut — laid back",
    u: recipeKnob("rose", "lift"),
    map: { k: 2 },
  },
  {
    id: "taper",
    label: "Taper",
    hint: "even — budded heart",
    u: recipeKnob("rose", "taper"),
    map: { k: 1 },
  },
  {
    id: "hinge",
    label: "Hinge",
    hint: "rear — front",
    u: recipeKnob("rose", "hinge"),
    // model mm, spanning the barrel's length
    map: { b: -40, k: 100 },
  },
  {
    id: "crease",
    label: "Crease",
    hint: "smooth petal — hard tent",
    u: recipeKnob("rose", "crease"),
    map: { k: 2 },
  },
  {
    id: "creasePos",
    label: "Panel",
    hint: "narrow centre — broad centre",
    u: recipeKnob("rose", "creasePos"),
    map: { b: 0.1, k: 0.8 },
  },
  // mm; must stay above 0
  {
    id: "band",
    label: "Crease band",
    hint: "knife — soft",
    u: recipeKnob("rose", "band"),
    map: { b: 0.6, k: 6 },
  },
  {
    id: "curl",
    label: "Flick",
    hint: "square corner — snapped fang",
    u: recipeKnob("rose", "curl"),
    map: { k: 2 },
  },
  {
    id: "base",
    label: "Base",
    hint: "hinged low — hinged high",
    u: recipeKnob("rose", "base"),
    map: { k: 0.4 },
  },
  {
    id: "facet",
    label: "Fang",
    hint: "short tab — long tab",
    u: recipeKnob("rose", "facet"),
    map: { k: 0.5 },
  },
  {
    id: "open",
    label: "Open",
    hint: "tight — blown wide",
    u: recipeKnob("rose", "open"),
    map: { k: 1.25 },
  },
  {
    id: "spin",
    label: "Spin",
    hint: "still — swirled",
    u: recipeKnob("rose", "spin"),
    map: { k: 1 },
  },
  {
    id: "rise",
    label: "Tier",
    hint: "flat nest — deep cup",
    u: recipeKnob("rose", "rise"),
    map: { k: 40 },
  },
  {
    id: "stagger",
    label: "Wave",
    hint: "all at once — whorl by whorl",
    u: recipeKnob("rose", "stagger"),
    map: { k: 0.85 },
  },
];

/** Every /lens animation. */
export const ANIMATIONS: LensAnimation[] = [
  {
    id: "assemble",
    label: "Reassemble",
    hint: "flies home — sheets wrap on",
    // p = 0 starts fully apart (assemble = 1), p = 1 is seated
    ...sliders(ASSEMBLE_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "assemble", 1 - smoothstep(0, 0.75, p));
    },
  },
  {
    id: "x-rose",
    label: "Rose bloom",
    hint: "the origami bloom — outer whorls fall open first",
    ...sliders(ROSE_PARAMS),
    manualMech: true,
    apply(p, state) {
      drive(state, "rose", p);
    },
  },
];
