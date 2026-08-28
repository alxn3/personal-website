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
// bands are written each frame by core/scene.ts (writeFadeBands below), so the
// model sits in the full-opacity middle and only pieces that leave it fade. The
// factor is exactly 1 over [near1, far0].
export const uFadeNear0 = uniform(3); // fully faded (closest to camera)
export const uFadeNear1 = uniform(6); // full opacity (near edge of the body)
export const uFadeFar0 = uniform(20); // full opacity (far edge of the body)
export const uFadeFar1 = uniform(28); // fully faded (farthest from camera)

/** How many extra model radii the band spans at full spread. The exploded cloud
 *  is about four radii deep, and the ending shoots it face-on, so a band sized
 *  for the seated lens dissolves a third of the pieces. */
export const SPREAD_RADII = 3.2;

/**
 * Place the four planes for one frame, in view depth. The band is CENTRED on
 * the camera's distance to the SUBJECT — the lens at `dollyX`, from where the
 * camera actually is, which is not where its orbit offset points once a scene
 * slides its target — and is as DEEP as the model's own spread, since an
 * exploded cloud is several radii deep and would ghost inside a band sized for
 * the seated lens. `spread` is the live explode/assemble channel, 0 = seated.
 *
 * Writes the uniforms rather than returning a band: it runs every frame.
 */
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
