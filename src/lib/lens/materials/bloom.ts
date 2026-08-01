import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  uniform,
  positionLocal,
  normalLocal,
  transformNormalToView,
  vec2,
  vec3,
  float,
  fract,
  mix,
  min,
  pow,
  atan,
  abs,
  step,
  clamp,
  cos,
  sign,
  sin,
  smoothstep,
  length,
  normalize,
} from "three/tsl";
import { buildFormations, rankMask, type SeatCtx } from "./formation";
import {
  genieWarp,
  uGenieRankLo,
  uGenieRankHi,
  GENIE_RANK_FEATHER,
} from "./genie";
import {
  wipeMask,
  uWipeOn,
  uWipeExplode,
  uWipeUnwrap,
  uWipeFormation,
} from "./wipe";

// TSL bloom / unwrap deformation (lens_work/bloom_tsl_plan.md §2–§3).
// Every wedge (and decal riding a cut shell) carries per-vertex `_bloomtheta0`
// (sector centre) and `_bloomr` (shell radius). (The model still exports a
// `_bloomgroup` tag for its own dual-channel teardown, but the web dropped the
// cutaway channel — every wedge blooms the same way, so it goes unread here.)
//   BLOOM: the shell dilates radially while its angular spread compresses to
//          chase the growing circle (arc-length preserving).
//   UNWRAP: each ring MORPHS directly from its rolled cylinder to a single flat
//          plane (developable unroll about a global seam), treated as a separate
//          plane — no rolling peel front, so nothing stays connected / swings out.
//
// Axis resolved in Phase 0: loaded optical axis = Y, radial plane = X–Z, and
// `_bloomtheta0` is negated relative to the loaded frame — so `theta0 = -attr`,
// `theta = atan2(p.z, p.x)`, radius = length(p.x, p.z), and p.y is preserved.

export const uBloom = uniform(0);
export const uUnwrap = uniform(0);
// Light-path isolate as a FADE (0 = everything shown, 1 = non-glass dissolved):
// multiplied into the non-glass ink fills/lines. The old whole-mesh visibility
// toggle made every structural piece vanish in a single frame ("pieces just
// disappear instead of fade out" — owner). Cinematics drives it; meshes are
// still visibility-culled once fully faded to save fill-rate.
export const uIsolateHide = uniform(0);
// LAYER-BY-LAYER REWRAP (the reassembly scene): with uRewrapOn engaged, each
// shell runs its OWN seat timeline staggered by `_bloomrate` rank (inner shells
// first, outer last): lr = clamp((uRewrap − rank·0.6)/0.4). Over lr 0→0.55 the
// piece FLIES IN (its effective explode t → 0, flat-card spread included); over
// 0.45→1 it WRAPS ON (unwrap 1 → 0, the flat sheet curling onto the barrel) —
// shrink-wrap, layer by layer, while the glass column sits waiting inside.
// uRewrapOn ramps up while the structure is HIDDEN (the light-path isolate), so
// the global morph to flat cards is never seen — pieces reappear as sheets.
export const uRewrap = uniform(0); // 0 = fully exploded sheets .. 1 = all seated
export const uRewrapOn = uniform(0); // 0 = normal explode/unwrap semantics
// The rewrap stagger law, shared with core/rig's per-part settle() so the axial
// ladder seats on EXACTLY the same per-rank timeline as the shader shells:
// each rank's window starts at rank·STAGGER and lasts WINDOW of the scrub.
export const REWRAP_STAGGER = 0.6;
export const REWRAP_WINDOW = 0.4;
// CURL — a separate axis from the unwrap (owner: "they address different
// things"): unwrap drives how much material is PEELED off the surface; curl
// drives what the peeled material DOES — 1 = tight sticker curl (doubled-back
// flap), 0 = relaxed flat sheet. During the rewrap the shader derives curl
// per shell instead (waiting fully-peeled sheets fly flat; applying layers
// curl), since a global value can't describe both at once.
export const uCurl = uniform(1);
// SHEAR — tilts the peel front diagonally (a corner peel, like a sticker lifted
// from one corner, instead of a machine-straight edge peel): the front's arc
// position varies with the vertex's AXIAL height, scaled by a w·(1−w) parabola
// so the fully-stuck and fully-peeled states stay exact. Sign alternates per
// shell (hash of R) so neighbouring layers peel from opposite corners.
export const uShear = uniform(0.5);
const SHEAR_K = 0.9; // max front tilt at mid-peel, × uShear × uSpan
const MODEL_H_MM = 76.5; // axial extent of the lens (doc: mount 0 → filter 76.5)
// Radial dilation strength: at full bloom each shell's radius grows by uK·R, so
// the wedges fly OUTWARD from the axis (a real teardown) instead of just opening a
// slightly larger cage. 0.5 was the calibrated rest value; the web explode wants
// the pieces thrown well clear of the glass. This is now the ONLY radial explode
// path for shells (the old object-space RING_SCALE double-explosion was removed
// from core/rig), so the value carries the full throw — hence 2.4, not 1.15.
// Exported so core/rig's loose-parts radial expansion uses the SAME proportional
// rate — the off-axis lead screw opens up with the shells instead of outrunning
// or lagging them.
export const BLOOM_DILATION = 2.4;
const uK = uniform(BLOOM_DILATION); // module-private; core/rig expands loose parts at the same rate
// even-mode wedge width = 2π/N_EVEN (internals-v2 export: N_EVEN = 5 ⇒ 72°; was
// 4 ⇒ 90°). Drives only the unwrap seam/flat-card geometry, not the bloom explode
// (which uses each vertex's true angle). The iris family (Cam_Barrel/Iris_Housing/
// Cam_OpticsCage) is cut into 7 narrower wedges, so this single global span slightly
// over-estimates their peel width — one value can't fit both counts. Module-private.
const EVEN_SPAN = (2 * Math.PI) / 5; // shared with assignCardAttributes' JS mirror
const uSpan = uniform(EVEN_SPAN);
// Staggered explode (module-private): each ring twists about the axis (more for
// larger rings ⇒ a spiral) and the whole ring stack spreads apart along the
// optical axis, so the LAYERS separate instead of nesting as concentric cylinders.
const uTwist = uniform(0.06); // radians of twist per unit R, × uBloom
const uAxial = uniform(0.4); // axial stretch of the ring stack (symmetric), × uBloom
// Per-piece DIRECTIONAL separation (× uBloom, × R): each wedge also slides out
// RIGIDLY along its own centroid meridian θ0 — the piece's origin-relative
// direction — on top of the radial dilation, so neighbouring pieces pull apart
// into a distinct exploded-view layout instead of nesting as concentric rings.
const uSeparate = uniform(0.55);
// Per-SHELL stagger: concentric shells share the sector layout and dilate ∝ their
// (nearly equal) radii, so same-sector wedges of the nested outer skins otherwise
// travel as one stacked clump. The dilation-rate stagger is ORDER-PRESERVING: each
// shell carries a `_bloomrate` rank (0..1, assigned by assignShellRates() from its
// radius ORDER, ascending) and the rate rises monotonically with it — adjacent
// shells still get distinctly different rates (the skins separate) but an inner
// shell can never OVERTAKE an outer one. (A random hash was tried first: order-
// blind, so nested barrels crossed mid-flight and interleaved. The axial shove
// stays hashed — different radii can share an axial band harmlessly.)
// Constant across a whole ring, so every ring stays symmetric (see NOTE below).
const uStagger = uniform(1.1); // dilation-rate spread (rate = uK ± uStagger/2, by rank)
// SPIRAL: the flat cards' whole frame (seam meridian, hinge, orientation) sweeps
// about the axis by t^0.65·uSwirl·(0.5 + rank01) — outer layers sweep further,
// so the sheets corkscrew OUT with the teardown and spiral back IN during the
// rewrap. The SUB-LINEAR power is what makes the path READ as a spiral: the
// radius collapses ∝ t but the angle lingers (∝ t^0.65), so the tail of every
// fly-in is mostly orbital — the sheet visibly arcs around the lens before it
// lands. Swirl is fully unwound by each layer's curl-on (t ≈ 0), so every card
// still wraps at its home meridian.
// Kept moderate: the sub-linear decay is what makes the path read as a spiral;
// a large angle just scatters the sheets out of their home sectors (big skins
// end up parked in front of the camera at the rewrap start — owner caught it).
const uSwirl = uniform(1.1); // radians at full t for a mid-rank shell (~63°)
// Axial layout is owned by the OWNER-APPROVED explode ladder (core/rig EXPLODE_MM
// drives every shell's empty), so the random axial shove is parked at 0 — turning
// it up would knock shells off their approved rungs. Kept as a knob.
const uAxialStagger = uniform(0);
// NOTE: each ring must expand SYMMETRICALLY — the pieces move outward from the
// axis while the ring's centre stays ON the axis. (Per-wedge radial scatter was
// tried and removed: dilating a ring's 4 wedges by different amounts drags the
// centre off-axis and reads wrong.)

