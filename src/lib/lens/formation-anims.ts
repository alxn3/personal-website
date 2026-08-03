// EXPLORATION — formation-family animations (2026-07 hero exploration, wave 3):
// reassembly gestures built on the formation presets. Meridian/Vortex re-time
// or re-shape the ASSEMBLE recipe through its live knobs; Drift rides the
// HELIX channel. Every knob an enter() or a param slider touches is put back on
// its recipe default by the page between selections (ops/host resetRecipeKnobs),
// so selecting None always lands back on the seated render and no animation
// carries a hand-kept restore list.
import { smoothstep } from "./core/math";
import {
  type LensAnimation,
  type ParamSpec,
  drive,
  invertMap,
  paramsOf,
  setParamOf,
} from "./animation-kit";
// the LIVE assemble knobs the deform host folds (ops/host recipeKnob).
// recipeKnob's views CLAMP to KNOB_LIMITS, so every preset and slider range
// below is expressed inside the limit rather than written past it.
import { recipeKnob } from "./ops/host";

const kStagger = recipeKnob("assemble", "stagger");
const kPartStagger = recipeKnob("assemble", "partStagger");
const kSnap = recipeKnob("assemble", "snap");
const kSwirl = recipeKnob("assemble", "swirl");
const kSpread = recipeKnob("assemble", "spreadThrow");
const kSep = recipeKnob("assemble", "sep");
const kRewind = recipeKnob("assemble", "rewind");

/** paramsOf reads each uniform's module-load value, but these animations preset
 *  their uniforms in enter() — patch the named sliders so an untouched slider
 *  reproduces the ACTIVE uniform value (the Domino fix, generalized). */
const patchDefaults = (
  specs: ParamSpec[],
  presets: Record<string, number>,
): LensAnimation["params"] =>
  paramsOf(specs).map((prm) => {
    const preset = presets[prm.id];
    if (preset === undefined) return prm;
    const spec = specs.find((s) => s.id === prm.id)!;
    return { ...prm, value: Math.round(invertMap(spec.map, preset) * 100) };
  });

// --- Meridian sweep ----------------------------------------------------------
// Sector-dominant stagger: the per-wedge phase term (fract(t0/TAU)) dwarfs the
// per-shell rank term, so the assemble window sweeps AROUND the barrel like a
// radar arm instead of inner→outer.
// The pair (0.06 + 0.78) is reachable because ops/host enforces
// `stagger + partStagger ≤ 0.9` JOINTLY instead of splitting it into two
// conservative per-knob halves. The joint clamp is order-dependent — it caps the
// value being written against the partner's current one — so enter() writes the
// SMALL knob (stagger, down from 0.6) first; reversed, the second write clips.
// (The way back is `resetRecipeKnobs`, which zeroes the pair before restoring.)
const MERIDIAN_PART_STAGGER = 0.78;
const MERIDIAN_LAYER_STAGGER = 0.06;
const MERIDIAN_PARAMS: ParamSpec[] = [
  // slider top = the joint ceiling (0.9), so the preset's 0.78 sits high in the
  // range instead of pinning the top; the last sliver is clipped by the live
  // stagger (0.9 − 0.06 = 0.84 under the preset).
  {
    id: "sector",
    label: "Sector stagger",
    hint: "together — one sector at a time",
    u: kPartStagger,
    map: { k: 0.9 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: kSnap,
    map: { k: 1 },
  },
];

// --- Vortex ------------------------------------------------------------------
// Swirl-dominant assemble: the orbit term dwarfs the throw, so the fly-in reads
// as sheets spiralling home around the axis.
const VORTEX_PRESET = { swirl: 2.4, spread: 0.9, sep: 0.25, rewind: 0.4 };
const VORTEX_PARAMS: ParamSpec[] = [
  // wide range: 2π·1.5 ≈ 9.4 rad is what an actual 1.5-turn orbit needs on the
  // mid ranks — the core slider's 0..2 never gets near an orbital read
  {
    id: "swirl",
    label: "Swirl",
    hint: "straight in — orbits in",
    u: kSwirl,
    map: { k: 12 },
  },
  {
    id: "throw",
    label: "Throw",
    hint: "hug — thrown clear",
    u: kSpread,
    map: { k: 4 },
  },
];

// --- Drift -------------------------------------------------------------------
// Feel knob, plain number (nothing to restore on exit).
let driftAmount = 1; // 0..2 scale on the hover amplitude

const TAU = Math.PI * 2;

export const FORMATION_ANIMS: LensAnimation[] = [
  {
    id: "x-meridian",
    label: "Meridian sweep",
    hint: "the reassembly sweeps around the barrel — a radar arm",
    params: patchDefaults(MERIDIAN_PARAMS, {
      sector: MERIDIAN_PART_STAGGER,
    }),
    setParam: setParamOf(MERIDIAN_PARAMS),
    enter() {
      // stagger DOWN first, then partStagger up — the joint clamp order (above)
      kStagger.value = MERIDIAN_LAYER_STAGGER;
      kPartStagger.value = MERIDIAN_PART_STAGGER;
    },
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "assemble", 1 - smoothstep(0, 0.9, p));
    },
  },
  {
    id: "x-vortex",
    label: "Vortex",
    hint: "sheets spiral home around the axis",
    params: patchDefaults(VORTEX_PARAMS, {
      swirl: VORTEX_PRESET.swirl,
      throw: VORTEX_PRESET.spread,
    }),
    setParam: setParamOf(VORTEX_PARAMS),
    enter() {
      kSwirl.value = VORTEX_PRESET.swirl;
      kSpread.value = VORTEX_PRESET.spread;
      kSep.value = VORTEX_PRESET.sep;
      kRewind.value = VORTEX_PRESET.rewind;
    },
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "assemble", 1 - smoothstep(0, 0.85, p));
    },
  },
  {
    id: "x-drift",
    label: "Drift",
    hint: "ambient micro-hover — deliberately never seats",
    params: [
      { id: "amount", label: "Amount", hint: "still — floating", value: 50 },
    ],
    setParam(id, v) {
      if (id === "amount") driftAmount = 2 * v;
    },
    // DELIBERATE EXCEPTION to the seats-at-p=1 convention: this is an ambient
    // idle gesture, not a story beat — the hover breathes with p and ends still
    // FLOATING (helix 0.04 at both ends). Deselecting restores the seated
    // render through the page's channel reset, so the lifecycle law still holds.
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "helix", driftAmount * (0.04 + 0.02 * Math.sin(TAU * p)));
    },
  },
];
