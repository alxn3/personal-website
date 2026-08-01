// Canned showcase animations for the /lens viewer: each maps a single progress
// value (0..1) to SceneState channel targets, so the page's ONE progress slider
// scrubs a staged sequence. Adding an animation is one entry in ANIMATIONS.
import { smoothstep } from "./core/math";
import {
  type LensAnimation,
  type ParamSpec,
  paramsOf,
  setParamOf,
} from "./animation-kit";
import { WIPE_ANIMS } from "./explore/wipe-anims";
import { CHOREO_ANIMS } from "./explore/choreo-anims";
import { FORMATION_ANIMS } from "./explore/formation-anims";

export type { LensAnimation } from "./animation-kit";
import {
  uHelixTurns,
  uHelixSpread,
  uHelixApproach,
  uHelixCoil,
  uHelixSnap,
  uHelixHover,
  uAssembleSpread,
  uAssembleFlatten,
  uAssembleDepth,
  uAssembleCurl,
  uAssembleSnap,
  uAssembleStagger,
  uAssembleSplit,
  uAssembleOverlap,
  uAssembleSep,
  uAssembleSwirl,
  uAssembleRewind,
  uAssembleMaskCenter,
  uAssembleMaskWidth,
  uRolloutStagger,
  uRolloutMaskCenter,
  uRolloutMaskWidth,
  uRolloutRankLo,
  uRolloutRankHi,
} from "./materials/formation";

const TAU = Math.PI * 2;

const ASSEMBLE_PARAMS: ParamSpec[] = [
  {
    id: "spread",
    label: "Throw",
    hint: "hug — thrown clear",
    u: uAssembleSpread,
    map: { k: 4 },
  },
  {
    id: "sep",
    label: "Slide",
    hint: "none — drifted wide",
    u: uAssembleSep,
    map: { k: 1 },
  },
  {
    id: "swirl",
    label: "Swirl",
    hint: "straight in — orbits in",
    u: uAssembleSwirl,
    map: { k: 2 },
  },
  {
    id: "rewind",
    label: "Rewind",
    hint: "settles dead — breathes out",
    u: uAssembleRewind,
    map: { k: 1.9 },
  },
  // exponential: the top of the slider must be GENUINELY flat (~30R — a linear
  // multiplier capped low never straightens the arc)
  {
    id: "flatten",
    label: "Flatten",
    hint: "on the barrel — flat arc",
    u: uAssembleFlatten,
    map: { pow: 30 },
  },
  {
    id: "depth",
    label: "Depth",
    hint: "flat — deep stack",
    u: uAssembleDepth,
    map: { k: 2 },
  },
  {
    id: "curl",
    label: "Curl",
    hint: "unrolled — tight roll",
    u: uAssembleCurl,
    map: { k: 1 },
  },
  // 0..0.75 — the gate derives its window as 1 − stagger, which must stay
  // positive (see formation.ts)
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: uAssembleStagger,
    map: { k: 0.75 },
  },
  // more roll-on = LOWER split (the aH boundary): 0.95 .. 0.15
  {
    id: "wrap",
    label: "Wrap share",
    hint: "flight — roll-on",
    u: uAssembleSplit,
    map: { b: 0.95, k: -0.8 },
  },
  {
    id: "overlap",
    label: "Reel-in",
    hint: "rigid — bends home",
    u: uAssembleOverlap,
    map: { k: 1 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: uAssembleSnap,
    map: { k: 1 },
  },
  // Sector SOLO — width at the top (TAU) is fully open (bit-exact identity);
  // pull it down to run the reassembly on one sector only.
  {
    id: "maskWidth",
    label: "Sector width",
    hint: "one sector — all",
    u: uAssembleMaskWidth,
    map: { k: TAU },
  },
  {
    id: "maskCenter",
    label: "Sector centre",
    hint: "−π — +π",
    u: uAssembleMaskCenter,
    map: { b: -Math.PI, k: TAU },
  },
];

const HELIX_PARAMS: ParamSpec[] = [
  {
    id: "turns",
    label: "Turns",
    hint: "½ — 1¼ turns",
    u: uHelixTurns,
    map: { k: 1.5 },
  },
  {
    id: "spread",
    label: "Spread",
    hint: "tight — wide",
    u: uHelixSpread,
    map: { k: 1 },
  },
  // magnitude slider → the NEGATIVE rearward value (v=0.45 ⇒ −45mm)
  {
    id: "approach",
    label: "Approach",
    hint: "flush — deep rear",
    u: uHelixApproach,
    map: { k: -100 },
  },
  // more bend = tighter coil, 1..0.3
  {
    id: "bend",
    label: "Bend",
    hint: "gentle — tight coil",
    u: uHelixCoil,
    map: { b: 1, k: -0.7 },
  },
  {
    id: "snap",
    label: "Snap",
    hint: "glide — snap home",
    u: uHelixSnap,
    map: { k: 1 },
  },
  // slider 0..1 → 0..12mm
  {
    id: "hover",
    label: "Hover",
    hint: "flush — floating",
    u: uHelixHover,
    map: { k: 12 },
  },
];

