import * as THREE from "three/webgpu";
import {
  Fn,
  uv,
  uniform,
  vec2,
  vec4,
  float,
  pow,
  max,
  min,
  abs,
  cos,
  sin,
  mix,
  step,
  smoothstep,
  pass,
} from "three/tsl";
import type { TslNode } from "../ops/algebra-tsl";
import { uWormhole, uPinchStrength, uProfilePow } from "./warp";

// ============================================================================
// THE WORMHOLE, IN SCREEN SPACE — the pinch moved out of the sky and into the
// FRAME, so it warps everything the camera sees: the barrel, the internals, the
// blades, the glass and the starfield alike.
//
// WHY IT MOVED. The old pinch (optics/warp.ts) bent the SAMPLE DIRECTION before
// the baked sky was read, which meant it could only ever distort the sky — the
// lens model draws on top of its own background node (Background.js:91-133), so
// every mesh stayed geometrically pristine while the stars streamed behind it.
// The owner's note is exactly that: "the internals of the lens suffer no
// distortion. If it's a wormhole it should alter the space including the lens."
// A screen-space remap is the honest answer, and it is the CAMERA's answer
// rather than a per-object one: nothing in materials/, ops/ or core/model.ts is
// touched, and the effect cannot disagree with itself between two meshes.
//
// THE TOOLBOX, three r185. `pass(scene, camera)` (src/nodes/display/PassNode.js
// :1024) renders the whole scene into its own render target and hands back a
// node; `.getTextureNode()` (:649) is that target as a TextureNode, and
// `.sample(uvNode)` (src/nodes/accessors/TextureNode.js:678) re-reads it at ANY
// uv — three's own effects do exactly this (examples/jsm/tsl/display/
// radialBlur.js reads `textureNode.sample(uv)` in a loop). `RenderPipeline`
// (src/renderers/common/RenderPipeline.js, of which the older `PostProcessing`
// name is now a deprecated alias, :9) owns the fullscreen quad and, in its
// `render()`, parks the renderer's tone mapping while the scene pass fills the
// target and re-applies it on the output — so the post path and the direct
// `renderer.render` path land on the same colours.
//
// THE REMAP: a radial pinch whose SHAPE is a circle and whose EDGE-SAFETY is a
// rectangle, kept strictly apart:
//
//     d    = uv − throat                      (uv-space offset)
//     r    = |d · (aspect, 1)|                (aspect-corrected radius)
//     circ = max(1 − r/rEdge, 0) ^ profilePow  the funnel's shape: 1 at the
//                                             throat → 0 at the corner circle
//     ex   = throat→edge distance on the side d.x points to (ey likewise)
//     ρ    = max(|d.x|/ex, |d.y|/ey)          fraction of the way to the FRAME
//                                             BORDER along this pixel's own
//                                             ray: exactly 1 on the border
//     win  = 1 − smoothstep(EDGE_FADE, 1, ρ)  border window: 1 through the
//                                             interior, → 0 at the border
//     k    = uWormhole · pinchStrength · circ · win
//     uv'  = uv + d·k
//
// which is r' = r·(1 + k), the same "scale the perpendicular part by m ≥ 1"
// the sky pinch used. ρ is exact: the border sits at parameter
// T = min(ex/|d.x|, ey/|d.y|) along the ray `throat + t·d`, the pixel sits at
// t = 1, and ρ = 1/T = the max of the per-axis ratios — max-of-divisions costs
// no branch and cannot divide by zero (ex, ey are clamped ≥ 1e-4 in `sync`).
// Sampling FURTHER out than the pixel's own radius draws the frame's content
// INWARD, which is the funnel: the wider world is squeezed toward the throat
// and everything between bends after it.
//
// WHY TWO TERMS AND NOT ONE. Using ρ as the profile itself pins the border,
// but it also hands the funnel's strength contours the frame's shape — the
// falloff then reaches farther along the diagonals (corners are far) than
// along the axes (edges are near), and the pinch bulges into four corner
// lobes; the owner read it instantly as "a 4-leaf clover". So the profile
// stays the CIRCLE (`circ`, aspect-corrected, dead at the nearest-corner
// circle — the pre-fix shape, clover-free), and the rectangle appears only as
// `win`, a window that is identically 1 until EDGE_FADE of the way to the
// border and fades over the last stretch. Interior shape: circular. Border:
// pinned on all four sides at every aspect.
//
// EXACT AT REST, BY CONSTRUCTION. `uWormhole = 0` makes `k` exactly 0, `d·0`
// exactly the zero vector and `uv + 0` exactly `uv`, so the pass is a pixel
// passthrough of the scene target whenever the ramp is down — written as the
// offset form for precisely that reason (a `mix` or a `·m` round trip through
// the aspect vector would not be). EVERY LATER FEATURE RIDES `k` OR `uWormhole`
// for the same reason: the chromatic aberration's channel offsets are fractions
// of `k` (CA_LOOK) and the ring's contributions are weighted by a mask carrying
// `uWormhole` — so the identity needs no test for rest and no branch to hold. Better still, core/scene.ts UNMOUNTS the
// whole pipeline outside the fly-through, so the shipped site never routes a
// frame through this file at all.
//
// THE EDGE, which a screen pass has to answer for. The funnel wants to read
// from outside the frame at the periphery, and a screen pass cannot overscan
// its source cheaply (the scene would have to be rendered at a wider FOV into
// a bigger target). Circle-only (the first cut) failed at wide aspects: the
// frame is a rectangle INSCRIBED in the corner circle, so the mid-edges of
// the short dimension (top/bottom in a wide window: r = 0.5 against a corner
// circle at ~1.12 for 2:1) still carried live displacement, sampled past the
// frame, and the sampler's clamp-to-edge smeared a discontinuous band there.
// Rectangle-only (the second cut) fixed the smear and grew the clover. The
// product does both jobs. Safety at the border is by the window's own decay:
// staying inside the frame needs k ≤ (1−ρ)/ρ, and near ρ = 1 the smoothstep
// gives win ≈ 3((1−ρ)/(1−EDGE_FADE))², so k·ρ/(1−ρ) → 0 — border samples
// stay inside for any sane strength. Inside the window (win = 1) the old
// circular bound governs: k ≤ 1/max_x[x(1−x)^(p−1)] = 4.55 at profilePow 2.2,
// comfortably above pinchStrength; a live-tuned strength far past that can
// still smear mid-band, so ~4.5 remains the knob's documented ceiling.
// ============================================================================

