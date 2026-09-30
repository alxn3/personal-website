import {
  uniform,
  float,
  smoothstep,
  modelViewMatrix,
  vec4,
  positionLocal,
  varying,
} from "three/tsl";

// Soft near/far planes: pieces that move too close to or too far from the
// camera fade out instead of popping. Opacity is exactly 1 over [near1, far0].
export const uFadeNear0 = uniform(3); // fully faded (closest to camera)
export const uFadeNear1 = uniform(6); // full opacity (near edge of the body)
export const uFadeFar0 = uniform(20); // full opacity (far edge of the body)
export const uFadeFar1 = uniform(28); // fully faded (farthest from camera)

/** Extra model radii the band widens by at full spread. */
export const SPREAD_RADII = 3.2;

/** Place the four planes in view depth around the lens (at `dollyX`), widened
 *  by `spread` (0 = assembled). Called every frame. */
export function writeFadeBands(
  cam: { x: number; y: number; z: number },
  dollyX: number,
  radius: number,
  spread: number,
): void {
  const dist = Math.hypot(cam.x - dollyX, cam.y, cam.z);
  const r = radius * (1 + SPREAD_RADII * spread);
  uFadeNear1.value = dist - r * 1.05;
  uFadeNear0.value = dist - r * 2.7;
  uFadeFar0.value = dist + r * 1.05;
  uFadeFar1.value = dist + r * 2.6;
}

/** A new 0..1 fade node for `localPos` (pass the deformed position for
 *  deformed pieces). Build one per material. */
export function depthFadeFactor(localPos: any = positionLocal): any {
  // View depth is linear in position, so it can be interpolated as a varying.
  const viewZ = varying(modelViewMatrix.mul(vec4(localPos, 1.0)).z.negate());
  const near = smoothstep(uFadeNear0, uFadeNear1, viewZ);
  const far = float(1).sub(smoothstep(uFadeFar0, uFadeFar1, viewZ));
  return near.mul(far);
}