const TAU = Math.PI * 2;
// Each wedge flattens about its OWN centre meridian t0 (a gentle ~90° unbend,
// anchored at the centre) — never a full 360° ring, so the flat cards can't cross
// the axis into a knot, and no peel front stays connected and swings out.
// Radial spread pushes each flat card outward along its seam direction so the
// wedges of a ring read as SEPARATE planes instead of meeting in a folded pinwheel.
// Driven ONLY by explode (the dedicated slider); unwrap purely peels/flattens.
const SPREAD_EXPLODE = 1.6; // × R, at full explode
// The unwrap scrub runs TWO phases: 0..FLAT_END rolls the wedge open onto the
// tangent plane (the original morph); FLAT_END..1 then HINGES the finished flat
// card about its seam line (parallel to the lens axis, a door-swing) up to
// perpendicular to the surface — so a full unwrap reads as lifted-open flaps,
// and the rewrap's reverse pass folds them down before curling them on.
// STICKER-PEEL curl (owner reference: a sticker peeling off its backing): the
// un-stuck remainder doesn't extend straight off the tangent — it rolls around a
// small CURL cylinder riding the peel front (radius uCurlR·R), and past half a
// turn the flap trails straight BACK over the stuck part, adhesive-side out.
// Peeling and applying are the same construction scrubbed opposite ways.
const CURL_MAX = Math.PI; // cap the curl at a half-turn → doubled-back flap
const uCurlR = uniform(0.22); // curl radius as a fraction of the shell radius — a
// lazier roll: material takes ~40% more arc to double back behind the front
// HANDEDNESS of the whole peel/wrap/spiral system: +1 anchors each card at its
// θ0−span/2 edge and peels counter-clockwise; −1 anchors at θ0+span/2 and peels
// clockwise. The spiral sweep and the rolled twist flip with it, so the fly-in
// orbit and the wrap-on crease advance in the SAME rotational sense — a
// coherent screw-on motion instead of the sheet arriving one way and rolling
// on the other. (Owner picked −1, 2026-07-16.)
const WRAP_DIR = -1;

// ── CARDIFY — the filmstrip payoff: an unwrapped/rolled-out sheet morphs into a
// clean rectangular PHOTO CARD. The card is the IDEALIZED sheet: the same
// tangent plane the unwrap/rollout math flattens the wedge onto (anchored at
// the wedge's seam meridian, carrying the same rigid flight — swirl, seam
// spread, per-piece slide), with the ragged material coordinates remapped onto
// a uniform rectangle. assignCardAttributes() precomputes each vertex's
// normalized material coordinates over its OWN wedge's true extents (`_carduv`:
// u = arc position, v = axial position — cut jitter and overhang land exactly
// on the rectangle edge because the extremes normalize to 0/1) plus the wedge's
// material-frame centre (`_cardc`: atlas tile, axial mid, arc mid). Surface
// relief / wall offset clamps to a thin uniform card slab. uCardify = 0 is a
// hard-gated exact identity; the rank band solos a shell band (default open).
export const uCardify = uniform(0);
export const uCardifyRankLo = uniform(0);
export const uCardifyRankHi = uniform(1);
const CARDIFY_RANK_FEATHER = 0.08;
// Uniform card size across shells — a landscape photo aspect (~3:2) with the
// LONG side along the lens axis (v): the gallery shoots the lens axis
// horizontal, so the pictures read landscape on screen. Sized near the big
// outer sheets' natural footprint.
const CARD_W_MM = 30; // arc (u) extent
const CARD_H_MM = 45; // axial (v) extent
// Stretch cap: a wedge is pulled toward the uniform card size but never blown
// up more than this — the big outer sheets all reach the full rectangle
// (uniform gallery), while thin shims/plates/PCB strips (sub-mm footprints in
// the same radius band) stay sliver-sized "card edges" instead of stretching a
// 0.5mm strip into a 45mm phantom photo (looked like giant smeared glyphs).
const CARD_STRETCH_MAX = 2.5;
// Minimum radial gap between the card planes of consecutive shells: shells cut
// at near-equal radii (skins 0.1–0.6mm apart) otherwise land their cards
// near-coplanar and the whole faces z-fight — the pile ladder (computed in
// assignCardAttributes, ridden as `_cardc.w`) spaces the deck like real prints.
const CARD_PILE_GAP_MM = 3;
/** Photo-face crossfade weight (0..1): rises over the LAST stretch of the
 *  cardify scrub (the geometry squares first, then the picture develops), rank
 *  band + hard idle gate identical to the position blend — uCardify = 0 renders
 *  bit-exact. Standalone (attribute-driven) so shading.ts can fold it into any
 *  material's color/opacity graph without a fields() bag. */
export function cardPhotoMix(): any {
  const rank01 = floatAttr("_bloomrate");
  const mask = rankMask(
    uCardifyRankLo as any,
    uCardifyRankHi as any,
    CARDIFY_RANK_FEATHER,
  )({ rank01 } as unknown as SeatCtx) as any;
  return smoothstep(0.55, 0.95, uCardify)
    .mul(mask)
    .mul(step(1e-6, uCardify)) as any;
}

// attribute() returns a loosely-typed node whose math methods aren't in the .d.ts;
// `any` is the standard escape hatch for TSL typing gaps (runtime nodes have them).
const floatAttr = (name: string) => attribute(name, "float") as any;
const wrapPi = (x: any) =>
  x.sub(float(TAU).mul(x.add(Math.PI).div(TAU).floor()));

