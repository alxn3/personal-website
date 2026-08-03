// CHOREOGRAPHY exploration family (wave 2): scroll animations built ONLY from
// the existing scene channels — no new shader work. Each maps the one progress
// value to channel targets, and p=0 / p=1 both land every driven channel back
// on its rest value, so each one starts from and returns to the seated lens.
// The page eases the SCRUB (lens.astro makeScrubGlide) and each frame is then a
// pure function of p, so the pulses below shape their own envelopes.
import { band, smoothstep } from "./core/math";
import {
  type LensAnimation,
  type ParamSpec,
  drive,
  invertMap,
  paramsOf,
  setParamOf,
} from "./animation-kit";
// the LIVE assemble knobs the deform host folds (ops/host recipeKnob)
import { recipeKnob } from "./ops/host";

const kStagger = recipeKnob("assemble", "stagger");
const kOverlap = recipeKnob("assemble", "overlap");
const kSplit = recipeKnob("assemble", "split");
const kSnap = recipeKnob("assemble", "snap");

// --- Heartbeat feel knobs (plain numbers, not uniforms — nothing to restore
// on exit) -------------------------------------------------------------------
let hbBeats = 3; // pulse count over the scrub, 2..5
let hbDecay = 2; // amplitude falloff exponent, 1 (lingers) .. 3 (dies fast)

// --- Domino: assemble-formation preset --------------------------------------
// enter() pushes a tiny per-shell window (high stagger, low overlap) so about
// one shell is in flight at a time. No exit(): the page resets every knob to its
// recipe default between selections (ops/host resetRecipeKnobs).
const DOMINO_STAGGER = 0.72;
const DOMINO_OVERLAP = 0.2;

const DOMINO_PARAMS: ParamSpec[] = [
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — one by one",
    u: kStagger,
    map: { k: 0.75 },
  },
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: kSplit,
    map: { b: 0.95, k: -0.8 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: kSnap,
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
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      // damped oscillation: n beats under a decaying amplitude; amp(1)=0 seats
      // the last beat even for fractional beat counts
      const beat = Math.abs(Math.sin(Math.PI * hbBeats * p));
      const amp = 0.5 * Math.pow(1 - p, hbDecay);
      drive(state, "explode", amp * beat);
      // Skin ripple riding each systole. The classic drove unwrap+curl here;
      // rollout is the surviving PURE peel (a bend, no ladder and no throw), so
      // it reproduces the "the skin lifts a little at each beat" read where
      // assemble would eject a whole rank band. Amplitude is deliberately small
      // — the ripple is a flick under the explode pulse, not a second gesture.
      drive(state, "rollout", 0.35 * amp * beat * beat * beat);
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
      drive(state, "zoom", band(p, 0, 0.35, 0.175));
      drive(state, "focus", band(p, 0.3, 0.6, 0.15));
      // stop down and hold, then release sharply in the final stretch
      drive(
        state,
        "aperture",
        Math.min(smoothstep(0.55, 0.8, p), 1 - smoothstep(0.82, 0.94, p)),
      );
      // tiny structural breath under the whole sequence (≤0.06), released at
      // the end — both factors are 0 at p=1
      drive(
        state,
        "helix",
        0.03 * (1 - Math.cos(4 * Math.PI * p)) * (1 - smoothstep(0.8, 0.96, p)),
      );
    },
  },
  {
    id: "x-slam",
    label: "Slam",
    hint: "lazy drift out — crash home",
    // Inverted teardown pacing: 80% of the scrub is a lazy drift apart, the
    // last 20% a hard cubic crash back to seated. Drift and crash share BOTH
    // channels (one envelope, `slam`, multiplies each), so the same arrangement
    // that drifted is the one that slams — a handoff mid-gesture would pop.
    // explode + assemble is the story's own teardown pairing (hero-driver): the
    // solids fan on the ladder while the sheets peel off it.
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      const slam = p < 0.8 ? 1 : 1 - Math.pow((p - 0.8) / 0.2, 3);
      drive(state, "explode", 0.85 * smoothstep(0.02, 0.78, p) * slam);
      drive(state, "assemble", 0.85 * smoothstep(0.16, 0.8, p) * slam);
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
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      drive(state, "aperture", 0);
      drive(state, "assemble", 1 - smoothstep(0, 0.9, p));
    },
    setParam: setParamOf(DOMINO_PARAMS),
    enter() {
      kStagger.value = DOMINO_STAGGER;
      kOverlap.value = DOMINO_OVERLAP;
    },
  },
  {
    id: "x-irisbloom",
    label: "Iris bloom",
    hint: "petals shut → bloom → fold home",
    apply(p, state) {
      drive(state, "zoom", 0);
      drive(state, "focus", 0);
      // the iris closes first and HOLDS as the calm centre of the bloom; it
      // reopens dead last, after everything else has folded home
      drive(
        state,
        "aperture",
        Math.min(smoothstep(0, 0.25, p), 1 - smoothstep(0.85, 1, p)),
      );
      // the bloom: shells fan out while their skins peel gently open like
      // petals, then fold back before the iris releases
      const bloom = Math.min(
        smoothstep(0.2, 0.7, p),
        1 - smoothstep(0.7, 0.92, p),
      );
      drive(state, "explode", bloom);
      // the petals: rollout is the surviving pure peel, so the skins open flat
      // in place while the explode does the fanning (the classic ran unwrap +
      // a curl release for the same read)
      drive(state, "rollout", 0.55 * bloom);
    },
  },
];
