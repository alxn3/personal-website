import * as THREE from "three/webgpu";
import {
  Fn,
  If,
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
} from "three/tsl";
import type { TslNode } from "../ops/tsl-types";
import { STARFIELD_LOOK, devKnobs } from "./starfield";

/** How hard the frame is pinched toward the throat, 0..1; 0 is an exact passthrough. */
export const uWormhole = uniform(0);

/** Pinch shape knobs (screen space). */
const WORMHOLE_LOOK = {
  /** at the throat the frame is sampled 1 + this further out. Must stay under
   *  1/max_x[(1−x)^(p−1)((p+1)x − 1)] (p = profilePow) or the periphery folds. */
  pinchStrength: 2.1,
  /** falloff exponent of (1 − r/rEdge)^pow; higher confines the pull to the throat */
  profilePow: 1.6,
};
const uPinchStrength = uniform(WORMHOLE_LOOK.pinchStrength);
const uProfilePow = uniform(WORMHOLE_LOOK.profilePow);

// A screen-space post that pinches the whole frame toward the throat (the
// exit axis's vanishing point). With d = uv − throat and r its aspect-corrected
// length, each pixel samples uv + d·k, where
//   k = uWormhole · pinchStrength · (1 − r/rEdge)^profilePow · borderWindow.
// Every term is an offset scaled by uWormhole, so uWormhole = 0 is exact.

/** The fly-through's exit axis, world +X. */
const EXIT_AXIS = new THREE.Vector3(1, 0, 0);

/** Frame corners in uv. */
const CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** Fraction of the throat→border distance where the pinch starts fading out. */
const EDGE_FADE = 0.85;
const uEdgeFade = uniform(EDGE_FADE);

/** Divide-by-zero guard. */
const EPS = 1e-4;

// The Einstein ring (the star sprites in starfield.ts draw the other half). In
// a band around the ring radius, measured at the radius each pixel samples:
//   fold  — mix in a sample mirrored about the ring (2·rRing − r)
//   smear — average samples rotated about the throat into concentric streaks
// The band mask carries uWormhole and the border window, so rest stays exact and
// the edges stay pinned. Taps are unrolled in JS for WebKit's shader memory limit.
const SMEAR_TAPS = 3;

/** How far toward the border an extra sample may reach (1 = on the border). */
const EDGE_KEEP = 0.98;

/** Screen radius (frame half-height = 0.5) of the starfield's ring angle at this
 *  fov and zoom; assumes the throat is at the frame centre. */
export const ringSourceRadius = (fovDeg: number, zoom = 1): number =>
  (0.5 * zoom * Math.tan(STARFIELD_LOOK.ringCentreRad)) /
  Math.tan((fovDeg * Math.PI) / 360);

/** Ring shape knobs; the radius itself comes from `ringSourceRadius`. */
export const RING_LOOK = {
  /** multiplier on the derived ring radius */
  ringGain: 1,
  /** band half-width, as a fraction of the ring radius */
  ringWidth: 0.6,
  /** mix of the mirrored sample at the band centre */
  foldGain: 0.5,
  /** widest smear-tap rotation about the throat, radians */
  smearArc: 0.12,
  /** mix of the smeared average at the band centre */
  smearMix: 0.7,
};
const CA_LOOK = {
  /** chromatic red/blue split, as a fraction of the pixel's displacement */
  caShift: 0.02,
};
const uCaShift = uniform(CA_LOOK.caShift);

/** ring radius, written each frame by `sync` */
const uRingRadius = uniform(ringSourceRadius(70));
const uRingGain = uniform(RING_LOOK.ringGain);
const uRingWidth = uniform(RING_LOOK.ringWidth);
const uRingFold = uniform(RING_LOOK.foldGain);
const uRingSmearArc = uniform(RING_LOOK.smearArc);
const uRingSmearMix = uniform(RING_LOOK.smearMix);

