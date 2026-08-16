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
import { STARFIELD_LOOK } from "./starfield";

/** THE WORMHOLE RAMP, 0..1, BOOTS 0 — how hard the FRAME is pinched toward the
 *  throat. The dive drives it (story/fly.ts `flyWarpAt`); the pipeline below is
 *  an exact passthrough at 0, by construction (see the header). */
export const uWormhole = uniform(0);

/** The wormhole's SHAPE knobs, as opposed to the animated ramp above.
 *  Defaults; each is a live uniform below and tunable through `__lensWormhole`.
 *  SCREEN-SPACE quantities, not sky-direction ones. */
export const WORMHOLE_LOOK = {
  /** how much further out the frame is sampled at the throat when uWormhole = 1:
   *  the screen radius scale there is 1 + this, so the content of a disc 1 + this
   *  times wider is squeezed into the middle of the frame. 0 = no pinch at any
   *  ramp value. TUNED ON THE BENCH at the peak of the dive.
   *
   *  MEASURED AT THREE BEATS, not one: at 2.6 the mount ring at p = 0.15 goes
   *  visibly egg-shaped, the iris blades at p = 0.30 bow into petals instead of
   *  staying straight-edged trapezoids, and the barrel walls at p = 0.50 draw an
   *  hourglass down to the throat. 1.6 does all three but reads as a lens shot
   *  through soft glass rather than as a funnel. The price of 2.6 is the
   *  aperture disc, which the funnel swallows — that is the effect working, not
   *  a defect, but it is the knob to lower if the starfield beat matters more
   *  than the bend.
   *
   *  TWO CEILINGS, and the LOWER one binds — neither a taste limit but the
   *  geometry's, and BOTH move when profilePow moves. For the map
   *  r' = r·(1 + k·(1 − r/R)^p):
   *
   *    IN-FRAME  r' ≤ R for every r ⇔ k ≤ 1/max_x[x(1−x)^(p−1)] = 2.88 at
   *              profilePow 1.6 (it was 4.55 at 2.2). Past it the periphery
   *              samples off-frame and clamp-to-edge smears the border.
   *    NO-FOLD   dr'/dr ≥ 0 everywhere ⇔ k ≤ 1/max_x[(1−x)^(p−1)((p+1)x − 1)]
   *              = 2.41 at 1.6 (3.25 at 2.2). Past THIS the map turns back on
   *              itself in an annulus — two radii read the same source ring and
   *              the periphery creases. It is the stricter of the two at every
   *              p that matters here, so 2.41 is the real ceiling now.
   *
   *  2.1 IS 87% OF IT, and the drop from 2.6 is paid for by the flatter
   *  profile, not lost: k(x) = strength·(1 − x)^p is 1.19 at x = 0.3 either
   *  way (2.6·0.7^2.2 = 1.186, 2.1·0.7^1.6 = 1.187), and from there OUT the new
   *  pair is stronger — 0.69 vs 0.57 at x = 0.5, 0.31 vs 0.18 at 0.7, 0.053 vs
   *  0.016 at 0.9. Same funnel at the throat, a live rim. */
  pinchStrength: 2.1,
  /** exponent of the falloff (1 − r/rEdge)^pow: bigger = the pull is confined
   *  harder to the throat and the frame's border stays calmer. Also sets the
   *  two stability ceilings on pinchStrength above.
   *
   *  1.6, DOWN FROM 2.2 — the owner's note is that the effect dies at the
   *  sides. At 2.2 the profile had spent 78% of its strength by x = 0.5 and
   *  99% by 0.9, so the pinch was a knot around the throat with a dead frame
   *  around it; 1.6 keeps the throat and gives the mid-field and the rim
   *  something to do (the numbers are on `pinchStrength`). It is not free: the
   *  no-fold ceiling falls with it, which is what took the strength to 2.1. */
  profilePow: 1.6,
};
export const uPinchStrength = uniform(WORMHOLE_LOOK.pinchStrength);
export const uProfilePow = uniform(WORMHOLE_LOOK.profilePow);