/** The exit axis: world +X, the fly-through's one heading and the direction
 *  optics/sky.ts bakes its streaks toward. Hard-coded for the same reason the
 *  sky's throat is — nothing else flies. */
const EXIT_AXIS = new THREE.Vector3(1, 0, 0);

/** The four frame corners in uv, for the `rEdge` minimum below. */
const CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** Where the border window starts fading, as a fraction of the throat→border
 *  distance: 1 (no effect) until here, 0 at the border. Lower = the calm rim
 *  creeps further into the frame; higher = a harder stop near the edge. */
const EDGE_FADE = 0.75;

/** Guard for every divide below, as one number. */
const EPS = 1e-4;

// ── THE EINSTEIN RING ────────────────────────────────────────────────────────
//
// The owner's reference is the NASA wormhole plate: radial star streaks in the
// far field, a CALM DISC at the centre showing the destination, and between them
// a wide TURBULENT ANNULUS — speckled starlight smeared into concentric arcs,
// with the same strata appearing twice, mirrored about the ring. Their note:
// "wormholes also have the circular ring that goes around the centre from the
// refraction on the surface."
//
// It is built HALF HERE AND HALF IN THE SPRITES (optics/starfield.ts, where the
// stars inside a band of angles swing their streaks from radial to tangential).
// The sprites give the arcs their marks; this gives the whole frame — barrel,
// internals, glass and stars alike — the two things a screen pass can do and
// geometry cannot:
//
//   THE FOLD. Inside the band, mix in a second sample taken at the MIRRORED
//   radius r' = 2·rRing − r, in the same direction from the throat. Radii
//   inside the ring read what is outside it and vice versa, which is exactly
//   the duplicated, mirrored strata of the plate.
//
//   THE SMEAR. Inside the band, average a few samples taken at the pixel's own
//   radius but ROTATED about the throat by a small angle, which drags detail
//   ALONG the ring and turns speckle into concentric streaks.
//
// THREE RULES, all three load-bearing:
//   1. uWormhole = 0 is still an EXACT pixel passthrough. Every ring term is
//      folded in with `mix(base, extra, mask)` where `mask` carries uWormhole as
//      a factor, so at rest the weight is exactly 0 and `mix` returns `base`
//      bit-for-bit (a + 0·(b − a)). The extra samples are still TAKEN — they
//      simply cannot contribute — which keeps the shader branch-free.
//   2. THE FRAME EDGES STAY PINNED. The mask carries the border window `win`
//      too, and on top of that every extra sample's offset is clamped by
//      `keepInFrame` to EDGE_KEEP of the way to the border ALONG ITS OWN RAY —
//      a rotated or mirrored sample leaves the pixel's ray, so the window's
//      per-ray argument does not cover it and an explicit clamp does.
//   3. THE CENTRE STAYS CALM. The band mask is a bump in radius that is flat 0
//      inside rRing − ringWidth, so the destination disc is untouched.
//
// COST AND THE 8KB WALL. WebKit-on-Metal caps a shader's private memory at 8KB.
// The taps are a fixed, small, JS-unrolled set — 1 fold + 2·SMEAR_TAPS smear —
// with no arrays and no dynamic loop, so the whole ring is a couple of dozen
// scalar ops and seven texture reads. TEN IN THE WHOLE PASS, counting the three
// the chromatic base takes (CA_LOOK below). Every one is a straight-line read of
// the same texture with a computed uv: no live registers accumulate with them
// beyond the vec4 they return, which is why ten sits nowhere near the wall.
const SMEAR_TAPS = 3;