// per-vertex quantities shared by the position and normal graphs
function fields() {
  const p = positionLocal as any;
  const t0 = floatAttr("_bloomtheta0").negate(); // Blender→loaded frame flip
  const R = floatAttr("_bloomr");
  const tRaw = uBloom as any; // single bloom channel (web dropped the cutaway split)
  // per-shell dilation-rate stagger: rank01 (=_bloomrate) is the shell's position
  // in the radius ORDER, so the rate is monotone in R and shells can't overtake
  const rank01 = floatAttr("_bloomrate");
  // rewrap: this shell's own seat progress (0 = still an exploded sheet, 1 = home)
  const lr = clamp(
    uRewrap.sub(rank01.mul(REWRAP_STAGGER)).div(REWRAP_WINDOW),
    0.0,
    1.0,
  ) as any;
  // effective explode amount — during the rewrap it collapses per shell (fly-in);
  // every explode-scaled term below (dilation, twist, axial, slide, card spread)
  // uses THIS, so seating a layer undoes all of its scatter at once. The fly-in
  // deliberately LAGS the wrap (0.1–0.95 vs 0.05–0.9): the crease starts seating
  // the sheet at its home meridian while the tail is still flown out and swirled,
  // so the sheet visibly BENDS — reeled in like tape — instead of flying home
  // rigid and only then curling.
  // WIPE gate (materials/wipe.ts): the split-line mask, folded in per channel as
  // a multiplicative factor — mask 0 (below the line) zeroes the channel there
  // (seated), mask 1 leaves it live, so state DIFFERS across the line. EXACT
  // identity at uWipeOn = 0: every factor is mix(1, mask, 0) = 1, and a channel
  // at 0 stays 0 under any mask (0·f = 0) — the seated render and the
  // instrument's idle check are untouched either way.
  const wipeM = wipeMask() as any;
  const wipeF = (sel: any) =>
    mix(float(1), wipeM, (uWipeOn as any).mul(sel)) as any;
  const t = tRaw
    .mul(mix(float(1), float(1).sub(smoothstep(0.1, 0.95, lr)), uRewrapOn))
    .mul(wipeF(uWipeExplode)) as any;
  // effective unwrap — the wrap runs through ~the whole layer timeline
  const uw = mix(
    uUnwrap,
    float(1).sub(smoothstep(0.05, 0.9, lr)),
    uRewrapOn,
  ).mul(wipeF(uWipeUnwrap)) as any;
  // effective curl: the slider/story channel normally; during the rewrap it's
  // derived per shell from the layer's own peel state — a WAITING sheet (uw=1,
  // fully peeled, in flight) stays relaxed flat, an APPLYING layer curls. The
  // ramp spans half the application (0.45–0.95 of uw), so the sheet curls up
  // GRADUALLY as it sticks rather than snapping into the curl the moment its
  // turn comes (owner: "curling a bit too quickly").
  const curlEff = mix(
    uCurl,
    float(1).sub(smoothstep(0.45, 0.95, uw)),
    uRewrapOn,
  ) as any;
  const r = length(vec2(p.x, p.z)) as any;
  const theta = atan(p.z, p.x) as any; // atan2(z, x)
  const delta = t.mul(uK.add(rank01.sub(0.5).mul(uStagger))).mul(R);
  const phi = wrapPi(theta.sub(t0)); // wedge-local angle off its centre, ∈ ±halfspan
  const thetaP = t0.add(phi.mul(R.div(R.add(delta)))); // bloomed angle
  // Total rolled meridian displacement: the angular compression PLUS the per-ring
  // twist. Shared by both graphs so the normal rotates by exactly what the position
  // does — rotating by the compression alone left shading lagging by the twist.
  const thetaR = thetaP.add(t.mul(uTwist).mul(WRAP_DIR).mul(R)) as any;
  // spiral sweep of the flat-card frame (see uSwirl) — shared by position + normal;
  // signed by WRAP_DIR so the orbit matches the peel handedness
  const swirl = pow(t, 0.65)
    .mul(uSwirl)
    .mul(WRAP_DIR)
    .mul(rank01.add(0.5)) as any;
  // SHEARED peel front (shared by position + normal): the stuck-arc limit tilts
  // with the vertex's axial position — a diagonal, corner-style peel. The
  // w·(1−w) parabola zeroes the tilt at both extremes (exactly stuck / exactly
  // peeled), and the sign alternates per shell for organic variety.
  const wSt = float(1).sub(clamp(uw, 0.0, 1.0)) as any; // stuck-ness
  const yN = p.y.div(MODEL_H_MM).sub(0.5) as any; // normalized axial position
  const shearSign = sign(fract(R.mul(5.13)).sub(0.5)) as any;
  const tilt = uShear
    .mul(shearSign)
    .mul(yN)
    .mul(wSt)
    .mul(float(1).sub(wSt))
    .mul(4 * SHEAR_K)
    .mul(uSpan) as any;
  const front = clamp(wSt.mul(uSpan).add(tilt), 0.0, uSpan) as any;
  // Formation-spread deforms (helix, …): composable parametric ops baked in and
  // gated per channel, EXACTLY zero when idle — see materials/formation.ts. Seeded
  // with this vertex's SEATED wedge decomposition; the pipeline folds every preset
  // into a summed position delta + a summed normal rotation about the optical axis.
  const seat: SeatCtx = {
    theta,
    r,
    y: p.y,
    phi,
    yN,
    R,
    rank01,
    t0,
    halfSpan: uSpan.mul(0.5),
    wrapDir: WRAP_DIR,
  };
  // Formation channels under the wipe: the presets read their channel uniforms
  // inside formation.ts, so the mask is applied to the preset OUTPUT (summed
  // delta + normal rotation) at this call site — the seam bloom owns. Per
  // vertex that still reads as a state window (below the line delta·0 = seated,
  // above delta·1 = the live formation); only inside the narrow feather band
  // does it differ from a pre-gate channel mask (positional blend, not a
  // timeline scrub). Identity: channel 0 ⇒ delta ≡ 0 under any factor, and
  // uWipeOn 0 ⇒ factor ≡ 1.
  const formationRaw = buildFormations(seat);
  const wipeFm = wipeF(uWipeFormation);
  const formation = {
    delta: formationRaw.delta.mul(wipeFm),
    rot: formationRaw.rot.mul(wipeFm),
  };
  // CARDIFY blend weight (position + normal share it): channel × rank band ×
  // the hard idle gate — exactly 0 at uCardify = 0 (0·f = 0, and the step gate
  // force-zeroes any residual), so the seated render and every other channel's
  // path are bit-exact when the card morph is off.
  const cardK = (uCardify as any)
    .mul(
      rankMask(
        uCardifyRankLo as any,
        uCardifyRankHi as any,
        CARDIFY_RANK_FEATHER,
      )(seat) as any,
    )
    .mul(step(1e-6, uCardify)) as any;
  return {
    p,
    R,
    r,
    theta,
    t0,
    phi,
    delta,
    thetaP,
    thetaR,
    t,
    uw,
    curlEff,
    swirl,
    wSt,
    front,
    rank01,
    formation,
    cardK,
  };
}