const ROLLOUT_PARAMS: ParamSpec[] = [
  {
    id: "stagger",
    label: "Stagger",
    hint: "together — layered",
    u: uRolloutStagger,
    map: { k: 0.75 },
  },
  // Sector solo — top (TAU) fully open (bit-exact identity), pull down to unroll
  // one sector only.
  {
    id: "sectorWidth",
    label: "Sector width",
    hint: "one sector — all",
    u: uRolloutMaskWidth,
    map: { k: TAU },
  },
  {
    id: "sectorCenter",
    label: "Sector centre",
    hint: "−π — +π",
    u: uRolloutMaskCenter,
    map: { b: -Math.PI, k: TAU },
  },
  // Rank band — lo 0 / hi 1 fully open; narrow it to roll out a subset of shells.
  {
    id: "rankLo",
    label: "Rank low",
    hint: "inner — outer",
    u: uRolloutRankLo,
    map: { k: 1 },
  },
  {
    id: "rankHi",
    label: "Rank high",
    hint: "inner — outer",
    u: uRolloutRankHi,
    map: { k: 1 },
  },
];

const CORE_ANIMS: LensAnimation[] = [
  {
    id: "teardown",
    label: "Teardown",
    hint: "explode → peel → relax",
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      // heavily OVERLAPPED, like the homepage teardown (unwrap rides the
      // explode): pieces peel WHILE they fan out — one continuous gesture, not
      // staged phases (owner: staged read as "sequential instead of together")
      state.explodeTarget = smoothstep(0.02, 0.55, p);
      state.unwrapTarget = smoothstep(0.18, 0.8, p);
      state.curlTarget = 1 - 0.65 * smoothstep(0.55, 0.95, p);
    },
  },
  {
    id: "reassemble",
    label: "Reassemble",
    hint: "sheets fly home — layer by layer",
    // The homepage's scene 5→7 machinery under one scrub: start as the story's
    // post-teardown state (fully exploded, peeled to flat sheets), then the
    // staggered rewrap seats every layer inner→outer while explode/unwrap
    // release late, settling fully assembled — same channels, no camera.
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.curlTarget = 0; // flat sheets; the rewrap derives per-shell curl
      state.rewrapOnTarget = 1;
      state.rewrapTarget = smoothstep(0, 0.75, p);
      state.explodeTarget = 1 - smoothstep(0.7, 1, p);
      state.unwrapTarget = 1 - smoothstep(0.65, 0.95, p);
    },
  },
  {
    id: "reassemble-ops",
    label: "Reassemble · ops",
    hint: "flies home — sheets wrap on",
    // The ops-built A/B alternative to the rewrap "Reassemble" above. ONE channel:
    // the wedges start fully disassembled (p=0 ⇒ assemble 1) and seat home by p=1.
    // The formation preset (materials/formation uAssemble) owns every per-wedge
    // stagger, flatten and wrap roll-on — nothing else is driven here. Live
    // knobs come from the ASSEMBLE_PARAMS table.
    params: paramsOf(ASSEMBLE_PARAMS),
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      // same pacing curve as the classic Reassemble's rewrapTarget, so the two
      // animations hit each per-shell window at the same p — 1-1 matching
      state.assembleTarget = 1 - smoothstep(0, 0.75, p);
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
      // home by p=1. The shader (materials/formation uHelix) owns every per-wedge
      // stagger, snap and over-coil — nothing else is driven here.
      state.helixTarget = 1 - p;
    },
    setParam: setParamOf(HELIX_PARAMS),
  },
  {
    id: "rollout",
    label: "Roll-out",
    hint: "unrolls flat — a carpet",
    // ONE channel: the wedges start rolled out flat (p=0 ⇒ rollout 1) and roll
    // back home by p=1. The shader (materials/formation uRollout) owns the
    // per-wedge stagger and the rolling-contact geometry; live knobs (stagger,
    // sector/rank masks) come from ROLLOUT_PARAMS.
    params: paramsOf(ROLLOUT_PARAMS),
    apply(p, state) {
      state.zoomTarget = 0;
      state.focusTarget = 0;
      state.apertureTarget = 0;
      state.rolloutTarget = 1 - p;
    },
    setParam: setParamOf(ROLLOUT_PARAMS),
  },
];

/** The /lens registry: core showcase animations + the exploration families
 *  (each family owns its file under explore/). */
export const ANIMATIONS: LensAnimation[] = [
  ...CORE_ANIMS,
  ...WIPE_ANIMS,
  ...CHOREO_ANIMS,
  ...FORMATION_ANIMS,
];
