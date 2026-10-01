import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cross,
  float,
  modelViewMatrix,
  positionGeometry,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/tsl-types";
import { SKY, SKY_INK, dirOf, type SkyPalette, type Star } from "./sky";
import {
  SKY_SPIN_AXIS,
  STARFIELD_LOOK,
  rodrigues,
  ribbonVertex,
  rodriguesTsl,
  safeDir2,
  starRho,
  uSkySpin,
  uSkySpinAxis,
} from "./starfield";

// Long-exposure star trails: while the sky spins (`uSkySpin`), each star drags
// an arc back to where it stood when the spin began. One instanced draw: a
// template ribbon of `segments` quads, one instance per star, bent in the vertex
// shader from the spin uniforms. The arc head (s = 0) sits exactly on the star.

/** Final sky rotation of the trails scene, radians. */
export const TRAIL_SWEEP_MAX = Math.PI;

/** Fraction of the rotation history the tail spans (1 = back to the start). */
export const TRAIL_TAIL_FRACTION = 1;

export const TRAIL_LOOK = {
  /** just inside the starfield sphere */
  radius: STARFIELD_LOOK.radius * 0.995,
  /** chords per arc */
  segments: 80,
  /** arc half-width as a fraction of the star's disc radius */
  widthK: 0.8,
  /** minimum half-width, radians; thinner arcs are drawn at it and dimmed */
  minHalfRad: 0.0014,
  /** minimum per-arc ink in the light theme (0 in the dark theme) */
  lightInkFloor: 0.45,
  /** fraction of the half-width at full ink before the edge feathers */
  core: 0.4,
};

/** CPU mirror of the shader: the arc direction at s (0 = head, 1 = tail). */
export function trailDirAt(
  dir: [number, number, number],
  spin: number,
  sweep: number,
  s: number,
): [number, number, number] {
  return rodrigues(dir, SKY_SPIN_AXIS, spin - s * sweep * TRAIL_TAIL_FRACTION);
}

export interface TrailArc {
  dir: [number, number, number];
  /** angular half-width, radians */
  half: number;
  /** ink multiplier, 0..1 */
  ink: number;
  tint: readonly [number, number, number];
}

/** One arc per star; arcs widened to `minHalfRad` are dimmed by the same ratio. */
export function buildTrailArcs(
  stars: readonly Star[],
  look = TRAIL_LOOK,
): TrailArc[] {
  return stars.map((s) => {
    const wanted = look.widthK * starRho(s.mag);
    const half = Math.max(look.minHalfRad, wanted);
    return {
      dir: dirOf(s.az, s.alt),
      half,
      ink: (s.ink ?? 1) * Math.min(1, wanted / half),
      tint: s.tint,
    };
  });
}

export interface StarTrails {
  /** attach via SceneHandle.starfieldAttach so it follows the camera */
  object: THREE.Object3D;
  /** radians of rotation the tails span; pass the same value as `uSkySpin` */
  setSweep(rad: number): void;
  /** overall opacity, 0..1 */
  setEnvelope(o: number): void;
  /** switch palette in place */
  setTheme(light: boolean): void;
}