// Position graph built from a PRE-COMPUTED fields() bag, so a material can share
// ONE fields() evaluation (and its once-folded formations) between the position and
// normal graphs instead of evaluating the whole deform 2-3× — see bloomGraph().
function positionGraph(f: ReturnType<typeof fields>): any {
  const {
    p,
    R,
    r,
    theta,
    t0,
    delta,
    thetaR,
    t,
    uw,
    curlEff,
    swirl,
    wSt,
    front,
    rank01,
    formation,
    cardK,
  } = f;
  // rolled → bloomed: SYMMETRIC radial dilation (each ring expands outward, its
  // centre staying on the axis) + angular compression that opens gaps between the
  // wedges, PLUS a per-ring twist about the axis and an axial spread of the stack.
  // Every term scales with the per-vertex EFFECTIVE explode `t` (not the raw
  // uniforms), so the rewrap's per-shell seating undoes all of it in lock-step.
  // symmetric stack stretch + a per-shell axial shove (second hash, so radially-
  // staggered shells don't all shove the same way) — nested skins slide APART
  // lengthwise instead of dilating into the same spot.
  const hashA = fract(R.mul(3.77)).sub(0.5) as any;
  const py = p.y
    .mul(float(1).add(t.mul(uAxial)))
    .add(t.mul(hashA).mul(uAxialStagger).mul(R));
  const rp = r.add(delta);
  const bx = rp.mul(cos(thetaR));
  const bz = rp.mul(sin(thetaR));
  // flat card: unbend the wedge about its SEAM edge (t0 − halfspan) — the seam
  // stays put and the wedge peels open from there onto the tangent (arc R·s from
  // the seam, wall r−R along dir(seam)). Only a ~90° arc, so the free edge swings
  // ~1.5R — a clean peel, never a knot. Pushed out along dir(seam) so cards separate.
  // the card's frame angle carries the spiral sweep — position, hinge line and
  // orientation all rotate together about the axis (a rigid swirl of the card)
  // handedness: the seam anchors at the WRAP_DIR-side edge of the wedge, and the
  // arc coordinate is measured in the peel direction so s ∈ [0, span] either way
  const seamRest = t0.sub(uSpan.mul(0.5 * WRAP_DIR));
  const s = wrapPi(theta.sub(seamRest)).mul(WRAP_DIR); // arc angle from the REST seam, ∈ [0, span]
  const spread = R.mul(t.mul(SPREAD_EXPLODE)); // explode-only, not unwrap
  // STICKER PEEL: a peel front sits at φW from the seam; material behind it is
  // STUCK on the shell at its own meridian. The remainder rolls around a small
  // CURL cylinder tangent to the surface at the front (radius ρ, axis parallel
  // to the lens axis), and past a half-turn (CURL_MAX) the flap trails straight
  // back OVER the stuck part, adhesive-side out — exactly a sticker being
  // peeled; scrubbed the other way, a sticker being smoothed on. Developable and
  // length-preserving: arc e past the front becomes curl angle γ = e/ρ + tail.
  const uwC = clamp(uw, 0.0, 1.0) as any;
  const sOff = r.sub(R); // wall offset — spread-independent
  const w = wSt; // stuck-ness driver: 0 = fully peeled, 1 = fully on
  const phiW = min(s, front) as any; // this vertex's STUCK arc angle (sheared front)
  const e = R.mul(s.sub(phiW)); // peeled arc length past the front
  const rho = R.mul(uCurlR); // curl radius
  // curlEff scales the roll: 1 = tight sticker curl, 0 = the material lies out
  // as a relaxed flat sheet (see uCurl — a separate axis from the peel amount)
  const gamma = min(e.div(rho), CURL_MAX).mul(curlEff) as any;
  const tail = e.sub(rho.mul(gamma)); // straight flap beyond the (scaled) curl
  const cg = cos(gamma);
  const sg = sin(gamma);
  // curl-frame coefficients along the front's outward normal (N) and the peel
  // tangent (T): stuck vertices (e=0) reduce to radius A+sOff at their meridian;
  // the curled part lifts off around the ρ circle; the tail continues straight.
  // Wall offset rides INSIDE the curl (outer face closest to the curl centre).
  const coefN = rho.add(sOff.sub(rho).mul(cg)).add(tail.mul(sg)); // + A below
  const coefT = rho.sub(sOff).mul(sg).add(tail.mul(cg));
  // Reel-in blend between the PINNED frame (front at the rest meridian on the
  // bare barrel — stuck material seats at its true home) and the FLOWN frame
  // (full flight displacement: swirl + spread). The blend interpolates the FRAME
  // PARAMETERS (meridian angle, radius) and builds the position ONCE — mixing
  // the two POSITIONS across the swirl rotation cut chords through the cylinder
  // and kinked the sheets into S-warped ribbons.
  // The blend releases PER PIECE (uniform across the sheet), not per vertex: a
  // per-vertex swirl gradient added a THIRD curvature along the ribbon (on top
  // of barrel-curve + curl-back) and read as serpentine snakes (owner caught
  // it). A sticking sheet un-swirls as a unit — its spiral-home motion already
  // comes from the t-decay — and the wrap stays clean stuck-arc + curl + tail.
  // The home-pin is REWRAP-ONLY semantics ("wrap from the original starting
  // spot"): outside the rewrap, sticking must happen at the piece's FLOWN
  // location — an unconditioned pin teleported every part-peeled wedge back to
  // the assembled barrel whenever explode + unwrap were combined (owner caught
  // it on the /lens sliders).
  const pin = smoothstep(0.0, 0.25, w).mul(uRewrapOn) as any;
  const m = clamp(float(1).sub(pin), 0.0, 1.0) as any;
  const coefT0 = coefT.mul(WRAP_DIR);
  const thB = seamRest.add(swirl.mul(m)).add(phiW.mul(WRAP_DIR)); // blended front meridian
  const AB = R.add(spread.mul(m)); // blended shell radius (H at m=1, bare R at m=0)
  const csB = cos(thB);
  const ssB = sin(thB);
  const fxP = csB.mul(AB.add(coefN)).sub(ssB.mul(coefT0));
  const fzP = ssB.mul(AB.add(coefN)).add(csB.mul(coefT0));
  // The peel sticks onto an idealized cylinder; the true rolled state (bx/bz)
  // additionally carries angular compression, twist and dilation — ease onto it
  // over the last quarter of the stick so seating is exact.
  const seatMix = smoothstep(0.75, 1.0, w) as any;
  const fx = mix(fxP, bx, seatMix);
  const fz = mix(fzP, bz, seatMix);
  // Per-piece directional slide: t0 is constant across a wedge, so sep·dir(t0) is a
  // RIGID translation of the whole wedge outward along its centroid meridian —
  // holds in every peel state so the pieces stay separated while flying.
  const sep = t.mul(uSeparate).mul(R) as any;
  const sx = sep.mul(cos(t0));
  const sz = sep.mul(sin(t0));
  const base = vec3(
    fx.add(sx) as any,
    mix(py, p.y, uwC) as any,
    fz.add(sz) as any,
  );
  // Formation spread, added as a summed DELTA off the SEATED cylinder point: built
  // ONCE per preset at the sH-scaled state (no cartesian mix across the winding,
  // which would chord-cut the corkscrew) yet EXACTLY zero when every channel is 0,
  // so it composes with the base result without disturbing any other channel.
  const finalP = base.add(formation.delta);
  // CARDIFY (see the uCardify block): blend the FINAL deformed position toward
  // the idealized photo card, composed LAST so the card wins over any curl /
  // roll / formation state at 1. The card lives in the sheet's OWN plane — the
  // tangent plane at the seam meridian, carrying the same rigid flight terms
  // the flat sheet does (swirl'd frame, seam spread, per-piece slide sx/sz), so
  // driving explode fans finished cards apart with the classic vocabulary. The
  // rollout formation flattens onto this exact plane too (same seam, same arc
  // coordinate), so cardify squares either unwrap's sheets seamlessly.
  //   u/v (from `_carduv`) span the wedge's TRUE material extents → mapped onto
  //   a uniform CARD_W × CARD_H rectangle centred on the wedge's material-frame
  //   centre (`_cardc`: tile, yMid, arcMid); ragged cut edges land exactly on
  //   the rectangle border. Relief/wall (sOff) clamps into a thin uniform slab.
  const cuv = attribute("_carduv", "vec4") as any; // (u, v, wEff, hEff)
  const cmeta = attribute("_cardc", "vec4") as any; // (tile, yMid, arcMid, radOff)
  const thC = seamRest.add(swirl.mul(m)) as any; // the flown card frame
  const cNc = cos(thC);
  const sNc = sin(thC);
  const cardX = R.mul(cmeta.z)
    .add(cuv.x.sub(0.5).mul(cuv.z))
    .mul(WRAP_DIR) as any; // tangential mm from the seam, in the peel direction
  // The card is EXACTLY planar: all relief/wall depth flattens to the plane.
  // Partial compression was tried twice (soft slab, then a steep knee) and the
  // residual corrugation chopped the photo into grazing-angle shimmer wherever
  // a wedge carries knurl/rib micro-geometry. Full coincidence is SAFE here
  // because every coincident surface samples the SAME photo at the same (u,v)
  // (color-identical, so the depth tie is invisible) and backface culling does
  // the face selection — from the front only outward-facing sheets survive,
  // from the back the inner wall shows the card-back tone (cards.ts).
  const cardR = R.add(cmeta.w).add(spread.mul(m)) as any;
  const cardPos = vec3(
    cNc.mul(cardR).sub(sNc.mul(cardX)).add(sx) as any,
    cmeta.y.add(cuv.y.sub(0.5).mul(cuv.w)) as any,
    sNc.mul(cardR).add(cNc.mul(cardX)).add(sz) as any,
  );
  // GENIE (materials/genie.ts): the dock-minimize funnel, composed LAST — even
  // after cardify — so the warp sucks whatever the current look is (rolled
  // shells, flat sheets, finished photo cards) down the funnel as one stream.
  // Rank-banded like cardify (wedges only; non-bloom materials follow the full
  // channel via attachGenie). Hard-gated exact identity at uGenie = 0.
  const genieM = rankMask(
    uGenieRankLo as any,
    uGenieRankHi as any,
    GENIE_RANK_FEATHER,
  )({ rank01 } as unknown as SeatCtx) as any;
  return genieWarp(mix(finalP, cardPos, cardK), genieM);
}

