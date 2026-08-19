// Canned showcase animations for the /lens viewer: each maps a single progress
// value (0..1) to SceneState channel targets, so the page's ONE progress slider
// scrubs a staged sequence. Adding an animation is one entry in ANIMATIONS.
import { smoothstep } from "./core/math";
import {
  type LensAnimation,
  type ParamSpec,
  drive,
  paramsOf,
  readParamOf,
  setParamOf,
} from "./animation-kit";
export type { LensAnimation } from "./animation-kit";
export { fmtParam } from "./animation-kit";
// Sliders write the LIVE recipe knobs, which are the uniforms the deform host
// folds. recipeKnob returns a CLAMPING view, so a map that would leave a
// knob's limit is clamped here too — keep the maps inside the limits or the
// slider gets a dead zone.
import { recipeKnob } from "./ops/host";

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
  // exponential: the top of the slider must be GENUINELY flat
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
  // capped at 1: past 5/3 the roll radius zeroes and the gate divides by it
  {
    id: "curl",
    label: "Curl",
    hint: "unrolled — tight roll",
    u: recipeKnob("assemble", "curl"),
    map: { k: 1 },
  },
  // the gate's window is 1 − stagger − partStagger and must stay positive, so
  // this stops under the joint cap whatever partStagger is left behind
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: recipeKnob("assemble", "stagger"),
    map: { k: 0.75 },
  },
  // inverted: more roll-on = LOWER split (the aH boundary)
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: recipeKnob("assemble", "split"),
    map: { b: 0.95, k: -0.8 },
  },
  // floored at 0.1 (the stick ramp's width) so the bottom is not a dead zone
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
  // Sector SOLO — TAU at the top is fully open (bit-exact identity); pull it
  // down to run the reassembly on one sector only.
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

// The ROSE bloom (ops/recipes.ts `rose`): a slider on every taste knob, so the
// bloom is tunable live while the progress slider scrubs the channel. Every
// default must land on an integer slider stop, or that slider pops on first
// touch. `crease`/`creasePos`/`curl` are the FOLD PATTERN.
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
    // model-mm, spanning the barrel's axial extent: the range must reach past
    // the seated station, where the lever-arm sign flips mid-piece.
    map: { b: -40, k: 100 },
  },
  // The fold-pattern pair: how hard each side crease breaks, and where the two
  // sit across the petal.
  {
    id: "crease",
    label: "Crease",
    hint: "smooth petal — hard tent",
    u: recipeKnob("rose", "crease"),
    map: { k: 2 },
  },
  // kept inside the knob's clamp, so no slider stop is dead
  {
    id: "creasePos",
    label: "Panel",
    hint: "narrow centre — broad centre",
    u: recipeKnob("rose", "creasePos"),
    map: { b: 0.1, k: 0.8 },
  },
  // mm; the width divides, so it may not reach 0. Widen past a shell's wall
  // thickness to clear the inner-surface overlap on thick panels.
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
    // anchored at the heart: deepens the dome both ways from a fixed centre
    hint: "flat nest — deep cup",
    u: recipeKnob("rose", "rise"),
    map: { k: 40 },
  },
  // bounded by the `during` window the gate derives from it
  {
    id: "stagger",
    label: "Wave",
    hint: "all at once — whorl by whorl",
    u: recipeKnob("rose", "stagger"),
    map: { k: 0.85 },
  },
];

const CORE_ANIMS: LensAnimation[] = [
  {
    id: "assemble",
    label: "Reassemble",
    hint: "flies home — sheets wrap on",
    // ONE channel: wedges start disassembled (p=0 ⇒ assemble 1) and seat home
    // by p=1. The assemble RECIPE owns every per-wedge stagger and roll-on.
    params: paramsOf(ASSEMBLE_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      // 0..0.75 smoothstep — the house bench shape
      drive(state, "assemble", 1 - smoothstep(0, 0.75, p));
    },
    setParam: setParamOf(ASSEMBLE_PARAMS),
    readParam: readParamOf(ASSEMBLE_PARAMS),
  },
];

const ROSE_ANIMS: LensAnimation[] = [
  {
    id: "x-rose",
    label: "Rose bloom",
    hint: "the origami bloom — outer whorls fall open first",
    params: paramsOf(ROSE_PARAMS),
    setParam: setParamOf(ROSE_PARAMS),
    readParam: readParamOf(ROSE_PARAMS),
    // The mechanisms COMPOSE with the bloom, so apply() must not zero them.
    manualMech: true,
    apply(p, state) {
      // straight progress — the recipe owns the whorl wave
      drive(state, "rose", p);
    },
  },
];

/** The /lens registry: the core showcase animation plus the rose bench. */
export const ANIMATIONS: LensAnimation[] = [...CORE_ANIMS, ...ROSE_ANIMS];
