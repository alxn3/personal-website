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

/** The wormhole ramp, 0..1, boots 0 — how hard the frame is pinched toward the
 *  throat. The dive drives it; the pipeline below is a bit-exact passthrough
 *  at 0. */
export const uWormhole = uniform(0);

/** The wormhole's shape knobs, as opposed to the animated ramp above — all
 *  screen-space quantities, each a live uniform on `__lensWormhole`. */
export const WORMHOLE_LOOK = {
  /** how much further out the frame is sampled at the throat at uWormhole = 1:
   *  the screen radius scale there is 1 + this. 0 = no pinch at any ramp value.
   *
   *  Bounded by two ceilings on the map r' = r·(1 + k·(1 − r/R)^p), both moving
   *  with profilePow: in-frame (r' ≤ R for every r) k ≤ 1/max_x[x(1−x)^(p−1)],
   *  and no-fold (dr'/dr ≥ 0) k ≤ 1/max_x[(1−x)^(p−1)((p+1)x − 1)]. No-fold is
   *  the stricter of the two here, so it is the real ceiling; past it two radii
   *  read the same source ring and the periphery creases. */
  pinchStrength: 2.1,
  /** exponent of the falloff (1 − r/rEdge)^pow: bigger confines the pull to the
   *  throat. It also sets both ceilings above, so raising it lowers what
   *  pinchStrength may be. */
  profilePow: 1.6,
};
export const uPinchStrength = uniform(WORMHOLE_LOOK.pinchStrength);
export const uProfilePow = uniform(WORMHOLE_LOOK.profilePow);

// The wormhole, in screen space — a post pass, so it warps everything the
// camera sees: barrel, internals, blades, glass and starfield alike.
//
// The remap: a radial pinch whose shape is a circle and whose edge-safety is a
// rectangle, kept strictly apart:
//
//     d    = uv − throat                      (uv-space offset)
//     r    = |d · (aspect, 1)|                (aspect-corrected radius)
//     circ = max(1 − r/rEdge, 0) ^ profilePow  1 at the throat → 0 at the
//                                             corner circle
//     ex   = throat→edge distance on the side d.x points to (ey likewise)
//     ρ    = max(|d.x|/ex, |d.y|/ey)          fraction of the way to the frame
//                                             border along this pixel's own
//                                             ray: exactly 1 on the border
//     win  = 1 − smoothstep(EDGE_FADE, 1, ρ)  border window
//     k    = uWormhole · pinchStrength · circ · win
//     uv'  = uv + d·k
//
// i.e. r' = r·(1 + k). Sampling further out than the pixel's own radius draws
// the frame's content inward, which is the funnel. ρ is branch-free: ex, ey are
// clamped ≥ EPS in `sync`.
//
// Exact at rest: `uWormhole = 0` makes `k` exactly 0, so `uv + d·0` is exactly
// `uv`. Every term is written in offset form to keep that, and every later
// feature rides `k` or `uWormhole` too.

/** The exit axis: world +X, the fly-through's one heading and the direction
 *  optics/sky.ts bakes its streaks toward. */
const EXIT_AXIS = new THREE.Vector3(1, 0, 0);

/** The four frame corners in uv, for the `rEdge` minimum below. */
const CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** Where the border window starts fading, as a fraction of the throat→border
 *  distance: 1 (no effect) until here, 0 at the border. The only guard that
 *  scales with how far a sample can reach. */
const EDGE_FADE = 0.85;
const uEdgeFade = uniform(EDGE_FADE);

/** Guard for every divide below, as one number. */
const EPS = 1e-4;

