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
import type { TslNode } from "../ops/tsl-types";
import { STARFIELD_LOOK } from "./starfield";

/** The wormhole ramp, 0..1, boots 0 — how hard the FRAME is pinched toward the
 *  throat. The dive drives it (story/fly.ts `flyWarpAt`); the pipeline below is
 *  a bit-exact passthrough at 0, by construction (see the header). */
export const uWormhole = uniform(0);

/** The wormhole's SHAPE knobs, as opposed to the animated ramp above — all
 *  SCREEN-SPACE quantities, each a live uniform on `__lensWormhole`. */
export const WORMHOLE_LOOK = {
  /** how much further out the frame is sampled at the throat at uWormhole = 1:
   *  the screen radius scale there is 1 + this. 0 = no pinch at any ramp value.
   *
   *  TWO GEOMETRIC CEILINGS bound it, both moving with profilePow. For the map
   *  r' = r·(1 + k·(1 − r/R)^p):
   *    IN-FRAME  r' ≤ R for every r ⇔ k ≤ 1/max_x[x(1−x)^(p−1)]. Past it the
   *              periphery samples off-frame and clamp-to-edge smears the
   *              border.
   *    NO-FOLD   dr'/dr ≥ 0 everywhere ⇔ k ≤ 1/max_x[(1−x)^(p−1)((p+1)x − 1)].
   *              Past this the map turns back on itself in an annulus: two
   *              radii read the same source ring and the periphery creases.
   *  No-fold is the stricter of the two at every p that matters here, so it is
   *  the real ceiling — respect it when tuning live. */
  pinchStrength: 2.1,
  /** exponent of the falloff (1 − r/rEdge)^pow: bigger = the pull is confined
   *  harder to the throat and the frame's border stays calmer. It also sets
   *  both ceilings above, so raising it lowers what pinchStrength may be. */
  profilePow: 1.6,
};
export const uPinchStrength = uniform(WORMHOLE_LOOK.pinchStrength);
export const uProfilePow = uniform(WORMHOLE_LOOK.profilePow);

// The wormhole, in SCREEN space — a post pass, so it warps everything the
// camera sees: barrel, internals, blades, glass and starfield alike. A
// sky-direction bend could only ever distort the sky, since the model draws
// over its own background node.
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
// i.e. r' = r·(1 + k). Sampling FURTHER out than the pixel's own radius draws
// the frame's content INWARD, which is the funnel. ρ is exact and branch-free:
// max-of-divisions cannot divide by zero (ex, ey are clamped ≥ EPS in `sync`).
//
// TWO TERMS, NOT ONE. ρ alone as the profile pins the border but hands the
// funnel's contours the frame's SHAPE, and the pinch bulges into four corner
// lobes; circle-only leaves live displacement at the short dimension's
// mid-edges, where clamp-to-edge smears a band. So the profile stays the CIRCLE
// and the rectangle appears only as `win`.
//
// EXACT AT REST, BY CONSTRUCTION: `uWormhole = 0` makes `k` exactly 0, so
// `uv + d·0` is exactly `uv` — which is why every term is written in OFFSET
// form (a `mix` or a `·m` round trip through the aspect vector would not be),
// and why every later feature rides `k` or `uWormhole` too. core/scene.ts also
// UNMOUNTS the pipeline outside the fly-through, so the shipped site never
// routes a frame through this file.
//
// Border safety is the window's own decay: staying in frame needs k ≤ (1−ρ)/ρ,
// and win → 0 quadratically as ρ → 1. Inside the window (win = 1) the two
// circular ceilings on WORMHOLE_LOOK.pinchStrength govern instead.

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
 *  distance: 1 (no effect) until here, 0 at the border. It is the ONLY guard
 *  that scales with how far a sample can reach, so pushing it out lets more of
 *  the frame sample past the border — lower it if a future beat puts structure
 *  against the frame's edge. Live on `__lensWormhole.set({edgeFade})`. */
const EDGE_FADE = 0.85;
const uEdgeFade = uniform(EDGE_FADE);

/** Guard for every divide below, as one number. */
const EPS = 1e-4;

