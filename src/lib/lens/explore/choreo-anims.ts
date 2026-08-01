// CHOREOGRAPHY exploration family (wave 2): scroll animations built ONLY from
// the existing scene channels — no new shader work. Each maps the one progress
// value to channel targets, and p=0 / p=1 both land every driven channel back
// on its rest value, so each one starts from and returns to the seated lens.
// Channels ease toward targets (~0.12/frame), so rapid target moves read as
// smoothed bounces — the pulses below lean on that.
import { band, smoothstep } from "../core/math";
import {
  type LensAnimation,
  type ParamSpec,
  invertMap,
  paramsOf,
  setParamOf,
} from "../animation-kit";
import {
  uAssembleOverlap,
  uAssembleSnap,
  uAssembleSplit,
  uAssembleStagger,
} from "../materials/formation";

// --- Heartbeat feel knobs (plain numbers, not uniforms — nothing to restore
// on exit) -------------------------------------------------------------------
let hbBeats = 3; // pulse count over the scrub, 2..5
let hbDecay = 2; // amplitude falloff exponent, 1 (lingers) .. 3 (dies fast)

// --- Domino: assemble-formation preset + restore values ---------------------
// enter() pushes a tiny per-shell window (high stagger, low overlap) so about
// one shell is in flight at a time; exit() restores the formation defaults,
// captured here at module load.
const DOMINO_STAGGER = 0.72;
const DOMINO_OVERLAP = 0.2;
const ASSEMBLE_DEFAULTS = {
  stagger: uAssembleStagger.value,
  overlap: uAssembleOverlap.value,
  split: uAssembleSplit.value,
  snap: uAssembleSnap.value,
};

const DOMINO_PARAMS: ParamSpec[] = [
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — one by one",
    u: uAssembleStagger,
    map: { k: 0.75 },
  },
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: uAssembleSplit,
    map: { b: 0.95, k: -0.8 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: uAssembleSnap,
    map: { k: 1 },
  },
];
// paramsOf reads each uniform's module-load value, but Domino's stagger
// default is its enter() preset, not the formation default — patch that
// slider so an untouched slider still reproduces the active uniform value.
const DOMINO_PARAM_DEFAULTS = paramsOf(DOMINO_PARAMS).map((prm) =>
  prm.id === "stagger"
    ? {
        ...prm,
        value: Math.round(invertMap({ k: 0.75 }, DOMINO_STAGGER) * 100),
      }
    : prm,
);

export const CHOREO_ANIMS: LensAnimation[] = [
  {
    id: "x-heartbeat",
    label: "Heartbeat",
    hint: "pulses — every beat softer",
    // slider defaults reproduce the hbBeats/hbDecay values above
    params: [
      { id: "beats", label: "Beats", hint: "2 — 5", value: 33 },
      { id: "decay", label: "Decay", hint: "lingers — dies fast", value: 50 },
    ],
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      // damped oscillation: n beats under a decaying amplitude; amp(1)=0 seats
      // the last beat even for fractional beat counts
      const beat = Math.abs(Math.sin(Math.PI * hbBeats * p));
      const amp = 0.5 * Math.pow(1 - p, hbDecay);
      state.explodeTarget = amp * beat;
      // skin ripple riding each systole — without a little unwrap the curl
      // flick below is invisible (curl only shapes PEELED material)
      state.unwrapTarget = 0.7 * amp * beat * beat * beat;
      // curl sits relaxed between beats and snaps tight (toward its rest, 1)
      // at each peak; the band envelope pins it to rest at both ends
      const peak = Math.pow(beat, 8);
      state.curlTarget = 1 - 0.65 * band(p, 0, 1, 0.1) * (1 - peak);
    },
    setParam(id, v) {
      if (id === "beats") hbBeats = 2 + 3 * v;
      else if (id === "decay") hbDecay = 1 + 2 * v;
    },
  },
  {
    id: "x-clockwork",
    label: "Clockwork",
    hint: "zoom → focus → stop → snap shut — blueprint",
    // The lens operating itself: each mechanism runs ALONE, in strict order,
    // then the whole machine snaps back to rest.
    apply(p, state) {
      state.zoomTarget = band(p, 0, 0.35, 0.175);
      state.focusTarget = band(p, 0.3, 0.6, 0.15);
      // stop down and hold, then release sharply in the final stretch
      state.apertureTarget = Math.min(
        smoothstep(0.55, 0.8, p),
        1 - smoothstep(0.82, 0.94, p),
      );
      // tiny structural breath under the whole sequence (≤0.06), released at
      // the end — both factors are 0 at p=1
      state.helixTarget =
        0.03 * (1 - Math.cos(4 * Math.PI * p)) * (1 - smoothstep(0.8, 0.96, p));
    },
  },
  {
    id: "x-slam",
    label: "Slam",
    hint: "lazy drift out — crash home",
    // Inverted teardown pacing: 80% of the scrub is a lazy drift apart, the
    // last 20% a hard cubic crash back to seated. Drift and crash share the
    // explode/unwrap channels (rather than routing the return through the
    // assemble formation) so the SAME arrangement that drifted is the one
    // that slams — a formation handoff mid-gesture would pop.
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      const slam = p < 0.8 ? 1 : 1 - Math.pow((p - 0.8) / 0.2, 3);
      state.explodeTarget = 0.85 * smoothstep(0.02, 0.78, p) * slam;
      state.unwrapTarget = 0.85 * smoothstep(0.16, 0.8, p) * slam;
      // curl lets go late in the drift; the crash re-tightens it to rest
      state.curlTarget = 1 - 0.6 * smoothstep(0.45, 0.85, p) * slam;
    },
  },
  {
    id: "x-domino",
    label: "Domino",
    hint: "one shell at a time — cascade home",
    params: DOMINO_PARAM_DEFAULTS,
    // ONE channel: the formation preset (pushed in enter) owns the cascade —
    // per-shell timing comes entirely from the stagger/overlap window.
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.assembleTarget = 1 - smoothstep(0, 0.9, p);
    },
    setParam: setParamOf(DOMINO_PARAMS),
    enter() {
      uAssembleStagger.value = DOMINO_STAGGER;
      uAssembleOverlap.value = DOMINO_OVERLAP;
    },
    exit() {
      uAssembleStagger.value = ASSEMBLE_DEFAULTS.stagger;
      uAssembleOverlap.value = ASSEMBLE_DEFAULTS.overlap;
      uAssembleSplit.value = ASSEMBLE_DEFAULTS.split;
      uAssembleSnap.value = ASSEMBLE_DEFAULTS.snap;
    },
  },
  {
    id: "x-irisbloom",
    label: "Iris bloom",
    hint: "petals shut → bloom → fold home — toon",
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      // the iris closes first and HOLDS as the calm centre of the bloom; it
      // reopens dead last, after everything else has folded home
      state.apertureTarget = Math.min(
        smoothstep(0, 0.25, p),
        1 - smoothstep(0.85, 1, p),
      );
      // the bloom: shells fan out while their skins peel gently open like
      // petals, then fold back before the iris releases
      const bloom = Math.min(
        smoothstep(0.2, 0.7, p),
        1 - smoothstep(0.7, 0.92, p),
      );
      state.explodeTarget = bloom;
      state.unwrapTarget = 0.55 * bloom;
      // curl rides the bloom as a deviation from its rest (1 = tight roll):
      // it relaxes toward a flat open petal at full bloom and re-tightens home
      state.curlTarget = 1 - 0.8 * bloom;
    },
  },
];
