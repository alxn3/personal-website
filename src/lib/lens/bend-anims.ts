// EXPERIMENT — bendProfile bench (2026-08): the scrub-driven fold/accordion
// vocabulary bench for the curvature-profile generator, on the `bend` recipe
// channel.
import {
  type LensAnimation,
  type ParamSpec,
  drive,
  paramsOf,
  setParamOf,
} from "./animation-kit";
// the LIVE knobs the deform host folds
import { recipeKnob } from "./ops/host";

const BEND_PARAMS: ParamSpec[] = [
  {
    id: "pos",
    label: "Fold line",
    hint: "seam — far edge",
    u: recipeKnob("bend", "pos"),
    map: { k: 1 },
  },
  // fold curvature radius: 1.5mm (near-crease) .. 40mm (soft fold) — inside the
  // KNOB_LIMITS floor of 1mm (ρ is the fold's divisor)
  {
    id: "radius",
    label: "Fold radius",
    hint: "crease — soft",
    u: recipeKnob("bend", "radius"),
    map: { b: 1.5, k: 38.5 },
  },
  {
    id: "angle",
    label: "Fold angle",
    hint: "−π — +π",
    u: recipeKnob("bend", "angle"),
    map: { b: -Math.PI, k: 2 * Math.PI },
  },
  // 1 spike = a single fold; 2..3 alternating spikes = accordion pleats
  {
    id: "spikes",
    label: "Pleats",
    hint: "one fold — accordion",
    u: recipeKnob("bend", "spikes"),
    map: { b: 1, k: 2.4 },
  },
];

export const BEND_ANIMS: LensAnimation[] = [
  {
    id: "x-bend-lab",
    label: "Bend lab",
    hint: "curvature-profile fold/accordion bench",
    params: paramsOf(BEND_PARAMS),
    setParam: setParamOf(BEND_PARAMS),
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "bend", p);
    },
  },
];