/** Builds the star-trail mesh over the whole catalog. */
export function createStarTrails(opts: { light: boolean }): StarTrails {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uTrailSweep = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().trail ?? palette().star));
  const uInkFloor = uniform(light ? TRAIL_LOOK.lightInkFloor : 0);
  const uInkOpacity = uniform(palette().starOpacity);

  // template ribbon: `position` holds (side, s, 0), placed in the shader
  const arcs = buildTrailArcs(SKY.stars);
  const SEG = TRAIL_LOOK.segments;
  const RUNGS = SEG + 1;
  const n = arcs.length;
  const position = new Float32Array(RUNGS * 2 * 3);
  const index = new Uint32Array(SEG * 6);
  for (let r = 0; r < RUNGS; r++)
    for (let k = 0; k < 2; k++) {
      const v = r * 2 + k;
      position[v * 3] = k === 0 ? -1 : 1; // side, ±1 across the width
      position[v * 3 + 1] = r / SEG; // 0 at the head, 1 at the tail
    }
  for (let q = 0; q < SEG; q++) {
    const b = q * 2;
    const t = q * 6;
    index[t] = b;
    index[t + 1] = b + 1;
    index[t + 2] = b + 2;
    index[t + 3] = b + 1;
    index[t + 4] = b + 3;
    index[t + 5] = b + 2;
  }

  // per-instance (per-star) attributes
  const aDir = new Float32Array(n * 3);
  const aHalf = new Float32Array(n);
  const aInk = new Float32Array(n);
  const aTint = new Float32Array(n * 3);
  for (let a = 0; a < n; a++) {
    aDir.set(arcs[a].dir, a * 3);
    aTint.set(arcs[a].tint, a * 3);
    aHalf[a] = arcs[a].half;
    aInk[a] = arcs[a].ink;
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = n;
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("aDir", new THREE.InstancedBufferAttribute(aDir, 3));
  geo.setAttribute("aHalf", new THREE.InstancedBufferAttribute(aHalf, 1));
  geo.setAttribute("aInk", new THREE.InstancedBufferAttribute(aInk, 1));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(aTint, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // `position` holds parameters, so set the bounds by hand
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), TRAIL_LOOK.radius);

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.side = THREE.DoubleSide; // billboard winding flips with the view
  // the spin pole is the view axis, so every arc on screen faces the same way
  // and one pass draws what three's two would
  mat.forceSinglePass = true;
  mat.toneMapped = false;

  const R = float(TRAIL_LOOK.radius);
  const nDir: TslNode = attribute("aDir", "vec3");
  const nHalf: TslNode = attribute("aHalf", "float");
  const nInk: TslNode = attribute("aInk", "float");
  const nTint: TslNode = attribute("aTint", "vec3");
  const side: TslNode = positionGeometry.x;
  const s: TslNode = positionGeometry.y;

  // `trailDirAt` in TSL
  const dirAt = rodriguesTsl(
    nDir,
    uSkySpinAxis,
    uSkySpin.sub(s.mul(uTrailSweep)),
  );
  const centre: TslNode = modelViewMatrix.mul(vec4(dirAt.mul(R), 1));
  // screen-space normal to the arc's tangent (axis × dir)
  const along = safeDir2(
    modelViewMatrix.mul(vec4(cross(uSkySpinAxis, dirAt), 0)).xy,
  );
  const nrm: TslNode = vec2(along.y.negate(), along.x).mul(R.mul(nHalf));
  mat.vertexNode = ribbonVertex(centre, nrm, side);

  const vSide: TslNode = varying(side);
  const vInk: TslNode = varying(nInk);
  const vTint: TslNode = varying(nTint);
  // soft edge across the band
  const across: TslNode = float(1).sub(
    smoothstep(float(TRAIL_LOOK.core), float(1), abs(vSide)),
  );

  // same colour as the star's disc
  mat.colorNode = uInk.mul(vTint);
  // flat from head to tail
  mat.opacityNode = across
    .mul(vInk.max(uInkFloor))
    .mul(uEnvelope)
    .mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_StarTrails";
  // the sky surrounds the camera, so never cull it
  mesh.frustumCulled = false;

  return {
    object: mesh,
    setSweep(rad) {
      uTrailSweep.value = rad * TRAIL_TAIL_FRACTION;
    },
    setEnvelope(o) {
      uEnvelope.value = o;
    },
    setTheme(l) {
      light = l;
      const pal = palette();
      uInk.value.setHex(pal.trail ?? pal.star);
      uInkOpacity.value = pal.starOpacity;
      uInkFloor.value = l ? TRAIL_LOOK.lightInkFloor : 0;
    },
  };
}