// ============================================================================
// THE WORMHOLE, IN SCREEN SPACE — the pinch moved out of the sky and into the
// FRAME, so it warps everything the camera sees: the barrel, the internals, the
// blades, the glass and the starfield alike.
//
// WHY IT MOVED. The old pinch (the retired per-pixel sky trace) bent the SAMPLE DIRECTION before
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
// stay inside for any sane strength. Inside the window (win = 1) the circular
// bounds govern, and there are TWO — the in-frame one (k ≤ 1/max_x[x(1−x)^(p−1)]
// = 2.88 at the shipped profilePow 1.6) and the stricter NO-FOLD one
// (k ≤ 1/max_x[(1−x)^(p−1)((p+1)x − 1)] = 2.41), which is the one a live-tuned
// strength has to respect: past it the radial map turns back on itself and the
// periphery creases. Both are derived, and re-derived, on
// WORMHOLE_LOOK.pinchStrength above, which is where they belong: they move with
// profilePow, and that is the knob they bound.
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
 *  creeps further into the frame; higher = a harder stop near the edge.
 *
 *  0.85, UP FROM 0.75 — the other half of "the effect dies at the sides". The
 *  window is what kills the TOP AND BOTTOM mid-edges (the short dimension: at
 *  16:10 a pixel there is only r = 0.5 out of rEdge 0.94, so `circ` still has
 *  plenty left and the window is the only thing taking it away), and at 0.75 a
 *  quarter of the way in from every border was already fading. It is not free
 *  either: the window is the ONLY guard that scales with how far a sample can
 *  reach, so pushing it out lets more of the frame sample past the border.
 *  SOLVED, not guessed, on the worst ray — the vertical, where a pixel's ρ buys
 *  it the least radius and therefore the most `circ`: ρ(1 + k) > 1 (the sample
 *  is off-frame) holds over ρ ≈ 0.415…0.987 for the shipped pair
 *  (profilePow 1.6, pinchStrength 2.1) at 16:10, against ρ ≈ 0.390…0.955 for
 *  the pair this replaces (2.2 / 2.6 at EDGE_FADE 0.75). So the off-frame band is
 *  the one this pass has always had, moved out by a couple of hundredths — not
 *  a new failure — and what lands there is clamp-to-edge over a starfield, i.e.
 *  backdrop. LIVE on `__lensWormhole.set({ edgeFade })` — the one knob to lower
 *  if a future beat puts structure against the frame's edge. */
const EDGE_FADE = 0.85;
const uEdgeFade = uniform(EDGE_FADE);

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
// IT IS ALL MEASURED IN THE SOURCE FRAME — the radius the pixel READS, not the
// radius it sits at. That is the whole of "one ring, not two". The sprites draw
// their arcs at a fixed ANGLE off the exit axis and the pinch then drags them
// inward by however hard it is running: their band is drawn at r = 0.345 (γ
// 0.45 rad at fov 70) and at full ramp it LANDS far inside that — r = 0.13 at
// 16:10 under the pinch shipped here, r = 0.117 under the pair this replaces.
// So a mask keyed to the pixel's own radius can only agree with them at one
// ramp value, and the authored one agreed at none: it sat at 0.36 of rEdge
// (r = 0.34 at 16:10), 2.9× further out than where the arcs of its own pair
// actually landed (2.6× against this one's). What that draws is an annulus of
// speckle with an unrelated smeared ring around it, which is what the owner is
// looking at. Keying the mask to `r·(1 + k)` — the
// radius the sample is taken from, which is the same expression the base sample
// already computes — puts the fold and the smear on exactly the pixels showing
// the sprite band, at every ramp value and every aspect, with no second
// constant to keep in step.
// The fold mirrors in that same frame (2·rRing − r·(1 + k)) for the same
// reason. This is also why the map should not FOLD (see the header's no-fold
// ceiling): a non-monotone r ↦ r·(1 + k) makes "the pixels reading the band"
// two annuli instead of one.
//
// THE CEILING ONLY BOUNDS HALF OF IT, and the honest version is worth stating.
// It bounds the CIRCULAR profile; the shipped k carries the border window too,
// and `win`'s own decay turns the composite map back down near the short
// dimension's border whatever the ceiling says. Measured, 16:10, vertical ray,
// full ramp: rSrc climbs to 0.768 at ρ 0.854 and falls back to 0.500 at the
// border, which re-enters the band (outer edge 0.552). What makes that
// immaterial is `win`, not the ceiling — it is what multiplies the mask, and
// the outer lobe's peak band·win is 0.0076 at ρ 0.973, i.e. under 1% of a fold
// or a smear once foldGain/smearMix are on it. The ceiling still earns its keep
// INSIDE the window, where win = 1 and a fold would be at full weight.
//
// AND EVERY LENGTH IN IT SCALES WITH THE RING'S OWN RADIUS, which is the other
// half of reading as one feature: the band's half-width is a fraction of
// `rRing` (not of the frame), and the smear is an ANGLE, so its arc length is
// `rSrc · smearArc` — proportional by construction. Move the ring in or out and
// the annulus and the streaks in it change size with it instead of staying a
// fixed pixel width at whatever radius they land on.
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

