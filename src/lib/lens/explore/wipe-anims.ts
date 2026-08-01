// EXPLORATION — wipe-family animations (2026-07 hero exploration; see
// docs/superpowers/specs/2026-07-29-animation-exploration.md in the parent
// repo dir). Each entry MUST restore every wipe/backdrop flag in exit().
//
// Every enter() below configures the FULL wipe uniform set (axis, sense,
// band, bump, feather, skew, selectors) — the wipe uniforms are shared, so a
// self-contained enter is what keeps animation switches order-independent.
import {
  type LensAnimation,
  type ParamSpec,
  paramsOf,
  setParamOf,
} from "../animation-kit";
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
  setWipeBackdrop,
} from "../materials/wipe";
import { WIPE_BACKDROPS } from "../materials/shading";

/** enter() helper: flip the wipe on with this animation's full knob set —
 *  anything not named returns to its module default. */
function wipeOn(knobs: {
  axis?: number;
  invert?: number;
  band?: number;
  bump?: number;
  feather?: number;
  skew?: number;
  gateExplode?: number;
  gateUnwrap?: number;
}): void {
  uWipeOn.value = 1;
  uWipeAxis.value = knobs.axis ?? 0;
  uWipeInvert.value = knobs.invert ?? 0;
  uWipeBand.value = knobs.band ?? 0;
  uWipeBump.value = knobs.bump ?? 0;
  uWipeFeather.value = knobs.feather ?? 8;
  uWipeSkew.value = knobs.skew ?? 0;
  uWipeExplode.value = knobs.gateExplode ?? 1;
  uWipeUnwrap.value = knobs.gateUnwrap ?? 1;
}

/** exit() helper: master off + every knob back to its module default (the
 *  identity rule makes uWipeOn = 0 sufficient for the seated render; the rest
 *  is so the /lens uniform state is boring again). */
function wipeOff(): void {
  uWipeOn.value = 0;
  uWipeAxis.value = 0;
  uWipeInvert.value = 0;
  uWipeBand.value = 0;
  uWipeBump.value = 0;
  uWipeFeather.value = 8;
  uWipeSkew.value = 0;
  uWipeExplode.value = 1;
  uWipeUnwrap.value = 1;
  setWipeBackdrop(false);
}

const REVEAL_PARAMS: ParamSpec[] = [
  // skew −0.5..0.5 (0 = horizontal line); derived default 50 ⇒ 0
  {
    id: "skew",
    label: "Skew",
    hint: "level — angled",
    u: uWipeSkew,
    map: { k: 1, b: -0.5 },
  },
  {
    id: "feather",
    label: "Feather",
    hint: "hard — soft",
    u: uWipeFeather,
    map: { k: 24 },
  },
];

const SCAN_PARAMS: ParamSpec[] = [
  {
    id: "skew",
    label: "Skew",
    hint: "level — angled",
    u: uWipeSkew,
    map: { k: 1, b: -0.5 },
  },
  {
    id: "feather",
    label: "Band width",
    hint: "thin — wide",
    u: uWipeFeather,
    map: { k: 24 },
  },
];

const SPLITFIELD_PARAMS: ParamSpec[] = [
  {
    id: "feather",
    label: "Feather",
    hint: "hard — soft",
    u: uWipeFeather,
    map: { k: 24 },
  },
];

export const WIPE_ANIMS: LensAnimation[] = [
  {
    id: "x-reveal",
    label: "Reveal",
    hint: "the line decides: seated below, torn apart above",
    params: paramsOf(REVEAL_PARAMS),
    setParam: setParamOf(REVEAL_PARAMS),
    enter() {
      // vertical sweep (bottom→top in the default /lens camera) — the sideways
      // axis-0 sweep read as chaos from the side view, and its backdrop line
      // hugged the frame edge (screenshot pick, 2026-07-29)
      wipeOn({ axis: 1 });
      setWipeBackdrop(true, WIPE_BACKDROPS.paper);
    },
    exit: wipeOff,
    apply(p, state) {
      // The channels hold a full teardown; the WIPE decides, per vertex, how
      // much of it applies — the scrub moves only the line. Curl 0.7: the torn
      // side reads as curling husks, not frame-covering flat cards
      // (screenshot pick vs curl 0, 2026-07-29).
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = 1;
      state.unwrapTarget = 1;
      state.curlTarget = 0.7;
      uWipe.value = p;
    },
  },
  {
    id: "x-ignition",
    label: "Ignition",
    hint: "ember mood: a seating front sweeps down, snapping parts home",
    enter() {
      // inverted sense: live BELOW the line, seated above — with the line
      // descending (uWipe = 1−p) the seated region grows downward and every
      // piece SNAPS home as the front passes. Small feather = the snap;
      // bump = a pressure wave right at the front.
      wipeOn({ axis: 1, invert: 1, feather: 3, bump: 0.12 });
      setWipeBackdrop(true, WIPE_BACKDROPS.ember);
    },
    exit: wipeOff,
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = 1;
      state.unwrapTarget = 0;
      state.curlTarget = 0;
      uWipe.value = 1 - p;
    },
  },
  {
    id: "x-curtain",
    label: "Curtain peel",
    hint: "shells peel open exactly at the line — nothing flies",
    enter() {
      // the wipe gates ONLY unwrap: explode stays 0, so shells peel/curl in
      // place with the peel front graduated across a wide feather
      wipeOn({ axis: 1, feather: 14, gateExplode: 0 });
    },
    exit: wipeOff,
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = 0;
      state.unwrapTarget = 1;
      state.curlTarget = 1;
      uWipe.value = p;
    },
  },
  {
    id: "x-scan",
    label: "Scan",
    hint: "x-ray palette: a band lifts shells only while passing through",
    params: paramsOf(SCAN_PARAMS),
    setParam: setParamOf(SCAN_PARAMS),
    enter() {
      // band mode: state deviates only within ±feather of the line — seated on
      // both sides. Axis 0: the slice travels ALONG the optical axis, lighting
      // up one ring of parts at a time (axis 1 cut every cylindrical shell at
      // every step — the whole model ghosted instead of a moving slice).
      wipeOn({ band: 1 });
    },
    exit: wipeOff,
    apply(p, state) {
      // unwrap ONLY — the explode channel also drives the JS-side rig ladder,
      // which the shader mask can't gate: any explode here floats rigid parts
      // for the whole scrub, breaking the seated-outside-band contract.
      // Unwrap is shader-pure, so the slice truly returns seated on both sides.
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = 0;
      state.unwrapTarget = 0.6;
      state.curlTarget = 0;
      uWipe.value = p;
    },
  },
  {
    id: "x-splitfield",
    label: "Split field",
    hint: "a static tilted zone — the scrub dips the model into deconstruction",
    params: paramsOf(SPLITFIELD_PARAMS),
    setParam: setParamOf(SPLITFIELD_PARAMS),
    enter() {
      // STATIC line (uWipe fixed, strong skew): the scrub drives the channels
      // instead — only the above-line region deconstructs, below stays seated
      wipeOn({ axis: 1, skew: 0.35 });
      uWipe.value = 0.5;
      setWipeBackdrop(true, WIPE_BACKDROPS.paper);
    },
    exit: wipeOff,
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.explodeTarget = p;
      state.unwrapTarget = 0.8 * p;
      state.curlTarget = 0.5;
      // uWipe deliberately NOT driven here — the line holds still
    },
  },
];
