// Canned showcase animations for the /lens viewer: each maps a single progress
// value (0..1) to SceneState channel targets, so the page's ONE progress slider
// scrubs a staged sequence. Adding an animation is one entry in ANIMATIONS.
import { smoothstep } from "./core/math";
import {
  type LensAnimation,
  type ParamSpec,
  drive,
  paramsOf,
  setParamOf,
} from "./animation-kit";
import { CHOREO_ANIMS } from "./choreo-anims";
import { FORMATION_ANIMS } from "./formation-anims";
import { BEND_ANIMS } from "./bend-anims";

export type { LensAnimation } from "./animation-kit";
// Sliders write the LIVE recipe knobs (ops/host recipeKnob), which are the
// uniforms the deform host folds. recipeKnob hands back a CLAMPING view where
// KNOB_LIMITS applies, so a map below that would leave the limit is clamped to
// it here as well (a slider must not have a dead zone).
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
  // exponential: the top of the slider must be GENUINELY flat (~30R — a linear
  // multiplier capped low never straightens the arc)
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
  // 0..1 — KNOB_LIMITS caps curl at 1 (past 5/3 the roll radius zeroes and the
  // gate divides by it), which the slider top already sits on.
  {
    id: "curl",
    label: "Curl",
    hint: "unrolled — tight roll",
    u: recipeKnob("assemble", "curl"),
    map: { k: 1 },
  },
  // 0..0.75 — the gate derives its window as 1 − stagger − partStagger, which
  // must stay positive (ops/host JOINT_SUMS caps the PAIR at 0.9; this stays
  // under it whatever partStagger a formation preset left behind)
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: recipeKnob("assemble", "stagger"),
    map: { k: 0.75 },
  },
  // more roll-on = LOWER split (the aH boundary): 0.95 .. 0.15 — exactly the
  // KNOB_LIMITS split range
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: recipeKnob("assemble", "split"),
    map: { b: 0.95, k: -0.8 },
  },
  // 0.1..1, NOT 0..1: KNOB_LIMITS floors overlap at 0.1 (the stick ramp's
  // width, rollEnd 0.9 − split 0.95 + overlap), so the slider bottom is moved
  // onto the floor rather than clamping the bottom tenth into a dead zone.
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
  // Sector SOLO — width at the top (TAU) is fully open (bit-exact identity);
  // pull it down to run the reassembly on one sector only.
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

const HELIX_PARAMS: ParamSpec[] = [
  {
    id: "turns",
    label: "Turns",
    hint: "½ — 1¼ turns",
    u: recipeKnob("helix", "turns"),
    map: { k: 1.5 },
  },
  {
    id: "spread",
    label: "Spread",
    hint: "tight — wide",
    u: recipeKnob("helix", "spread"),
    map: { k: 1 },
  },
  // magnitude slider → the NEGATIVE rearward value (v=0.45 ⇒ −45mm)
  {
    id: "approach",
    label: "Approach",
    hint: "flush — deep rear",
    u: recipeKnob("helix", "approach"),
    map: { k: -100 },
  },
  // more bend = tighter coil, 1..0.3
  {
    id: "bend",
    label: "Bend",
    hint: "gentle — tight coil",
    u: recipeKnob("helix", "coil"),
    map: { b: 1, k: -0.7 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: recipeKnob("helix", "snap"),
    map: { k: 1 },
  },
  // slider 0..1 → 0..12mm
  {
    id: "hover",
    label: "Hover",
    hint: "flush — floating",
    u: recipeKnob("helix", "hover"),
    map: { k: 12 },
  },
];

const ROLLOUT_PARAMS: ParamSpec[] = [
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: recipeKnob("rollout", "stagger"),
    map: { k: 0.75 },
  },
  // Sector solo — top (TAU) fully open (bit-exact identity), pull down to unroll
  // one sector only.
  {
    id: "sectorWidth",
    label: "Sector width",
    hint: "one sector — all",
    u: recipeKnob("rollout", "maskWidth"),
    map: { k: TAU },
  },
  {
    id: "sectorCenter",
    label: "Sector centre",
    hint: "−π — +π",
    u: recipeKnob("rollout", "maskCenter"),
    map: { b: -Math.PI, k: TAU },
  },
  // Rank band — lo 0 / hi 1 fully open; narrow it to roll out a subset of shells.
  {
    id: "rankLo",
    label: "Rank low",
    hint: "inner — outer",
    u: recipeKnob("rollout", "rankLo"),
    map: { k: 1 },
  },
  {
    id: "rankHi",
    label: "Rank high",
    hint: "inner — outer",
    u: recipeKnob("rollout", "rankHi"),
    map: { k: 1 },
  },
];