/** WHERE THE SPRITE BAND LANDS on an undistorted frame, in the shader's
 *  aspect-corrected radius metric (in which the frame's half-height is exactly
 *  0.5, whatever the aspect): the starfield authors its ring as an ANGLE off
 *  the exit axis (optics/starfield.ts STARFIELD_LOOK.ringCentreRad) and a
 *  rectilinear camera puts an angle γ at tan γ / tan(fov/2) of the way to the
 *  top of the frame. Read every frame from the LIVE camera in `sync`, so a fov
 *  ramp cannot slide the two halves of the ring apart, and pinned against the
 *  starfield's own projection in __tests__/wormhole-post.test.ts.
 *
 *  IT ASSUMES THE EXIT AXIS IS THE OPTICAL ONE. A single radius describes the
 *  γ-cone only when the throat is at the frame's centre; off-axis the cone
 *  projects to a conic about the (off-centre) vanishing point and no radius is
 *  right. The story is safe by construction — the camera faces +X from DIVE_P0
 *  on and `flyWarpAt` is exactly 0 before that (story/fly.ts) — but the /lens
 *  dive (story/fly.ts) drives `uWormhole` on dive progress while its own
 *  camera still carries the park's elevation, so its ring is approximate for
 *  those first frames. Not a regression: the authored 0.36·rEdge this replaces
 *  was equally off-axis-blind. */
export const ringSourceRadius = (fovDeg: number): number =>
  (0.5 * Math.tan(STARFIELD_LOOK.ringCentreRad)) /
  Math.tan((fovDeg * Math.PI) / 360);

/** The ring's SHAPE knobs, defaults for the uniforms below (all live on
 *  `window.__lensWormhole`). NEITHER IS A RADIUS any more: the radius itself is
 *  derived (`ringSourceRadius` above), and these two say how to sit on it. */