export interface WormholePost {
  /** Update the throat and edge uniforms from the camera; call before `render()`. */
  sync(camera: THREE.PerspectiveCamera): void;
  /** Copy the drawn scene to the canvas through the pinch. */
  render(): void;
  dispose(): void;
}

/** `color` samples the scene target the frame was drawn into. */
export function createWormholePost(
  renderer: THREE.WebGPURenderer,
  color: TslNode,
  camera: THREE.PerspectiveCamera,
  invalidate: () => void = () => {},
): WormholePost {
  // the throat in uv, recomputed each frame by `sync`
  const uThroat = uniform(new THREE.Vector2(0.5, 0.5));
  const uAspect = uniform(1);
  /** aspect-corrected radius where the pinch reaches 0 (nearest corner) */
  const uREdge = uniform(Math.SQRT1_2);
  /** throat→border distances (x−, x+, y−, y+), clamped ≥ 1e-4 */
  const uEdge = uniform(new THREE.Vector4(0.5, 0.5, 0.5, 0.5));

  /** Fraction of the way from the throat to the border along `o` (1 = on it). */
  const borderFraction = (o: TslNode): TslNode => {
    // pick the border distance on the side each component points to
    const sx: TslNode = step(0, o.x);
    const sy: TslNode = step(0, o.y);
    const ex: TslNode = sx.mul(uEdge.y).add(float(1).sub(sx).mul(uEdge.x));
    const ey: TslNode = sy.mul(uEdge.w).add(float(1).sub(sy).mul(uEdge.z));
    return max(abs(o.x).div(ex), abs(o.y).div(ey));
  };

  /** Shorten `o` along its ray so it stays within EDGE_KEEP of the border. */
  const keepInFrame = (o: TslNode): TslNode =>
    o.mul(min(float(1), float(EDGE_KEEP).div(max(borderFraction(o), EPS))));

  /** Read the scene at `throat + offset`, never outside the frame. */
  const tap = (o: TslNode): TslNode =>
    color.sample(uThroat.add(keepInFrame(o)));

  /** Rotate `o` by `ang` about the throat, as a circle on screen. */
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
    const suv: TslNode = uv().toVar();
    const out: TslNode = vec4(0).toVar();
    // at rest the pass is a passthrough: one tap instead of ten
    If(uWormhole.equal(0), () => {
      out.assign(color.sample(suv));
    }).Else(() => {
      const d: TslNode = suv.sub(uThroat).toVar();
      const r: TslNode = vec2(d.x.mul(uAspect), d.y).length().toVar();
      const circ: TslNode = pow(
        max(float(1).sub(r.div(uREdge)), 0),
        uProfilePow,
      );
      // the border window
      const win: TslNode = float(1)
        .sub(smoothstep(uEdgeFade, float(1), borderFraction(d)))
        .toVar();
      const k: TslNode = uWormhole
        .mul(uPinchStrength)
        .mul(circ)
        .mul(win)
        .toVar();
      // chromatic aberration: R, G, B sampled at k·(1 − caShift), k, k·(1 + caShift)
      const ca: TslNode = k.mul(uCaShift).toVar();
      const mid: TslNode = color.sample(suv.add(d.mul(k))).toVar();
      const base: TslNode = vec4(
        color.sample(suv.add(d.mul(k.sub(ca)))).r,
        mid.g,
        color.sample(suv.add(d.mul(k.add(ca)))).b,
        mid.a,
      );

      // ring band mask, on the radius this pixel samples
      const rSrc: TslNode = r.mul(float(1).add(k)).toVar();
      const rRing: TslNode = uRingRadius.mul(uRingGain).toVar();
      const rWidth: TslNode = max(rRing.mul(uRingWidth), EPS);
      const band: TslNode = float(1).sub(
        smoothstep(float(0), rWidth, abs(rSrc.sub(rRing))),
      );
      const mask: TslNode = uWormhole.mul(band).mul(win).toVar();

      // fold: the same ray at the radius mirrored about the ring
      const foldOff: TslNode = d.mul(
        rRing.mul(2).div(max(r, EPS)).sub(float(1).add(k)),
      );
      const folded: TslNode = mix(base, tap(foldOff), mask.mul(uRingFold));

      // smear: average of the pinched offset turned ± up to smearArc in equal steps
      const pinched: TslNode = d.mul(float(1).add(k)).toVar();
      const pair = (i: number): TslNode => {
        const ang: TslNode = uRingSmearArc.mul(i / SMEAR_TAPS);
        return tap(turn(pinched, ang)).add(tap(turn(pinched, ang.negate())));
      };
      let sum: TslNode = pair(1);
      for (let i = 2; i <= SMEAR_TAPS; i++) sum = sum.add(pair(i));
      const smear: TslNode = sum.div(2 * SMEAR_TAPS);
      out.assign(mix(folded, smear, mask.mul(uRingSmearMix)));
    });
    return out;
  })();

  const pipeline = new THREE.RenderPipeline(
    renderer,
    outputNode as unknown as THREE.RenderPipeline["outputNode"],
  );

  const dirView = new THREE.Vector3();

  function sync(cam: THREE.PerspectiveCamera) {
    cam.updateMatrixWorld();
    // project the exit axis's vanishing point (a direction, w = 0)
    dirView.copy(EXIT_AXIS).transformDirection(cam.matrixWorldInverse);
    const e = cam.projectionMatrix.elements;
    const w = -dirView.z;
    // if the axis points behind the camera, keep the last throat
    if (w > 1e-6) {
      const ndcX = (e[0] * dirView.x + e[8] * dirView.z) / w;
      const ndcY = (e[5] * dirView.y + e[9] * dirView.z) / w;
      uThroat.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    }
    uAspect.value = cam.aspect;
    uRingRadius.value = ringSourceRadius(cam.fov, cam.zoom);
    // distance to the nearest corner
    let rEdge = Infinity;
    for (const [x, y] of CORNERS) {
      const dx = (x - uThroat.value.x) * uAspect.value;
      const dy = y - uThroat.value.y;
      rEdge = Math.min(rEdge, Math.hypot(dx, dy));
    }
    uREdge.value = Math.max(rEdge, 1e-4);
    // throat→border distances, clamped so a throat on an edge cannot divide by 0
    const t = uThroat.value;
    uEdge.value.set(
      Math.max(t.x, 1e-4),
      Math.max(1 - t.x, 1e-4),
      Math.max(t.y, 1e-4),
      Math.max(1 - t.y, 1e-4),
    );
  }

  sync(camera);

  // dev console handle, e.g. `__lensWormhole.set({ ringGain: 1.2 })`
  const dropDevKnobs = devKnobs(
    "__lensWormhole",
    {
      // the ring radius is recomputed each frame; move it with ringGain
      ringGain: { u: uRingGain, boot: RING_LOOK.ringGain },
      ringWidth: { u: uRingWidth, boot: RING_LOOK.ringWidth },
      edgeFade: { u: uEdgeFade, boot: EDGE_FADE },
      foldGain: { u: uRingFold, boot: RING_LOOK.foldGain },
      smearArc: { u: uRingSmearArc, boot: RING_LOOK.smearArc },
      smearMix: { u: uRingSmearMix, boot: RING_LOOK.smearMix },
      caShift: { u: uCaShift, boot: CA_LOOK.caShift },
      pinchStrength: {
        u: uPinchStrength,
        boot: WORMHOLE_LOOK.pinchStrength,
      },
      profilePow: { u: uProfilePow, boot: WORMHOLE_LOOK.profilePow },
    },
    invalidate,
  );

  return {
    sync,
    render() {
      pipeline.render();
    },
    dispose() {
      pipeline.dispose();
      dropDevKnobs();
    },
  };
}