// The Einstein ring: a calm destination disc at the centre, radial streaks in
// the far field, and between them a turbulent annulus of concentric arcs with
// the same strata mirrored about the ring. Half of it is in the sprites
// (starfield.ts); this pass adds two things geometry cannot:
//
//   The fold: inside the band, mix in a second sample at the mirrored radius
//   2·rRing − r, same direction from the throat — the duplicated strata.
//   The smear: inside the band, average samples at the pixel's own radius
//   but rotated about the throat, turning speckle into concentric streaks.
//
// Everything is measured in the source frame — the radius the pixel reads, not
// the one it sits at — because the sprites draw at a fixed angle off the exit
// axis and the pinch drags them inward by however hard it runs. It is also why
// the map must not fold: a non-monotone r ↦ r·(1 + k) makes the band two
// annuli. Every length scales with `rRing`, so moving the ring moves the
// annulus.
//
// Three rules hold:
//   1. uWormhole = 0 is still a bit-exact passthrough: every ring term folds in
//      with `mix(base, extra, mask)` and `mask` carries uWormhole as a factor.
//      The extra samples are still taken, so the shader stays branchless.
//   2. The frame edges stay pinned: the mask carries `win`, and every extra
//      sample's offset is clamped by `keepInFrame` along its own ray.
//   3. The centre stays calm — the band mask is flat 0 inside
//      rRing − ringWidth, so the destination disc is untouched.
//
// The taps are a fixed, small, JS-unrolled set — 1 fold + 2·SMEAR_TAPS smear,
// plus the chromatic base's 3 — with no arrays and no dynamic loop, to stay
// under WebKit-on-Metal's 8KB private-memory cap.
const SMEAR_TAPS = 3;

/** How far along its own ray toward the frame border an extra sample may reach.
 *  Just under 1: at 1 it lands ON the border and picks up the sampler clamp. */
const EDGE_KEEP = 0.98;

/** Where the sprite band lands on an undistorted frame, in the shader's
 *  aspect-corrected radius metric (frame half-height = 0.5 at any aspect): the
 *  starfield authors its ring as an angle off the exit axis, and a rectilinear
 *  camera puts an angle γ at zoom·tan γ / tan(fov/2) of the way to the top of
 *  the frame. Both fov and zoom must come from the live camera each frame —
 *  three divides the half-height by `zoom`, which on a portrait viewport is the
 *  aspect.
 *
 *  Assumes the exit axis is the optical one: a single radius describes the
 *  γ-cone only when the throat is at the frame's centre, so the ring is
 *  approximate while a camera carries elevation. */
export const ringSourceRadius = (fovDeg: number, zoom = 1): number =>
  (0.5 * zoom * Math.tan(STARFIELD_LOOK.ringCentreRad)) /
  Math.tan((fovDeg * Math.PI) / 360);

/** The ring's shape knobs, defaults for the uniforms below (all live on
 *  `window.__lensWormhole`). Neither is a radius — that is derived by
 *  `ringSourceRadius`; these say how to sit on it. */
export const RING_LOOK = {
  /** multiplier on the derived radius, so the band can be walked off the
   *  sprites' ring without losing the fov/aspect tracking. */
  ringGain: 1,
  /** half the band's width, as a fraction of the ring's radius — the mask is 1
   *  at the ring and smoothly 0 at ±this. Sized to cover the sprites' own
   *  band. */
  ringWidth: 0.6,
  /** how much of the mirrored sample is mixed in at the centre of the band.
   *  0 = no fold; 1 replaces the frame inside the band and reads as a hole. */
  foldGain: 0.5,
  /** the widest rotation of a smear tap, radians about the throat. Small: a
   *  large arc turns the ring into a blurred donut. */
  smearArc: 0.12,
  /** how much of the smeared average is mixed in at the centre of the band.
   *  0 = the taps are taken and discarded (still an exact passthrough). */
  smearMix: 0.7,
};
// Chromatic aberration: the base sample is taken three times, at k·(1 −
// caShift), k and k·(1 + caShift), and R/G/B recombined. The offsets being
// fractions of k keeps rest bit-exact. Ring taps stay single-channel.
export const CA_LOOK = {
  /** the red/blue split as a fraction of the pixel's own displacement. 0 = no
   *  aberration; 0.02 = prismatic fringe; ≥0.05 reads as tripled stars. */
  caShift: 0.02,
};
export const uCaShift = uniform(CA_LOOK.caShift);

/** the band's centre in the source frame, in the shader's radius metric —
 *  written every frame by `sync` from the live fov, never authored. */
const uRingRadius = uniform(ringSourceRadius(70));
export const uRingGain = uniform(RING_LOOK.ringGain);
export const uRingWidth = uniform(RING_LOOK.ringWidth);
export const uRingFold = uniform(RING_LOOK.foldGain);
export const uRingSmearArc = uniform(RING_LOOK.smearArc);
export const uRingSmearMix = uniform(RING_LOOK.smearMix);