/** How far along its own ray toward the frame border an extra sample may reach.
 *  Just under 1: at exactly 1 it would land ON the border and pick up the
 *  sampler's clamp. */
const EDGE_KEEP = 0.98;

/** The ring's SHAPE knobs, defaults for the uniforms below (all live on
 *  `window.__lensWormhole`). Both radii are fractions of `rEdge`, the aspect-
 *  corrected radius at which the pinch itself dies — so the ring scales with
 *  the frame instead of drifting across it as the window changes shape. */
export const RING_LOOK = {
  /** the band's centre. Placed to overlap where the sprite arcs land: the
   *  starfield's band sits at γ ≈ 0.45 rad, which at the dive's fov 70 projects
   *  to roughly a third of the frame radius before the pinch pulls it inward. */
  ringRadius: 0.36,
  /** HALF the band's width — the mask is 1 at ringRadius and smoothly 0 at
   *  ±this, so the annulus spans 0.20 … 0.52 of rEdge at the defaults. Wide on
   *  purpose: the reference's annulus is broad and turbulent, not a hairline. */
  ringWidth: 0.16,
  /** how much of the MIRRORED sample is mixed in at the centre of the band.
   *  0 = no fold. 1 = the mirrored image replaces the frame inside the band,
   *  which reads as a hole; half of it reads as strata. */
  foldGain: 0.5,
  /** the widest rotation of a smear tap, radians about the throat. Small: this
   *  is a smear, and a large arc turns the ring into a blurred donut. */
  smearArc: 0.12,
  /** how much of the smeared average is mixed in at the centre of the band.
   *  0 = the taps are taken and discarded (still an exact passthrough). */
  smearMix: 0.7,
};
// ── CHROMATIC ABERRATION ─────────────────────────────────────────────────────
//
// The owner's note: "I don't see any color from the chromatic aberration." A
// lens that bends light bends the three wavelengths by different amounts, and
// this pass is nothing BUT a bend — so the honest place for the colour is the
// displacement itself. The base sample is taken three times, at k·(1 − caShift),
// k and k·(1 + caShift), and the red, green and blue channels are recombined
// from them. Red lands short of green and blue past it, exactly like a real
// uncorrected element.
//
// IT COSTS NOTHING AT REST, WITH NO EXTRA MACHINERY. The offsets are FRACTIONS
// OF k, and k is already exactly 0 whenever uWormhole is (the header's exactness
// note), so k·(1 ± caShift) is exactly 0 too, all three samples read the same
// texel, and the recombined pixel is bit-identical to the single sample it
// replaced. The fringe is therefore born where the distortion is — strongest in
// the annulus, nothing at the calm centre (|d| → 0), nothing at the border (the
// window kills k), nothing at all at rest.
//
// WHERE IT PEAKS, in numbers, because the default has to be judged not guessed:
// the displacement is |d|·k ∝ x(1 − x)^profilePow for x = r/rEdge, which peaks at
// x = 1/(1 + profilePow) = 0.31 — just inside the ring — at ~0.36 of rEdge in uv.
// The red-to-blue separation there is 2·caShift·0.36·rEdge — ~3.6% of the
// frame's half-height at 0.05, ~1.4% at 0.02. The default is 0.02, judged BY
// EYE on the dense starfield: 0.05 split each streak into three distinct
// coloured copies (the duplicated-star look the owner has already rejected
// once), while 0.02 reads as prismatic fringing on the streak tips.
//
// RING TAPS STAY SINGLE-CHANNEL. The fold and the smear are already seven reads;
// tripling them would be twenty-one, and the ring's job is shape, not colour.
export const CA_LOOK = {
  /** the red/blue split as a fraction of the pixel's own displacement. 0 = no
   *  aberration (and one wasted pair of samples); 0.02 = prismatic fringe;
   *  ≥0.05 reads as tripled stars. Live on `__lensWormhole.set({ caShift })`. */
  caShift: 0.02,
};
export const uCaShift = uniform(CA_LOOK.caShift);

