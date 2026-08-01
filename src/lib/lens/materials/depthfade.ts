import {
  uniform,
  float,
  smoothstep,
  modelViewMatrix,
  vec4,
  positionLocal,
} from "three/tsl";

// View-depth opacity fade — pieces that fly TOWARD the camera (past the near band)
// or recede TOO FAR (past the far band) dissolve to nothing instead of popping or
// crowding the lens, like a soft near/far plane. The bands are set each frame in
// core/scene.ts from the live camera distance ± the model radius, so the lens body
// itself always sits in the full-opacity middle and only exploded pieces fade.
export const uFadeNear0 = uniform(3); // fully faded (closest to camera)
export const uFadeNear1 = uniform(6); // full opacity (near edge of the body)
export const uFadeFar0 = uniform(20); // full opacity (far edge of the body)
export const uFadeFar1 = uniform(28); // fully faded (farthest from camera)

// A fresh fade-factor node (0..1) for the given DEFORMED local position. Pass the
// bloom position graph for shell wedges (their explode motion is in-shader, so the
// built-in positionView node misses it); default positionLocal is correct for
// everything moved only by its object matrix (glass, solids, loose parts). A node
// can't be shared across materials, so build one per material.
export function depthFadeFactor(localPos: any = positionLocal): any {
  const viewZ = modelViewMatrix.mul(vec4(localPos, 1.0)).z.negate(); // distance in front of camera
  const near = smoothstep(uFadeNear0, uFadeNear1, viewZ);
  const far = float(1).sub(smoothstep(uFadeFar0, uFadeFar1, viewZ));
  return near.mul(far);
}
