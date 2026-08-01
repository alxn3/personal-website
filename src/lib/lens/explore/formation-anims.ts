// EXPLORATION — formation-family animations (2026-07 hero exploration, wave 3):
// reassembly gestures built on the formation presets (materials/formation.ts).
// Meridian/Vortex re-time or re-shape the ASSEMBLE preset through its live
// uniforms; Drift/Materialize ride the HELIX channel. Every uniform an enter()
// or a param slider touches is captured at module load and restored in exit(),
// so selecting None always lands back on the seated render.
import { smoothstep } from "../core/math";
import {
  type LensAnimation,
  type ParamSpec,
  invertMap,
  paramsOf,
  setParamOf,
} from "../animation-kit";
import {
  uAssemblePartStagger,
  uAssembleRewind,
  uAssembleSep,
  uAssembleSnap,
  uAssembleSpread,
  uAssembleStagger,
  uAssembleSwirl,
} from "../materials/formation";
import {
  uWipe,
  uWipeOn,
  uWipeAxis,
  uWipeInvert,
  uWipeBand,
  uWipeBump,
  uWipeSkew,
  uWipeFeather,
  uWipeExplode,
  uWipeUnwrap,
  uWipeFormation,
} from "../materials/wipe";

// Module-load defaults of every assemble uniform a formation animation presets
// or exposes as a slider — the exit() restore set (same pattern as Domino's).
const DEFAULTS = {
  stagger: uAssembleStagger.value,
  partStagger: uAssemblePartStagger.value,
  snap: uAssembleSnap.value,
  swirl: uAssembleSwirl.value,
  spread: uAssembleSpread.value,
  sep: uAssembleSep.value,
  rewind: uAssembleRewind.value,
};

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
const MERIDIAN_PART_STAGGER = 0.78;
const MERIDIAN_LAYER_STAGGER = 0.06;
const MERIDIAN_PARAMS: ParamSpec[] = [
  // page-side cap 0.9 keeps the derived gate window ≥ ~0.04 (see formation.ts)
  {
    id: "sector",
    label: "Sector stagger",
    hint: "together — one sector at a time",
    u: uAssemblePartStagger,
    map: { k: 0.9 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: uAssembleSnap,
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
    u: uAssembleSwirl,
    map: { k: 12 },
  },
  {
    id: "throw",
    label: "Throw",
    hint: "hug — thrown clear",
    u: uAssembleSpread,
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
      uAssembleStagger.value = MERIDIAN_LAYER_STAGGER;
      uAssemblePartStagger.value = MERIDIAN_PART_STAGGER;
    },
    exit() {
      uAssembleStagger.value = DEFAULTS.stagger;
      uAssemblePartStagger.value = DEFAULTS.partStagger;
      uAssembleSnap.value = DEFAULTS.snap;
    },
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.assembleTarget = 1 - smoothstep(0, 0.9, p);
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
      uAssembleSwirl.value = VORTEX_PRESET.swirl;
      uAssembleSpread.value = VORTEX_PRESET.spread;
      uAssembleSep.value = VORTEX_PRESET.sep;
      uAssembleRewind.value = VORTEX_PRESET.rewind;
    },
    exit() {
      uAssembleSwirl.value = DEFAULTS.swirl;
      uAssembleSpread.value = DEFAULTS.spread;
      uAssembleSep.value = DEFAULTS.sep;
      uAssembleRewind.value = DEFAULTS.rewind;
    },
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.assembleTarget = 1 - smoothstep(0, 0.85, p);
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
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.helixTarget = driftAmount * (0.04 + 0.02 * Math.sin(TAU * p));
      state.curlTarget = 0.9;
    },
  },
  {
    id: "x-materialize",
    label: "Materialize",
    hint: "the flying model freezes solid below the rising line",
    enter() {
      // Full wipe knob set (the shared-uniform rule from wipe-anims.ts): the
      // wipe gates the FORMATION output per-vertex — below the line the helix
      // displacement is zeroed (materialized in place), above it pieces still
      // fly. Wide feather = a gradual condensation band, not a hard cut.
      // Displacement-only by choice: with no opacity hook the read is a
      // solidify FRONT (seated barrel below, material streaming back above),
      // not translucent ghosts — screenshots 2026-07-29 judged that legible
      // enough to ship without touching shading.ts.
      uWipeOn.value = 1;
      uWipeAxis.value = 1;
      uWipeInvert.value = 0;
      uWipeBand.value = 0;
      uWipeBump.value = 0;
      uWipeFeather.value = 16;
      uWipeSkew.value = 0;
      uWipeExplode.value = 1;
      uWipeUnwrap.value = 1;
      uWipeFormation.value = 1;
    },
    exit() {
      uWipeOn.value = 0;
      uWipe.value = 0;
      uWipeAxis.value = 0;
      uWipeInvert.value = 0;
      uWipeBand.value = 0;
      uWipeBump.value = 0;
      uWipeFeather.value = 8;
      uWipeSkew.value = 0;
      uWipeExplode.value = 1;
      uWipeUnwrap.value = 1;
      uWipeFormation.value = 1;
    },
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = 0;
      state.unwrapTarget = 0;
      // the helix flight and the wipe line rise together: the seated region
      // grows from the bottom exactly as the flock lands into it
      state.helixTarget = 1 - p;
      uWipe.value = p;
    },
  },
];