export interface WormholePost {
  /** Push this frame's throat position and edge distances into the uniforms.
   *  Must run before `render()`. */
  sync(camera: THREE.PerspectiveCamera): void;
  /** Render the frame through the pinch, in place of `renderer.render`. The
   *  scene half is drawn once per tick (three's own frame guard), so a second
   *  call inside one tick re-runs only the output quad. */
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

  /** How far, as a fraction, an offset from the throat reaches toward the frame
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

  /** Turn an offset by `ang` about the throat. Done in the aspect-corrected
   *  frame and mapped back, so the path traced is a circle on screen and the
   *  tap's radius `r` is preserved. */
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
    // the funnel's shape: circular, aspect-corrected, dead at the corner circle
    const r: TslNode = vec2(d.x.mul(uAspect), d.y).length().toVar();
    const circ: TslNode = pow(max(float(1).sub(r.div(uREdge)), 0), uProfilePow);
    // the border window
    const win: TslNode = float(1)
      .sub(smoothstep(uEdgeFade, float(1), borderFraction(d)))
      .toVar();
    const k: TslNode = uWormhole.mul(uPinchStrength).mul(circ).mul(win).toVar();
    // Offset form, not `uv·m` — see the header's exactness note. Three samples,
    // one per channel, at k·(1 − caShift), k and k·(1 + caShift); alpha comes
    // from the middle one. At rest k and `ca` are 0, so all three collapse.
    const ca: TslNode = k.mul(uCaShift).toVar();
    const mid: TslNode = color.sample(suv.add(d.mul(k))).toVar();
    const base: TslNode = vec4(
      color.sample(suv.add(d.mul(k.sub(ca)))).r,
      mid.g,
      color.sample(suv.add(d.mul(k.add(ca)))).b,
      mid.a,
    );

    // The ring band: a bump in the source radius — the radius this pixel reads
    // — flat 0 outside it, so the centre disc and far field are untouched.
    // `uWormhole` and the border window ride along.
    const rSrc: TslNode = r.mul(float(1).add(k)).toVar();
    const rRing: TslNode = uRingRadius.mul(uRingGain).toVar();
    const rWidth: TslNode = max(rRing.mul(uRingWidth), EPS);
    const band: TslNode = float(1).sub(
      smoothstep(float(0), rWidth, abs(rSrc.sub(rRing))),
    );
    const mask: TslNode = uWormhole.mul(band).mul(win).toVar();

    // the fold: the same ray at the source radius mirrored about the ring
    // (2·rRing − rSrc). ringWidth being a fraction of the radius under 1 keeps
    // the mirrored radius positive wherever the fold can contribute.
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
    // the exit axis's vanishing point, as a direction rather than a far-away
    // point: a point at infinity is (dir, 0), so the clip-space divide is by
    // −z_view and the projection's third column carries any view offset.
    dirView.copy(EXIT_AXIS).transformDirection(cam.matrixWorldInverse);
    const e = cam.projectionMatrix.elements;
    const w = -dirView.z;
    if (w > 1e-6) {
      const ndcX = (e[0] * dirView.x + e[8] * dirView.z) / w;
      const ndcY = (e[5] * dirView.y + e[9] * dirView.z) / w;
      uThroat.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    }
    // axis at or behind the camera: no vanishing point exists, so hold the last
    // one rather than snapping the funnel across the frame
    uAspect.value = cam.aspect;
    // the ring follows the sprites: the band's radius is where starfield.ts's
    // ring projects at this fov and zoom, so the two halves cannot drift apart
    uRingRadius.value = ringSourceRadius(cam.fov, cam.zoom);
    // the nearest corner, so the circular profile dies at the corner circle
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

  // Compile the pipeline now: three builds a RenderPipeline's shader lazily on
  // its first `render()`, so otherwise the compile lands on the dive's first
  // tick and the pass pops on. Safe to draw here because uWormhole boots at 0,
  // where the remap is a bit-exact passthrough.
  sync(camera);
  pipeline.render();

  // the live look knobs, same shape as starfield.ts's `__lensStars`
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