// Normal graph built from the same PRE-COMPUTED fields() bag as positionGraph.
// The OBJECT-space half is its own function so attachBloomHull can push vertices
// along the deformed normal without the view transform.
function normalGraphLocal(f: ReturnType<typeof fields>): any {
  const { theta, t0, thetaR, curlEff, swirl, wSt, front, formation, cardK } = f;
  // Rolled normal: rotate about the axis by the SAME total angle the position graph
  // applies — the angular compression AND the per-ring twist (thetaR, not thetaP).
  // The position builds points as (r·cos θ, r·sin θ), so rotating by +α is
  // (x·cosα − z·sinα, x·sinα + z·cosα); the peeled branch below uses that same
  // convention, and the two are mixed together, so they must agree.
  const a = thetaR.sub(theta);
  const ca = cos(a);
  const sa = sin(a);
  const n = normalLocal as any;
  const bnx = n.x.mul(ca).sub(n.z.mul(sa));
  const bnz = n.x.mul(sa).add(n.z.mul(ca));
  // peeled-material normal: rotate the REST normal about Y by the same frame the
  // position uses — the peel front's meridian advance (+φW), the swirl, MINUS the
  // per-vertex CURL angle γ (rolling backward around the curl cylinder; at γ=π
  // the flap is inverted, adhesive-side out). Behind the front the vertex lies
  // on the cylinder, so it takes the ROLLED normal — blended in a narrow band
  // around the front (where the orientations nearly coincide, so the mix can't
  // collapse toward zero).
  const wN = wSt;
  const seamRest = t0.sub(uSpan.mul(0.5 * WRAP_DIR));
  const sAng = wrapPi(theta.sub(seamRest)).mul(WRAP_DIR) as any; // angle from rest seam
  const phiW = min(sAng, front) as any; // sheared front, same as the position graph
  // same curl scaling as the position graph
  const gammaN = min(sAng.sub(phiW).div(uCurlR), CURL_MAX).mul(curlEff) as any;
  // swirl scaled by the same PER-PIECE reel-in release as the position graph
  const pinN = smoothstep(0.0, 0.25, wN).mul(uRewrapOn) as any;
  const mN = clamp(float(1).sub(pinN), 0.0, 1.0) as any;
  const beta = seamRest
    .add(swirl.mul(mN))
    .add(phiW.mul(WRAP_DIR))
    .sub(theta)
    .sub(gammaN.mul(WRAP_DIR));
  const cb = cos(beta);
  const sb = sin(beta);
  const fnx = n.x.mul(cb).sub(n.z.mul(sb));
  const fnz = n.x.mul(sb).add(n.z.mul(cb));
  // 1 behind the front; gated by stuck-ness so a fully-peeled piece (w=0) never
  // samples rolled normals in the seam-adjacent band
  const iWrap = smoothstep(-0.25, 0.0, phiW.sub(sAng)).mul(
    smoothstep(0.0, 0.08, wN),
  ) as any;
  // n.y is preserved by both the bloom and the flat Y-rotations, so it passes through
  const nx = mix(fnx, bnx, iWrap) as any;
  const nz = mix(fnz, bnz, iWrap) as any;
  // Formation spread: rotate the resolved normal about Y by the SAME cumulative
  // axis-rotation the position graph applies (each op adds its angle to state.rot as
  // it adds it to state.theta), in the same +α sense as above. formation.rot = 0 when
  // every channel is 0, so this is an exact identity when the term is off.
  const cH = cos(formation.rot);
  const sHn = sin(formation.rot);
  const preN = vec3(
    nx.mul(cH).sub(nz.mul(sHn)),
    n.y,
    nx.mul(sHn).add(nz.mul(cH)),
  ) as any;
  // CARDIFY: blend toward the card plane normal — ±(cos thC, 0, sin thC), the
  // sign taken from the REST normal's radial component (outer face out, inner
  // face in). Side walls (radial ≈ 0) keep the deformed normal — a full blend
  // there would collapse toward the zero vector. Exact identity at cardK = 0.
  const nRad = n.x.mul(cos(theta)).add(n.z.mul(sin(theta))) as any;
  const thCN = seamRest.add(swirl.mul(mN)) as any; // the flown card frame
  const cardN = vec3(
    cos(thCN).mul(sign(nRad)),
    0,
    sin(thCN).mul(sign(nRad)),
  ) as any;
  const wCard = cardK.mul(smoothstep(0.15, 0.5, abs(nRad))) as any;
  return normalize(mix(preN, cardN, wCard) as any);
}

// normalNode is consumed as a VIEW-space vector (NodeMaterial.setupNormal returns
// it untransformed; the fallback it replaces is normalView). normalGraphLocal is
// built in object space, so hand it over transformed. At idle the whole graph
// reduces to transformNormalToView(normalLocal) — three's own normalViewGeometry.
function normalGraph(f: ReturnType<typeof fields>): any {
  return transformNormalToView(normalGraphLocal(f));
}