// ── THE EINSTEIN RING ────────────────────────────────────────────────────────
//
// A calm destination disc at the centre, radial streaks in the far field, and
// between them a turbulent annulus of concentric arcs with the same strata
// mirrored about the ring. Half of it is in the sprites (starfield.ts, where
// stars in a band of angles swing their streaks from radial to tangential);
// this pass adds two things geometry cannot:
//
//   THE FOLD. Inside the band, mix in a second sample at the MIRRORED radius
//   2·rRing − r, same direction from the throat — the duplicated strata.
//   THE SMEAR. Inside the band, average a few samples at the pixel's own radius
//   but ROTATED about the throat, turning speckle into concentric streaks.
//
// EVERYTHING IS MEASURED IN THE SOURCE FRAME — the radius the pixel READS, not
// the one it sits at. That is the whole of "one ring, not two": the sprites
// draw at a fixed ANGLE off the exit axis and the pinch drags them inward by
// however hard it runs, so a mask on the pixel's own radius could agree with
// them at one ramp value only. It is also why the map must not fold — a
// non-monotone r ↦ r·(1 + k) makes the band two annuli. Every length scales
// with `rRing` (the smear is an ANGLE), so moving the ring moves the annulus.
//
// THREE RULES, all load-bearing:
//   1. uWormhole = 0 is still a BIT-EXACT passthrough: every ring term folds in
//      with `mix(base, extra, mask)` and `mask` carries uWormhole as a factor.
//      The extra samples are still TAKEN, so the shader stays branchless.
//   2. THE FRAME EDGES STAY PINNED. The mask carries `win`, and every extra
//      sample's offset is clamped by `keepInFrame` along ITS OWN ray: a rotated
//      or mirrored sample leaves the pixel's ray, so the window's per-ray
//      argument does not cover it and an explicit clamp does.
//   3. THE CENTRE STAYS CALM — the band mask is flat 0 inside
//      rRing − ringWidth, so the destination disc is untouched.
//
// COST AND THE 8KB WALL: WebKit-on-Metal caps a shader's private memory at 8KB.
// The taps are a fixed, small, JS-unrolled set — 1 fold + 2·SMEAR_TAPS smear,
// plus the chromatic base's 3 — with no arrays and no dynamic loop.
const SMEAR_TAPS = 3;

/** How far along its own ray toward the frame border an extra sample may reach.
 *  Just under 1: at 1 it lands ON the border and picks up the sampler clamp. */
const EDGE_KEEP = 0.98;

/** Where the sprite band lands on an undistorted frame, in the shader's
 *  aspect-corrected radius metric (frame half-height = 0.5 at any aspect): the
 *  starfield authors its ring as an ANGLE off the exit axis, and a rectilinear
 *  camera puts an angle γ at zoom·tan γ / tan(fov/2) of the way to the top of
 *  the frame. Both the fov AND the zoom are read from the LIVE camera every
 *  frame in `sync`: three's PerspectiveCamera divides its half-height by `zoom`,
 *  and core/scene.ts drives zoom from min(w, h)/h — so on a PORTRAIT viewport
 *  the zoom IS the aspect, and dropping it put this band at 1/aspect times its
 *  true radius, off the frame's sides, leaving an elliptical ring.
 *
 *  IT ASSUMES THE EXIT AXIS IS THE OPTICAL ONE: a single radius describes the
 *  γ-cone only when the throat is at the frame's centre. The story is safe, but
 *  the /lens dive drives uWormhole while its camera still carries the park's
 *  elevation, so its ring is approximate for those first frames. */
export const ringSourceRadius = (fovDeg: number, zoom = 1): number =>
  (0.5 * zoom * Math.tan(STARFIELD_LOOK.ringCentreRad)) /
  Math.tan((fovDeg * Math.PI) / 360);

/** The ring's SHAPE knobs, defaults for the uniforms below (all live on
 *  `window.__lensWormhole`). Neither is a radius — that is derived by
 *  `ringSourceRadius`; these say how to sit on it. */
