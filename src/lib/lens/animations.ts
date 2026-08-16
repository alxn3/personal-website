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

// The ROSE bloom (ops/recipes.ts `rose` — the origami prototype): a slider on
// every taste knob, so the bloom is tunable live while the progress slider
// scrubs the channel. Ranges bracket the defaults with real headroom; the
// gate-feeding stagger map mirrors KNOB_LIMITS exactly (≤ 0.85), and every
// default lands on an integer slider stop (stagger 0.34 = stop 40 — the old
// 0.6 default's off-grid exception to the no-pop contract is retired).
//
// `crease`/`creasePos`/`curl` are the FOLD PATTERN — the reference photo's
// flat facets and snapped corners. `curl` is a fold ANGLE now (radians of
// reflex at the free corners), not the old rolled lip's curvature.
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
    // −40…60 model-mm: the barrel's own axial extent (y 1…76) has to be
    // reachable DEEP — the old −45…15 stopped at its first 15 mm, short of
    // the seated station (20) where the lever-arm sign flips mid-piece and
    // the tilt hinges instead of sliding.
    map: { b: -40, k: 100 },
  },
  // The FOLD PATTERN pair (ops/recipes.ts `crease`): how hard each side crease
  // breaks, and where the two of them sit across the petal.
  {
    id: "crease",
    label: "Crease",
    hint: "smooth petal — hard tent",
    u: recipeKnob("rose", "crease"),
    map: { k: 2 },
  },
  // 0.1…0.9 — inside KNOB_LIMITS' [0.05, 0.95], so the slider cannot reach the
  // clamp and no stop is dead.
  {
    id: "creasePos",
    label: "Panel",
    hint: "narrow centre — broad centre",
    u: recipeKnob("rose", "creasePos"),
    map: { b: 0.1, k: 0.8 },
  },
  // 0.6–6.6mm, KNOB_LIMITS exactly (the width divides). Default 1.2 = stop 10.
  // Narrow = knife line; widen past a shell's wall thickness to clear the
  // inner-surface overlap on thick panels.
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
    // Anchored at the heart: the slider deepens the dome BOTH ways from a
    // fixed centre — heart up, rim down (ops/recipes.ts's tier).
    hint: "flat nest — deep cup",
    u: recipeKnob("rose", "rise"),
    map: { k: 40 },
  },
  // 0..0.85 — exactly the KNOB_LIMITS range (the `during` window's own bound)
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
    // The mechanisms COMPOSE with the bloom (owner: the zoom/focus/aperture
    // sliders "are part of the animation too") — so apply() must not zero
    // them; the page keeps their sliders live.
    manualMech: true,
    apply(p, state) {
      // Straight progress, the bench law: the recipe owns the whorl wave.
      drive(state, "rose", p);
    },
  },
];

/** The /lens registry: the core showcase animation plus the rose bench. */
export const ANIMATIONS: LensAnimation[] = [...CORE_ANIMS, ...ROSE_ANIMS];