// Single-graph position builder (evaluates fields() itself): used by the
// instrument's own probe (dev/path-probe → bloomLocalPosition) and by the line
// attach path (no normal), where a shared fields() bag buys nothing.
const bloomPosition = Fn(() => positionGraph(fields()));

/** One fields() evaluation, both graphs derived from it. TSL does not CSE across
 *  distinct node objects, so sharing the ONE fields() instance is what dedupes the
 *  deform (and its once-folded formations) between position and normal. */
function bloomGraph(): { position: any; normal: any } {
  const f = fields();
  return { position: positionGraph(f), normal: normalGraph(f) };
}

// Cache one bloom NodeMaterial per source material (share one instance per
// source-material so program counts stay low; all wedges scrub the same uniforms).
const cache = new WeakMap<THREE.Material, THREE.Material>();

function makeBloomMaterial(src: THREE.Material): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial();
  m.copy(src as THREE.MeshStandardMaterial); // color / roughness / metalness / transparency
  attachBloom(m); // shares ONE fields() evaluation across position + normal
  return m;
}

/** A fresh copy of the bloom-deformed LOCAL position graph (for the depth fade,
 *  which needs the in-shader explode motion the built-in positionView node misses).
 *  A node can't be shared across materials, so this builds a new instance each call. */
export function bloomLocalPosition(): ReturnType<typeof bloomPosition> {
  return bloomPosition();
}

// The radius-order table assignShellRates builds, kept so NON-bloom parts (on-axis
// glass, solid rings) can be ranked on the SAME law — see seatRankOf.
let RADIUS_ORDER: number[] = [];

/** The ONE seat-rank law: a 0.01mm radius bucket → 0..1, normalized across the
 *  model's radius SPAN. Shared by the shells' `_bloomrate` and by seatRankOf's
 *  non-bloom branch so both consumers rank identically. */
function rankOfKey(key: number): number {
  if (RADIUS_ORDER.length < 2) return 0.5;
  const lo = RADIUS_ORDER[0];
  const hi = RADIUS_ORDER[RADIUS_ORDER.length - 1];
  return Math.min(1, Math.max(0, (key - lo) / Math.max(1, hi - lo)));
}

/**
 * Assign every bloom-carrying mesh its `_bloomrate` rank (0..1): the shell's
 * position in the ascending order of all distinct shell radii. The shader turns
 * this into an ORDER-PRESERVING dilation-rate stagger — concentric shells get
 * distinctly different rates (so near-equal-radius skins separate) while final
 * radius stays strictly monotone in rest radius (no shell overtakes another).
 * Radii are bucketed to 0.01mm so float noise within one shell shares a rank;
 * features seated on a shell (addShellBloomAttributes) carry the shell's exact R
 * and land in the same bucket, staying in lock-step. Run AFTER seatShellFeatures
 * and BEFORE first render.
 */
export function assignShellRates(root: THREE.Object3D): void {
  const geos: { geo: THREE.BufferGeometry; key: number }[] = [];
  const keys = new Set<number>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const rAttr = o.geometry.getAttribute("_bloomr");
    if (!rAttr || o.geometry.getAttribute("_bloomrate")) return;
    const key = Math.round(rAttr.getX(0) * 100); // 0.01mm bucket
    geos.push({ geo: o.geometry, key });
    keys.add(key);
  });
  const order = [...keys].sort((a, b) => a - b);
  RADIUS_ORDER = order;
  // Rank by normalized radius VALUE, not by position in the sorted order. Both are
  // monotone in radius (so no shell can overtake another — the property the stagger
  // needs), but ORDER throws away how far apart shells actually are: a grip ring and
  // the barrel it is glued to, 0.3mm apart, got the same rank gap as two shells 30mm
  // apart, flew on visibly different timelines, and interleaved. Owner-reported as
  // "inner pieces intersect the other ones". With value ranking the timing gap is
  // proportional to real separation, so touching pieces move together.
  const rank = new Map(order.map((k) => [k, rankOfKey(k)]));
  for (const { geo, key } of geos) {
    const n = geo.getAttribute("position").count;
    geo.setAttribute(
      "_bloomrate",
      new THREE.BufferAttribute(
        new Float32Array(n).fill(rank.get(key) ?? 0.5),
        1,
      ),
    );
  }
}

/** Atlas grid the cardify photo texture is tiled on (cards.ts builds it; the
 *  tile index assigned below wraps into GRID² tiles). */
export const CARD_ATLAS_GRID = 4;

/**
 * Precompute every bloom vertex's CARD material coordinates (see the uCardify
 * block): `_carduv` = (u, v) — the vertex's arc/axial position normalized over
 * its own wedge's TRUE extents, so cut jitter and overhang land exactly on the
 * card's rectangle edge — and `_cardc` = (atlas tile, axial mid, arc mid), the
 * per-wedge constants that centre the uniform card on the sheet.
 *
 * Vertices are bucketed by (shell radius, sector centre): a wedge AND the
 * features/decals seated on it (addShellBloomAttributes stamps them with the
 * shell's exact R and a wedge centre) share a bucket, so a screw or engraving
 * maps to its true spot ON the wedge's card and flattens into it. Buckets are
 * ordered outer-shell-first for a stable tile index. Run AFTER
 * seatShellFeatures (features need their `_bloom*`) and BEFORE the first
 * material build (the graphs read the attributes).
 */