export const RING_LOOK = {
  /** multiplier on the derived radius, so the band can be walked off the
   *  sprites' ring without losing the fov/aspect tracking. Meant to be tuned
   *  live and put back to 1. */
  ringGain: 1,
  /** HALF the band's width, as a FRACTION OF THE RING'S RADIUS — the mask is 1
   *  at the ring and smoothly 0 at ±this. Sized to cover the SPRITES' own band;
   *  a band symmetric in radius cannot sit inside one symmetric in angle at
   *  both ends, so it is taken just inside at the outer edge. */
  ringWidth: 0.6,
  /** how much of the MIRRORED sample is mixed in at the centre of the band.
   *  0 = no fold; 1 replaces the frame inside the band and reads as a hole. */
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
// The colour lives in the displacement itself: the base sample is taken three
// times, at k·(1 − caShift), k and k·(1 + caShift), and R/G/B recombined — red
// short of green, blue past it, like an uncorrected element. The offsets being
// FRACTIONS OF k keeps rest bit-exact and puts the fringe where the distortion
// is. Ring taps stay single-channel: tripling them costs the tap budget, and
// the ring's job is shape, not colour.
export const CA_LOOK = {
  /** the red/blue split as a fraction of the pixel's own displacement. 0 = no
   *  aberration (and one wasted pair of samples); 0.02 = prismatic fringe;
   *  ≥0.05 reads as tripled stars. Live on `__lensWormhole.set({caShift})`. */
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
   *  MUST run before `render()`, from the tick that syncs the warp. */
  sync(camera: THREE.PerspectiveCamera): void;
  /** Render the frame THROUGH the pinch, in place of `renderer.render`. The
   *  SCENE half of it is drawn once per TICK (three's own frame guard), so a
   *  second call inside one tick re-runs only the output quad — a look worn for
   *  it compiles nothing and a warm frame for it needs its own tick. */
  render(): void;
  dispose(): void;
}

export function createWormholePost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  invalidate: () => void = () => {},
): WormholePost {
  // the throat, in uv. Boots at frame centre, but is recomputed from the exit
  // axis's real vanishing point every frame (`sync`).
  const uThroat = uniform(new THREE.Vector2(0.5, 0.5));
  const uAspect = uniform(1);
  /** aspect-corrected radius where the pinch has died — the nearest corner */
  const uREdge = uniform(Math.SQRT1_2);
  /** throat→border distances (x−, x+, y−, y+), clamped ≥ 1e-4 in `sync` so the
   *  shader's divisions are safe even when the throat rides a frame edge. */
  const uEdge = uniform(new THREE.Vector4(0.5, 0.5, 0.5, 0.5));

  // the scene target inherits the canvas's MSAA, so routing through the post
  // path does not lose the antialiasing the direct path has
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

  /** Shorten an offset from the throat so it cannot reach past EDGE_KEEP of the
   *  way to the border — rule 2 of the ring header. Scales the whole vector, so
   *  the sample stays on its own ray. */
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
    // a var: read three times below, and an inlined `uv()` would rebuild the
    // screen coordinate each time
    const suv: TslNode = uv().toVar();
    const d: TslNode = suv.sub(uThroat).toVar();
    // the funnel's SHAPE: circular, aspect-corrected, dead at the corner circle
    const r: TslNode = vec2(d.x.mul(uAspect), d.y).length().toVar();
    const circ: TslNode = pow(max(float(1).sub(r.div(uREdge)), 0), uProfilePow);
    // the border WINDOW
    const win: TslNode = float(1)
      .sub(smoothstep(uEdgeFade, float(1), borderFraction(d)))
      .toVar();
    const k: TslNode = uWormhole.mul(uPinchStrength).mul(circ).mul(win).toVar();
    // The OFFSET form, not `uv·m` — see the header's exactness note. Three
    // samples, one per channel, at k·(1 − caShift), k and k·(1 + caShift): the
    // chromatic aberration. Alpha comes from the middle one. At rest k and `ca`
    // are exactly 0, so all three collapse onto `suv`.
    const ca: TslNode = k.mul(uCaShift).toVar();
    const mid: TslNode = color.sample(suv.add(d.mul(k))).toVar();
    const base: TslNode = vec4(
      color.sample(suv.add(d.mul(k.sub(ca)))).r,
      mid.g,
      color.sample(suv.add(d.mul(k.add(ca)))).b,
      mid.a,
    );

    // ── THE RING ───────────────────────────────────────────────────────────
    // the band: a bump in the SOURCE radius — the radius this pixel READS —
    // flat 0 outside it, so the centre disc and the far field are untouched.
    // `uWormhole` and the border window ride along.
    const rSrc: TslNode = r.mul(float(1).add(k)).toVar();
    const rRing: TslNode = uRingRadius.mul(uRingGain).toVar();
    const rWidth: TslNode = max(rRing.mul(uRingWidth), EPS);
    const band: TslNode = float(1).sub(
      smoothstep(float(0), rWidth, abs(rSrc.sub(rRing))),
    );
    const mask: TslNode = uWormhole.mul(band).mul(win).toVar();

    // the fold: the same ray at the SOURCE radius mirrored about the ring
    // (2·rRing − rSrc). ringWidth being a fraction of the radius under 1 keeps
    // the mirrored radius positive wherever the fold can contribute, so
    // the offset never flips through the throat.
    const foldOff: TslNode = d.mul(
      rRing.mul(2).div(max(r, EPS)).sub(float(1).add(k)),
    );
    const folded: TslNode = mix(base, tap(foldOff), mask.mul(uRingFold));

    // the smear: the pinched offset, turned both ways by up to smearArc in
    // equal steps and averaged with equal weights
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
    // pose was written earlier in this same tick
    cam.updateMatrixWorld();
    // the exit axis's vanishing point, as a DIRECTION rather than a far-away
    // point: a point at infinity is (dir, 0), so the clip-space divide is by
    // −z_view and the projection's third column carries any view offset. Exact
    // wherever the axis is in front of the camera.
    dirView.copy(EXIT_AXIS).transformDirection(cam.matrixWorldInverse);
    const e = cam.projectionMatrix.elements;
    const w = -dirView.z;
    if (w > 1e-6) {
      const ndcX = (e[0] * dirView.x + e[8] * dirView.z) / w;
      const ndcY = (e[5] * dirView.y + e[9] * dirView.z) / w;
      uThroat.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    }
    // axis at or behind the camera: no vanishing point exists, so HOLD the last
    // one rather than snapping the funnel across the frame
    uAspect.value = cam.aspect;
    // the ring follows the sprites every frame — the band's radius is where
    // starfield.ts's ring band projects at THIS fov and zoom, so the two halves
    // of the Einstein ring cannot drift apart under a fov ramp or a viewport
    uRingRadius.value = ringSourceRadius(cam.fov, cam.zoom);
    // the NEAREST corner, so the circular profile dies at the corner circle
    // — see the header's shape note
    let rEdge = Infinity;
    for (const [x, y] of CORNERS) {
      const dx = (x - uThroat.value.x) * uAspect.value;
      const dy = y - uThroat.value.y;
      rEdge = Math.min(rEdge, Math.hypot(dx, dy));
    }
    uREdge.value = Math.max(rEdge, 1e-4);
    // the four throat→border distances, one per side, for the border window.
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

  // COMPILE THE PIPELINE NOW, not on the frame that first renders through it:
  // three builds a RenderPipeline's shader lazily on its first `render()`, so
  // otherwise the compile lands on the dive's first tick and the pass reads as
  // popping on. Safe to draw here because uWormhole boots at 0, where the remap
  // is a bit-exact passthrough — the compile is paid and the picture is the
  // same frame the direct path just painted.
  sync(camera);
  pipeline.render();

  // the live look knobs, same shape as starfield.ts's `__lensStars`: they
  // interact (a wider band wants a shorter smear) and the pass exists over only
  // one stretch of the story, so console tuning beats a rebuild per guess
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      // no `ringRadius`: it is re-derived every frame in `sync`, so a write
      // here would last one frame. `ringGain` is the way to move the ring.
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
