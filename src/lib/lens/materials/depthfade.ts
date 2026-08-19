import {
  uniform,
  float,
  smoothstep,
  modelViewMatrix,
  vec4,
  positionLocal,
  varying,
} from "three/tsl";

// View-depth opacity fade: pieces that fly past the near band or recede past
// the far band dissolve rather than popping, like a soft near/far plane. The
// bands are written each frame by core/scene.ts from the live camera distance
// ± the model radius, so the lens body sits in the full-opacity middle and only
// exploded pieces fade. The factor is exactly 1 over [near1, far0].
export const uFadeNear0 = uniform(3); // fully faded (closest to camera)
export const uFadeNear1 = uniform(6); // full opacity (near edge of the body)
export const uFadeFar0 = uniform(20); // full opacity (far edge of the body)
export const uFadeFar1 = uniform(28); // fully faded (farthest from camera)

// A fresh fade-factor node (0..1) for the given DEFORMED local position. Pass
// the op position graph (ops/host.ts) for deformed pieces — their motion is
// in-shader, so the built-in positionView node misses it. A node can't be
// shared across materials, so build one per material.
export function depthFadeFactor(localPos: any = positionLocal): any {
  // The DEPTH rides a varying, the smoothstep does not: viewZ is affine in the
  // position, so interpolating it is exact and a deformed `localPos` keeps its
  // op chain in the vertex stage (ops/host.ts law 5).
  const viewZ = varying(modelViewMatrix.mul(vec4(localPos, 1.0)).z.negate());
  const near = smoothstep(uFadeNear0, uFadeNear1, viewZ);
  const far = float(1).sub(smoothstep(uFadeFar0, uFadeFar1, viewZ));
  return near.mul(far);
}