export function assignCardAttributes(root: THREE.Object3D): void {
  const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  // Same arc coordinate as the shader's peel/rollout: angle from the WRAP_DIR
  // seam edge, measured in the peel direction (s ∈ [0, span] nominal).
  const arcOf = (theta: number, t0: number) =>
    wrapA(theta - (t0 - (EVEN_SPAN / 2) * WRAP_DIR)) * WRAP_DIR;
  interface Bucket {
    rKey: number;
    t0: number;
    sMin: number;
    sMax: number;
    yMin: number;
    yMax: number;
    tile: number;
  }
  const buckets = new Map<string, Bucket>();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry;
    if (!g.getAttribute("_bloomr") || g.getAttribute("_carduv")) return;
    meshes.push(o);
  });
  // Sector centres are CLUSTERED (nearest existing within 0.15 rad), never
  // float-keyed: a decal/feature whose baked t0 differs from its wedge's by a
  // rounding hair must land in the SAME bucket, or it normalizes over its own
  // tiny extent and blows up to a full phantom card.
  const t0Clusters = new Map<number, number[]>();
  const keyOf = (rKey: number, t0: number): string => {
    let list = t0Clusters.get(rKey);
    if (!list) {
      list = [];
      t0Clusters.set(rKey, list);
    }
    for (let i = 0; i < list.length; i++)
      if (Math.abs(wrapA(list[i] - t0)) < 0.15) return `${rKey}|${i}`;
    list.push(t0);
    return `${rKey}|${list.length - 1}`;
  };
  // pass 1: true material extents per (shell, sector) bucket
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const rA = g.getAttribute("_bloomr");
    const tA = g.getAttribute("_bloomtheta0");
    for (let i = 0; i < pos.count; i++) {
      const t0 = -tA.getX(i);
      const rKey = Math.round(rA.getX(i) * 100); // assignShellRates' bucket
      const s = arcOf(Math.atan2(pos.getZ(i), pos.getX(i)), t0);
      const y = pos.getY(i);
      const k = keyOf(rKey, t0);
      let b = buckets.get(k);
      if (!b) {
        b = {
          rKey,
          t0,
          sMin: s,
          sMax: s,
          yMin: y,
          yMax: y,
          tile: 0,
        };
        buckets.set(k, b);
      } else {
        b.sMin = Math.min(b.sMin, s);
        b.sMax = Math.max(b.sMax, s);
        b.yMin = Math.min(b.yMin, y);
        b.yMax = Math.max(b.yMax, y);
      }
    }
  }
  // stable tile order: outer shells first, then by sector angle
  const ordered = [...buckets.values()].sort(
    (a, b) => b.rKey - a.rKey || a.t0 - b.t0,
  );
  const tiles = CARD_ATLAS_GRID * CARD_ATLAS_GRID;
  ordered.forEach((b, i) => (b.tile = i % tiles));
  // pile ladder: card-plane radius per shell, walked innermost-out with a
  // minimum CARD_PILE_GAP_MM between consecutive planes (see the const)
  const shellKeys = [...new Set([...buckets.values()].map((b) => b.rKey))].sort(
    (a, b) => a - b,
  );
  const radOff = new Map<number, number>();
  let prevRad = -Infinity;
  for (const k of shellKeys) {
    const rad = Math.max(k / 100, prevRad + CARD_PILE_GAP_MM);
    radOff.set(k, rad - k / 100);
    prevRad = rad;
  }
  // pass 2: per-vertex normalized coords + per-bucket constants. The effective
  // card dims (see CARD_STRETCH_MAX) ride in `_carduv`.zw so the shader needs
  // no per-bucket lookup.
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const rA = g.getAttribute("_bloomr");
    const tA = g.getAttribute("_bloomtheta0");
    const n = pos.count;
    const uv = new Float32Array(n * 4);
    const cc = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const t0 = -tA.getX(i);
      const rKey = Math.round(rA.getX(i) * 100);
      const b = buckets.get(keyOf(rKey, t0))!;
      const s = arcOf(Math.atan2(pos.getZ(i), pos.getX(i)), t0);
      const arcMm = ((b.sMax - b.sMin) * b.rKey) / 100;
      const yMm = b.yMax - b.yMin;
      uv[i * 4] = (s - b.sMin) / Math.max(1e-6, b.sMax - b.sMin);
      uv[i * 4 + 1] = (pos.getY(i) - b.yMin) / Math.max(1e-6, b.yMax - b.yMin);
      uv[i * 4 + 2] = Math.min(CARD_W_MM, arcMm * CARD_STRETCH_MAX);
      uv[i * 4 + 3] = Math.min(CARD_H_MM, yMm * CARD_STRETCH_MAX);
      cc[i * 4] = b.tile;
      cc[i * 4 + 1] = (b.yMin + b.yMax) / 2;
      cc[i * 4 + 2] = (b.sMin + b.sMax) / 2;
      cc[i * 4 + 3] = radOff.get(b.rKey) ?? 0;
    }
    g.setAttribute("_carduv", new THREE.BufferAttribute(uv, 4));
    g.setAttribute("_cardc", new THREE.BufferAttribute(cc, 4));
  }
}

/**
 * The seat rank (0..1) of an arbitrary node on the SAME law the shader uses for
 * shells: position in the ascending order of distinct shell radii. A node that
 * carries (or contains) bloom geometry returns its shell's exact `_bloomrate`;
 * anything else — on-axis glass, solid rings — is ranked by its own maximum radial
 * extent placed into that same sorted table.
 *
 * ONE law for both consumers. The rig used to rank by explode rung, but how FAR a
 * part travels was never the same question as WHEN it seats: on a shared beat that
 * mismatch seats a solid body while its own shell's wedges are still airborne.
 *
 * Call AFTER assignShellRates and after the model is recentred (the non-bloom branch
 * reads world-space bounds). Walks geometry and allocates — resolve per part ONCE at
 * rig construction, never per frame.
 */
export function seatRankOf(obj: THREE.Object3D): number {
  let rate: number | null = null;
  obj.traverse((o) => {
    if (rate != null || !(o instanceof THREE.Mesh)) return;
    const a = o.geometry.getAttribute("_bloomrate");
    if (a) rate = a.getX(0);
  });
  if (rate != null) return rate;
  const box = new THREE.Box3().setFromObject(obj);
  const rMaxWorld = Math.max(
    Math.abs(box.min.x),
    Math.abs(box.max.x),
    Math.abs(box.min.z),
    Math.abs(box.max.z),
  );
  // setFromObject measures WORLD units, but RADIUS_ORDER is keyed in model-mm
  // (the geometry's own frame — the GLB exports real millimeters; the root then
  // scales the whole model down). Un-scale, or every solid's key lands below the
  // table's first bucket and clamps to rank 0 — which put all 36 solids in ONE
  // settle window (instrument-caught: every solid measured rank 0 at runtime).
  const scl = new THREE.Vector3();
  obj.getWorldScale(scl);
  const rMax = rMaxWorld / (scl.x || 1);
  const key = Math.round(rMax * 100); // same 0.01mm bucket as assignShellRates
  return rankOfKey(key); // same law as the shells — one ranking, two consumers
}

/** True if a mesh carries the bloom attributes (a wedge or a decal on a cut shell). */
export function hasBloom(mesh: THREE.Mesh): boolean {
  return mesh.geometry.getAttribute("_bloomr") != null;
}

/**
 * Attach the bloom/unwrap position+normal graphs to any Node material, so the
 * shading modes (materials/shading.ts) deform their wedges too. Each call builds fresh
 * node instances (a node can't be shared across materials).
 */
export function attachBloom(material: THREE.NodeMaterial): any {
  const { position, normal } = bloomGraph();
  material.positionNode = position;
  material.normalNode = normal;
  return position; // callers feed the SAME node to depthFadeFactor (no second graph)
}

/** Attach only the bloom position graph — for line materials, which have no normal.
 *  Returns the position node so the caller can share it with the depth fade. */
export function attachBloomLine(material: THREE.NodeMaterial): any {
  const position = bloomPosition();
  material.positionNode = position;
  return position;
}

/** Inverted-hull attach for the outline shading mode: the bloom-deformed position
 *  pushed OUT along the bloom-deformed object-space normal by `width` (model mm),
 *  so a BackSide hull stays a constant-thickness contour through explode/unwrap.
 *  One fields() bag feeds both graphs, same dedupe as attachBloom. */
export function attachBloomHull(
  material: THREE.NodeMaterial,
  width: number,
): void {
  const f = fields();
  material.positionNode = positionGraph(f).add(
    normalGraphLocal(f).mul(width) as any,
  );
}

/**
 * EdgesGeometry that carries the `_bloom*` attributes so its line material can run
 * the same bloom position graph and deform with the shell. EdgesGeometry drops
 * custom attributes, so we copy them back by matching each edge vertex to its
 * source vertex by position. Unmatched verts fall back to a self-consistent bloom
 * (r = own radius, θ0 = own meridian ⇒ ~identity there) so they never divide by 0.
 */