export const uRingRadius = uniform(RING_LOOK.ringRadius);
export const uRingWidth = uniform(RING_LOOK.ringWidth);
export const uRingFold = uniform(RING_LOOK.foldGain);
export const uRingSmearArc = uniform(RING_LOOK.smearArc);
export const uRingSmearMix = uniform(RING_LOOK.smearMix);

export interface WormholePost {
  /** Push this frame's throat position and edge distances into the uniforms.
   *  MUST run before `render()`, from the same tick that syncs the warp. */
  sync(camera: THREE.PerspectiveCamera): void;
  /** Render the frame THROUGH the pinch, in place of `renderer.render`. */
  render(): void;
  dispose(): void;
}

export function createWormholePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  invalidate: () => void = () => {},
): WormholePost {
  // THE THROAT, in uv. Boots at frame centre — which is where the straight dive
  // keeps it — but is computed honestly every frame (see `sync`) so the early
  // beats, where the camera still carries the park's elevation, anchor on the
  // real vanishing point of the exit axis rather than on an assumption.
  const uThroat = uniform(new THREE.Vector2(0.5, 0.5));
  const uAspect = uniform(1);
  /** aspect-corrected radius at which the pinch has died — the nearest corner */
  const uREdge = uniform(Math.SQRT1_2);
  /** throat→border distances (x−, x+, y−, y+), clamped ≥ 1e-4 in `sync` so the
   *  shader's divisions are safe even when the throat rides a frame edge. */
  const uEdge = uniform(new THREE.Vector4(0.5, 0.5, 0.5, 0.5));

  // The scene target inherits the canvas's MSAA so the demo does not visibly
  // lose the antialiasing the direct path has (core/scene.ts asks for
  // `antialias: true`, which three turns into 4 samples — Renderer.js:275).
  const scenePass = pass(scene, camera, { samples: renderer.samples });
  const color = scenePass.getTextureNode() as unknown as TslNode;

  /** How far, as a fraction, an offset FROM THE THROAT reaches toward the frame
   *  border along its own ray: exactly 1 on the border. The header's ρ, for any
   *  offset rather than only the pixel's own. */
  const borderFraction = (o: TslNode): TslNode => {
    // Exact selects (flag·b + (1−flag)·a): the border distance on the side each
    // component points to.
    const sx: TslNode = step(0, o.x);
    const sy: TslNode = step(0, o.y);
    const ex: TslNode = sx.mul(uEdge.y).add(float(1).sub(sx).mul(uEdge.x));
    const ey: TslNode = sy.mul(uEdge.w).add(float(1).sub(sy).mul(uEdge.z));
    return max(abs(o.x).div(ex), abs(o.y).div(ey));
  };

  /** Shorten an offset from the throat, if it needs it, so it cannot reach past
   *  EDGE_KEEP of the way to the border — rule 2 of the ring header. Scales the
   *  whole vector, so the sample stays on its own ray. */
  const keepInFrame = (o: TslNode): TslNode =>
    o.mul(min(float(1), float(EDGE_KEEP).div(max(borderFraction(o), EPS))));

  /** Read the scene at `throat + offset`, never outside the frame. */
  const tap = (o: TslNode): TslNode =>
    color.sample(uThroat.add(keepInFrame(o)));

  /** Turn an offset by `ang` about the throat. Done in the ASPECT-CORRECTED
   *  frame and mapped back, so the path traced is a circle on screen and the
   *  tap's radius `r` is preserved exactly. */
  const turn = (o: TslNode, ang: TslNode): TslNode => {
    const a: TslNode = vec2(o.x.mul(uAspect), o.y);
    const c: TslNode = cos(ang);
    const s: TslNode = sin(ang);
    return vec2(
      a.x.mul(c).sub(a.y.mul(s)).div(uAspect),
      a.x.mul(s).add(a.y.mul(c)),
    );
  };

  const outputNode = Fn(() => {
    // A var: read three times below, and an inlined `uv()` would rebuild the
    // screen coordinate each time.
    const suv: TslNode = uv().toVar();
    const d: TslNode = suv.sub(uThroat).toVar();
    // The funnel's SHAPE: circular, aspect-corrected, dead at the corner circle.
    const r: TslNode = vec2(d.x.mul(uAspect), d.y).length().toVar();
    const circ: TslNode = pow(max(float(1).sub(r.div(uREdge)), 0), uProfilePow);
    // The border WINDOW.
    const win: TslNode = float(1)
      .sub(smoothstep(float(EDGE_FADE), float(1), borderFraction(d)))
      .toVar();
    const k: TslNode = uWormhole.mul(uPinchStrength).mul(circ).mul(win).toVar();
    // The OFFSET form, not `uv·m` — see the header's exactness note. THREE
    // SAMPLES, one per channel, at displacements k·(1 − caShift), k and
    // k·(1 + caShift): the chromatic aberration (see CA_LOOK). Alpha comes from
    // the middle sample, which is the one the old single read took. At rest k is
    // exactly 0, `ca` with it, and all three collapse onto `suv` — the assembled
    // vec4 is then bit-for-bit the sample this line used to be.
    const ca: TslNode = k.mul(uCaShift).toVar();
    const mid: TslNode = color.sample(suv.add(d.mul(k))).toVar();
    const base: TslNode = vec4(
      color.sample(suv.add(d.mul(k.sub(ca)))).r,
      mid.g,
      color.sample(suv.add(d.mul(k.add(ca)))).b,
      mid.a,
    );

    // ── THE RING ───────────────────────────────────────────────────────────
    // The band: a bump in radius, 1 at the ring and flat 0 outside it — so the
    // centre disc and the far field are both untouched. `uWormhole` and the
    // border window ride along, which is what makes the whole thing vanish at
    // rest and stay clear of the frame's edges.
    const rRing: TslNode = uREdge.mul(uRingRadius);
    const rWidth: TslNode = max(uREdge.mul(uRingWidth), EPS);
    const band: TslNode = float(1).sub(
      smoothstep(float(0), rWidth, abs(r.sub(rRing))),
    );
    const mask: TslNode = uWormhole.mul(band).mul(win).toVar();

    // THE FOLD: the same ray, at the radius mirrored about the ring —
    // r' = 2·rRing − r means scaling this pixel's offset by 2·rRing/r − 1, and
    // the pinch it would have carried is the pixel's own (the mirror lands
    // inside the same band, where the profile barely moves).
    const foldOff: TslNode = d
      .mul(rRing.mul(2).div(max(r, EPS)).sub(1))
      .mul(float(1).add(k));
    const folded: TslNode = mix(base, tap(foldOff), mask.mul(uRingFold));

    // THE SMEAR: the pinched offset, turned both ways by up to smearArc, in
    // equal steps. Averaged with equal weights — a taper would only narrow the
    // arc the taps already describe.
    const pinched: TslNode = d.mul(float(1).add(k)).toVar();
    const pair = (i: number): TslNode => {
      const ang: TslNode = uRingSmearArc.mul(i / SMEAR_TAPS);
      return tap(turn(pinched, ang)).add(tap(turn(pinched, ang.negate())));
    };
    let sum: TslNode = pair(1);
    for (let i = 2; i <= SMEAR_TAPS; i++) sum = sum.add(pair(i));
    const smear: TslNode = sum.div(2 * SMEAR_TAPS);
    return mix(folded, smear, mask.mul(uRingSmearMix));
  })();

  const pipeline = new THREE.RenderPipeline(
    renderer,
    outputNode as unknown as THREE.RenderPipeline["outputNode"],
  );

  const dirView = new THREE.Vector3();

  function sync(cam: THREE.PerspectiveCamera) {
    // `matrixWorldInverse` is refreshed by Camera.updateMatrixWorld, and the
    // pose was written earlier in this same tick.
    cam.updateMatrixWorld();
    // THE VANISHING POINT OF THE EXIT AXIS, done as a direction rather than as
    // a far-away point: a point at infinity is (dir, 0), so the clip-space
    // divide is by −z_view and the projection's own third column carries any
    // view offset the framing may have set. Exact wherever the axis is in
    // front of the camera.
    dirView.copy(EXIT_AXIS).transformDirection(cam.matrixWorldInverse);
    const e = cam.projectionMatrix.elements;
    const w = -dirView.z;
    if (w > 1e-6) {
      const ndcX = (e[0] * dirView.x + e[8] * dirView.z) / w;
      const ndcY = (e[5] * dirView.y + e[9] * dirView.z) / w;
      uThroat.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    }
    // Axis at or behind the camera: no vanishing point exists, so HOLD the last
    // one rather than snapping the funnel across the frame. Unreachable on the
    // dive, which faces +X from the first frame to the last.
    uAspect.value = cam.aspect;
    // The NEAREST corner, so the circular profile dies at the corner circle —
    // see the header's shape note.
    let rEdge = Infinity;
    for (const [x, y] of CORNERS) {
      const dx = (x - uThroat.value.x) * uAspect.value;
      const dy = y - uThroat.value.y;
      rEdge = Math.min(rEdge, Math.hypot(dx, dy));
    }
    uREdge.value = Math.max(rEdge, 1e-4);
    // The four throat→border distances, one per side, for the border window.
    // Clamped so a throat that strays onto (or past) a border degrades to "no
    // warp near that border" instead of a division blow-up.
    const t = uThroat.value;
    uEdge.value.set(
      Math.max(t.x, 1e-4),
      Math.max(1 - t.x, 1e-4),
      Math.max(t.y, 1e-4),
      Math.max(1 - t.y, 1e-4),
    );
  }

  // COMPILE THE PIPELINE NOW, not on the frame that first renders through it.
  // three builds a RenderPipeline's shader lazily, on its first `render()`, and
  // core/scene.ts flips `postMounted` the instant this function returns — so
  // without this the compile lands on the first tick of the dive, stalls it, and
  // the pass arrives a beat late: the filter reads as popping on rather than as
  // having been there all along. The demo mounts this at p = 0 for exactly that
  // reason, and only ANIMATES uWormhole afterward.
  //
  // Safe to draw here: uWormhole boots at 0, at which the remap is an exact
  // pixel passthrough (see the header's exactness note), so this paints the same
  // frame the direct path painted a moment ago — the compile is paid and the
  // picture does not change.
  sync(camera);
  pipeline.render();

  // The ring's five knobs and the aberration's one, live — the same shape as
  // optics/starfield.ts's `__lensStars`. They are pure look, they interact (a
  // wider band wants a shorter smear), and the pass only exists during one demo,
  // so tuning them from the console beats a rebuild per guess.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      ringRadius: { u: uRingRadius, boot: RING_LOOK.ringRadius },
      ringWidth: { u: uRingWidth, boot: RING_LOOK.ringWidth },
      foldGain: { u: uRingFold, boot: RING_LOOK.foldGain },
      smearArc: { u: uRingSmearArc, boot: RING_LOOK.smearArc },
      smearMix: { u: uRingSmearMix, boot: RING_LOOK.smearMix },
      caShift: { u: uCaShift, boot: CA_LOOK.caShift },
      pinchStrength: { u: uPinchStrength, boot: uPinchStrength.value },
      profilePow: { u: uProfilePow, boot: uProfilePow.value },
    };
    const handle = {
      /** e.g. `__lensWormhole.set({ ringRadius: 0.45, foldGain: 0.8 })` */
      set(k: Record<string, number>) {
        for (const [name, v] of Object.entries(k))
          if (KNOBS[name] !== undefined) KNOBS[name].u.value = v;
        invalidate();
        return Object.fromEntries(
          Object.entries(KNOBS).map(([n, v]) => [n, v.u.value]),
        );
      },
      reset() {
        for (const { u, boot } of Object.values(KNOBS)) u.value = boot;
        invalidate();
      },
    };
    for (const name of Object.keys(KNOBS))
      Object.defineProperty(handle, name, {
        enumerable: true,
        get: () => KNOBS[name].u.value,
      });
    (window as unknown as Record<string, unknown>).__lensWormhole = handle;
  }

  return {
    sync,
    render() {
      pipeline.render();
    },
    dispose() {
      scenePass.dispose();
      pipeline.dispose();
      if (import.meta.env.DEV && typeof window !== "undefined")
        delete (window as unknown as Record<string, unknown>).__lensWormhole;
    },
  };
}