export const RING_LOOK = {
  /** MULTIPLIER on the derived radius, so the band can be walked off the
   *  sprites' own ring without losing the fov/aspect tracking. 1 = exactly on
   *  it, which is the whole point of the derivation — this exists to be tuned
   *  live and put back, not to ship at anything else. */
  ringGain: 1,
  /** HALF the band's width, AS A FRACTION OF THE RING'S RADIUS — the mask is 1
   *  at the ring and smoothly 0 at ±this, so the annulus spans 0.4 … 1.6 of the
   *  ring's radius at the default. Wide on purpose: the reference's annulus is
   *  broad and turbulent, not a hairline, and this is the width the SPRITES
   *  cover — their band is γ = 0.45 ± 0.25 rad (STARFIELD_LOOK), which projects
   *  to 0.42 … 1.74 of the ring's radius at the dive's fov 70. The number is
   *  taken a little inside that at the OUTER edge (1.6 against 1.74), where all
   *  the visible width is; it cannot also be inside at the inner one, since a
   *  band symmetric in RADIUS cannot sit inside a band symmetric in ANGLE at
   *  both ends — 0.4 against 0.42 overhangs by 2% of the radius, into sprite
   *  weight that is a smoothstep already nearly out by its edges. */
  ringWidth: 0.6,
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
// x = 1/(1 + profilePow) = 0.38 — outside the ring's landing radius — at 0.37 of
// rEdge in uv (0.3846 · 2.1 · 0.6154^1.6). The red-to-blue separation there is
// 2·caShift·0.37·rEdge — ~1.5% of the frame's HEIGHT at 0.02 and ~3.8% at 0.05
// (rEdge ≈ 1.02 at 16:9). The default is 0.02, judged BY
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

/** the band's centre in the SOURCE frame, absolute in the shader's radius
 *  metric — written every frame by `sync` from the live fov, never authored. */
const uRingRadius = uniform(ringSourceRadius(70));
export const uRingGain = uniform(RING_LOOK.ringGain);
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
      .sub(smoothstep(uEdgeFade, float(1), borderFraction(d)))
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
    // The band: a bump in the SOURCE radius — the radius this pixel READS, i.e.
    // where the sprites drew their arcs — 1 at the ring and flat 0 outside it,
    // so the centre disc and the far field are both untouched. `uWormhole` and
    // the border window ride along, which is what makes the whole thing vanish
    // at rest and stay clear of the frame's edges.
    const rSrc: TslNode = r.mul(float(1).add(k)).toVar();
    const rRing: TslNode = uRingRadius.mul(uRingGain).toVar();
    const rWidth: TslNode = max(rRing.mul(uRingWidth), EPS);
    const band: TslNode = float(1).sub(
      smoothstep(float(0), rWidth, abs(rSrc.sub(rRing))),
    );
    const mask: TslNode = uWormhole.mul(band).mul(win).toVar();

    // THE FOLD: the same ray, at the SOURCE radius mirrored about the ring —
    // 2·rRing − rSrc, which is this pixel's offset scaled by
    // 2·rRing/r − (1 + k). The mask is 0 unless rSrc is within `rWidth` of the
    // ring, and RING_LOOK.ringWidth is a fraction of the radius that is under
    // 1 — so the mirrored radius is positive wherever the fold can contribute
    // and the offset never flips through the throat.
    const foldOff: TslNode = d.mul(
      rRing.mul(2).div(max(r, EPS)).sub(float(1).add(k)),
    );
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
    // THE RING FOLLOWS THE SPRITES, every frame: the band's radius is where
    // optics/starfield.ts's own ring band projects at THIS fov (the dive's is
    // 70, and story/fly.ts hands it back to the story's 42 over rewrap-local
    // [0.25, 0.38] — a scene PAST the sky's end, and long past this pass's own
    // window), so the two halves of the Einstein ring cannot drift apart. It is
    // written every frame regardless: the pass outlives the warp. Aspect-free by
    // construction — a vertical fov and a radius metric normalized on the same
    // half-height.
    uRingRadius.value = ringSourceRadius(cam.fov);
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

  // NINE KNOBS, live — the ring's five, the pinch profile's two, the border
  // window's one and the aberration's one; the README's list is the same set.
  // The same shape as optics/starfield.ts's `__lensStars`. They are pure
  // look, they interact (a wider band wants a shorter smear), and the pass only
  // exists over one stretch of the story, so tuning them from the console beats
  // a rebuild per guess.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      // `ringRadius` is GONE from this table on purpose — it is derived from
      // the starfield's own band every frame (see `sync`), so a write here
      // would last exactly one frame. `ringGain` is the way to move the ring.
      ringGain: { u: uRingGain, boot: RING_LOOK.ringGain },
      ringWidth: { u: uRingWidth, boot: RING_LOOK.ringWidth },
      edgeFade: { u: uEdgeFade, boot: EDGE_FADE },
      foldGain: { u: uRingFold, boot: RING_LOOK.foldGain },
      smearArc: { u: uRingSmearArc, boot: RING_LOOK.smearArc },
      smearMix: { u: uRingSmearMix, boot: RING_LOOK.smearMix },
      caShift: { u: uCaShift, boot: CA_LOOK.caShift },
      pinchStrength: { u: uPinchStrength, boot: WORMHOLE_LOOK.pinchStrength },
      profilePow: { u: uProfilePow, boot: WORMHOLE_LOOK.profilePow },
    };
    const handle = {
      /** e.g. `__lensWormhole.set({ ringGain: 1.2, foldGain: 0.8 })` */
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