export function bloomEdgeGeometry(
  src: THREE.BufferGeometry,
  thresholdDeg = 24,
): THREE.BufferGeometry {
  const eg = new THREE.EdgesGeometry(src, thresholdDeg);
  const sp = src.getAttribute("position");
  const sR = src.getAttribute("_bloomr");
  const sT0 = src.getAttribute("_bloomtheta0");
  const sRate = src.getAttribute("_bloomrate");
  if (!sp || !sR || !sT0) return eg; // not a bloom mesh
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
  const map = new Map<string, number>();
  for (let i = 0; i < sp.count; i++)
    map.set(key(sp.getX(i), sp.getY(i), sp.getZ(i)), i);

  const ep = eg.getAttribute("position");
  const n = ep.count;
  const aR = new Float32Array(n);
  const aT0 = new Float32Array(n);
  const aRate = new Float32Array(n);
  // cardify coords ride along too (the line material runs the same position
  // graph); unmatched verts fall back to the card centre — harmless, the lines
  // fade out with the photo crossfade anyway (shading.ts).
  const sUV = src.getAttribute("_carduv");
  const sCC = src.getAttribute("_cardc");
  const aUV = new Float32Array(n * 4);
  const aCC = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = ep.getX(i);
    const y = ep.getY(i);
    const z = ep.getZ(i);
    const si = map.get(key(x, y, z));
    if (si != null) {
      aR[i] = sR.getX(si);
      aT0[i] = sT0.getX(si);
      aRate[i] = sRate ? sRate.getX(si) : 0.5; // 0.5 ⇒ the neutral mid rate
      if (sUV) {
        aUV[i * 4] = sUV.getX(si);
        aUV[i * 4 + 1] = sUV.getY(si);
        aUV[i * 4 + 2] = sUV.getZ(si);
        aUV[i * 4 + 3] = sUV.getW(si);
      }
      if (sCC) {
        aCC[i * 4] = sCC.getX(si);
        aCC[i * 4 + 1] = sCC.getY(si);
        aCC[i * 4 + 2] = sCC.getZ(si);
        aCC[i * 4 + 3] = sCC.getW(si);
      }
    } else {
      aR[i] = Math.hypot(x, z) || 1; // fallback: identity-ish bloom, never r=0
      aT0[i] = -Math.atan2(z, x); // shader negates ⇒ θ0 = own meridian
      aRate[i] = 0.5;
      aUV[i * 4] = 0.5;
      aUV[i * 4 + 1] = 0.5;
      aCC[i * 4 + 1] = y; // yMid = own y ⇒ the card centre sits at the vertex
    }
  }
  eg.setAttribute("_bloomr", new THREE.BufferAttribute(aR, 1));
  eg.setAttribute("_bloomtheta0", new THREE.BufferAttribute(aT0, 1));
  eg.setAttribute("_bloomrate", new THREE.BufferAttribute(aRate, 1));
  eg.setAttribute("_carduv", new THREE.BufferAttribute(aUV, 4));
  eg.setAttribute("_cardc", new THREE.BufferAttribute(aCC, 4));
  return eg;
}

/**
 * Give a NON-segmented mesh the `_bloom*` attributes of the SHELL it rides, so it
 * blooms in lock-step with that shell instead of being handled as a loose part.
 * Used for small features mounted on a segmented shell (screw rings, bores) that
 * live in their own mesh: each vertex is assigned the shell radius `R` and the
 * nearest wedge sector centre from `centers` (real angles, radians), so it dilates,
 * twists and angular-compresses exactly like the wedge beneath it — staying seated.
 * `centers`/`R` come from the shell's own wedges (see gatherShellBloom).
 */
export function addShellBloomAttributes(
  geo: THREE.BufferGeometry,
  centers: number[],
  R: number,
): void {
  const pos = geo.getAttribute("position");
  if (!pos || geo.getAttribute("_bloomr") || centers.length === 0) return;
  const n = pos.count;
  const aR = new Float32Array(n).fill(R);
  const aT0 = new Float32Array(n);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

  // Sector assignment is per CONNECTED COMPONENT, not per vertex: a contiguous
  // piece that straddles a sector boundary (the contact connector, the shelf
  // arc) must not have its halves follow two different wedges — the peel frames
  // diverge and the geometry between them STRETCHES into a long bar (owner
  // caught it on the connector). Components are found by union-find over the
  // triangle indices PLUS coincident positions (seam-duplicated vertices), so a
  // ring of screws still resolves to many islands — each screw riding its own
  // local wedge — while every island gets exactly one sector.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = geo.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      union(idx.getX(i), idx.getX(i + 1));
      union(idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i + 2 < n; i += 3) {
      union(i, i + 1);
      union(i + 1, i + 2);
    }
  }
  const posKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
    const first = posKey.get(k);
    if (first === undefined) posKey.set(k, i);
    else union(first, i);
  }

  // component centroids in the radial plane → one sector centre per component
  const sumX = new Map<number, number>();
  const sumZ = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r0 = find(i);
    sumX.set(r0, (sumX.get(r0) ?? 0) + pos.getX(i));
    sumZ.set(r0, (sumZ.get(r0) ?? 0) + pos.getZ(i));
  }
  const rootT0 = new Map<number, number>();
  for (const [root, sx] of sumX) {
    const theta = Math.atan2(sumZ.get(root)!, sx);
    let best = centers[0];
    let bd = Infinity;
    for (const c of centers) {
      const d = Math.abs(wrap(theta - c));
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    rootT0.set(root, -best); // shader negates _bloomtheta0 ⇒ store −centre
  }
  for (let i = 0; i < n; i++) aT0[i] = rootT0.get(find(i))!;

  geo.setAttribute("_bloomr", new THREE.BufferAttribute(aR, 1));
  geo.setAttribute("_bloomtheta0", new THREE.BufferAttribute(aT0, 1));
}

/**
 * Sample a segmented shell's wedge sector centres (real angles, radians) and its
 * median shell radius from the `_bloom*` attributes its wedges already carry — the
 * inputs for addShellBloomAttributes on a feature riding that shell.
 */
export function gatherShellBloom(shell: THREE.Object3D): {
  centers: number[];
  R: number;
} {
  const centers: number[] = [];
  const radii: number[] = [];
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  shell.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const t0 = o.geometry.getAttribute("_bloomtheta0");
    const r = o.geometry.getAttribute("_bloomr");
    if (!t0 || !r) return;
    const c = -t0.getX(0); // stored negated ⇒ real sector centre
    if (!centers.some((x) => Math.abs(wrap(x - c)) < 0.2)) centers.push(c);
    for (let i = 0; i < r.count; i++) radii.push(r.getX(i));
  });
  radii.sort((a, b) => a - b);
  const R = radii.length ? radii[radii.length >> 1] : 1;
  return { centers, R };
}

/**
 * Swap every bloom-carrying mesh under `root` to a bloom NodeMaterial. Returns a
 * disposer for the materials it created.
 */
export function applyBloom(root: THREE.Object3D): () => void {
  const created = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasBloom(o)) return;
    // In-shader radial displacement invalidates the mesh's rest-pose bounds, so
    // stale-bounds frustum culling would pop exploded wedges out (latent bug).
    o.frustumCulled = false;
    const src = o.material as THREE.Material;
    let bm = cache.get(src);
    if (!bm) {
      bm = makeBloomMaterial(src);
      cache.set(src, bm);
      created.add(bm);
    }
    o.material = bm;
  });
  return () => created.forEach((m) => m.dispose());
}