// The SCRATCH bench (ops/recipes.ts `scratch`): the owner's directly-editable
// pipeline, with a slider on each of its three knobs. Rename or re-purpose a
// knob in the recipe and this table follows — that pair of edits IS the bench.
const SCRATCH_PARAMS: ParamSpec[] = [
  {
    id: "spread",
    label: "Spread",
    hint: "hug — thrown clear",
    u: recipeKnob("scratch", "spread"),
    map: { k: 2 },
  },
  {
    id: "turn",
    label: "Turn",
    hint: "−π — +π",
    u: recipeKnob("scratch", "turn"),
    map: { b: -Math.PI, k: TAU },
  },
  {
    id: "depth",
    label: "Depth",
    hint: "flat — deep stack",
    u: recipeKnob("scratch", "depth"),
    map: { k: 2 },
  },
];

const CORE_ANIMS: LensAnimation[] = [
  {
    id: "assemble",
    label: "Reassemble",
    hint: "flies home — sheets wrap on",
    // ONE channel: the wedges start fully disassembled (p=0 ⇒ assemble 1) and
    // seat home by p=1. The assemble RECIPE (ops/recipes.ts) owns every
    // per-wedge stagger, flatten and wrap roll-on — nothing else is driven
    // here. Live knobs come from the ASSEMBLE_PARAMS table.
    params: paramsOf(ASSEMBLE_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      // 0..0.75 smoothstep — the house bench shape
      drive(state, "assemble", 1 - smoothstep(0, 0.75, p));
    },
    setParam: setParamOf(ASSEMBLE_PARAMS),
  },
  {
    id: "helix",
    label: "Helix assemble",
    hint: "spiral in — unbend home",
    // Live feel knobs come from the HELIX_PARAMS table.
    params: paramsOf(HELIX_PARAMS),
    apply(p, state) {
      // ONE channel: the wedges start fully spread (p=0 ⇒ helix 1) and assemble
      // home by p=1. The helix RECIPE (ops/recipes.ts) owns every per-wedge
      // stagger, snap and over-coil — nothing else is driven here.
      drive(state, "helix", 1 - p);
    },
    setParam: setParamOf(HELIX_PARAMS),
  },
  {
    id: "rollout",
    label: "Roll-out",
    hint: "unrolls flat — a carpet",
    // ONE channel: the wedges start rolled out flat (p=0 ⇒ rollout 1) and roll
    // back home by p=1. The rollout RECIPE (ops/recipes.ts) owns the
    // per-wedge stagger and the rolling-contact geometry; live knobs (stagger,
    // sector/rank masks) come from ROLLOUT_PARAMS.
    params: paramsOf(ROLLOUT_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "rollout", 1 - p);
    },
    setParam: setParamOf(ROLLOUT_PARAMS),
  },
];

const SCRATCH_ANIMS: LensAnimation[] = [
  {
    id: "x-scratch",
    label: "Scratch",
    hint: "the editable bench — ops/recipes.ts `scratch`",
    params: paramsOf(SCRATCH_PARAMS),
    setParam: setParamOf(SCRATCH_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      // Straight progress, no shaping: a bench shows the recipe's own law.
      drive(state, "scratch", p);
    },
  },
];

/** The /lens registry: core showcase animations + the exploration families
 *  (each family owns its file under explore/). */
export const ANIMATIONS: LensAnimation[] = [
  ...CORE_ANIMS,
  ...CHOREO_ANIMS,
  ...FORMATION_ANIMS,
  ...BEND_ANIMS,
  ...SCRATCH_ANIMS,
];
