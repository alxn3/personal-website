import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
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
  rodriguesTsl,
  safeDir2,
  starRho,
  uSkySpin,
  uSkySpinAxis,
} from "./starfield";

// Star trails — the long-exposure look. While the sky turns (starfield.ts's
// `uSkySpin`), every star in the catalog drags an arc of ink behind it, back to
// where it stood when the rotation began. An arc's ink is its star's, flat head
// to tail; the only field-wide fade is the envelope.
//
// One instanced draw, nothing pre-expanded on the CPU: one template ribbon of
// `segments` quads carries the arc's parameters — (side, s) — and every star is
// one instance of it, carrying its direction, width, ink and tint. The vertex
// graph rotates that direction backward by `s × uTrailSweep` about the pole the
// starfield spins about, so the arcs grow and turn from two uniforms alone. At
// s = 0 that rotation is zero, so a head sits exactly where starfield.ts draws
// the star — which is why story/trails.ts derives both uniforms from one θ.
//
// An arc is a band of flat ink extruded in view space perpendicular to the
// local arc tangent, so it holds one screen width at any fov — the idiom and
// material contract of optics/constellation-lines.ts. The tangent is
// `cross(axis, dir)`, the rotation's velocity at that vertex.

/** The sweep, radians: how far the sky has turned by the time the trails scene
 *  is done, so every arc is a semicircle about the pole. story/trails.ts owns
 *  the ramp up to it. */
export const TRAIL_SWEEP_MAX = Math.PI;

/** How much of the rotation history the tail spans. 1 = all of it: the tail
 *  sits at the star's unrotated direction, so the field un-draws itself as the
 *  sweep scrubs back to 0. Under 1 clips the oldest part of the arc. */
export const TRAIL_TAIL_FRACTION = 1;

export const TRAIL_LOOK = {
  /** the sphere the arcs are drawn on: just inside the starfield's, so the
   *  transparent pass sorts them behind the sky ink. Derived from the one
   *  starfield radius so the two cannot drift apart. */
  radius: STARFIELD_LOOK.radius * 0.995,
  /** rungs per arc − 1, tied to the sweep: an arc is drawn as chords, so the
   *  angle per segment is what must stay small. Sizes the template ribbon at
   *  `(segments + 1) × 2` vertices. */
  segments: 80,
  /** the arc's angular half-width as a fraction of the star's own disc radius
   *  — under 1, so the disc stays the widest part of the mark. */
  widthK: 0.8,
  /** …with a floor, radians, since a line under a pixel wide crawls rather than
   *  dimming. Arcs held at the floor pay the extra width back in ink. */
  minHalfRad: 0.0014,
  /** the per-arc ink floor in the light theme, where dark ink on paper reads
   *  fainter than light ink on black at the same alpha; 0 in the dark theme */
  lightInkFloor: 0.45,
  /** the fraction of the half-width at full ink before the edge feathers —
   *  optics/constellation-lines.ts's `core`. */
  core: 0.4,
};

/** The arc law on the CPU — the exact expression the vertex graph evaluates, so
 *  a test can hold it. At s = 0 it is the star's current direction; at s = 1
 *  with sweep = spin, where the turn started. */
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
  /** per-arc ink multiplier, 0..1 — the star's own, held along the whole arc */
  ink: number;
  /** the star's temperature tint (optics/sky.ts `Star.tint`) */
  tint: readonly [number, number, number];
}

/** The arcs the geometry is built over: one per star, in catalog order. The ink
 *  is `Star.ink` times the width floor's compensation — a star whose honest
 *  half-width falls under `minHalfRad` is drawn at the floor and dimmed by
 *  exactly that ratio. */
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
  /** attach via SceneHandle.starfieldAttach — it carries no transform of its
   *  own and rides the starfield group's per-frame camera-centring */
  object: THREE.Object3D;
  /** how many radians of rotation history the tails span. The driver hands this
   *  the same θ it writes to `uSkySpin`, which glues the heads to the discs. */
  setSweep(rad: number): void;
  /** the scene envelope, 0..1 — a straight multiplier on every arc's alpha */
  setEnvelope(o: number): void;
  /** re-palette in place: two uniform writes, no rebuild */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** Build the trail engine: one BufferGeometry and one material over the
 *  authored catalog, with no GPU work at construction. */
export function createStarTrails(opts: { light: boolean }): StarTrails {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uTrailSweep = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().trail ?? palette().star));
  const uInkFloor = uniform(light ? TRAIL_LOOK.lightInkFloor : 0);
  // the stars' own opacity, no gain: per-arc dimming is `aInk` and the only
  // field-wide one is the scene envelope
  const uInkOpacity = uniform(palette().starOpacity);

  // The template ribbon, one instance per star: SEG + 1 rungs of two vertices,
  // indexed as SEG quads. `position` holds the ribbon's parameters —
  // (side, s, 0) — not a place; the landing point is solved from the instance's
  // `aDir` and the spin uniforms.
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

  // the per-star half of the arc: one value per instance, not per vertex
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
  // stated, not computed: `position` holds parameters, so three would measure
  // the template's unit ball — the arcs cover the whole sky sphere
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), TRAIL_LOOK.radius);

  // ── the graph ──────────────────────────────────────────────────────────────
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false; // sky ink — optics/constellation-lines.ts's contract
  mat.side = THREE.DoubleSide; // a view-space billboard's winding flips
  mat.toneMapped = false; // flat ink, not a lit surface

  const R = float(TRAIL_LOOK.radius);
  const nDir: TslNode = attribute("aDir", "vec3");
  const nHalf: TslNode = attribute("aHalf", "float");
  const nInk: TslNode = attribute("aInk", "float");
  const nTint: TslNode = attribute("aTint", "vec3");
  const side: TslNode = positionGeometry.x;
  const s: TslNode = positionGeometry.y;

  // `trailDirAt`, spelled in TSL: the head rides the sky's current rotation and
  // every rung behind it is that rotation minus its own share of the sweep.
  const dirAt = rodriguesTsl(
    nDir,
    uSkySpinAxis,
    uSkySpin.sub(s.mul(uTrailSweep)),
  );
  const centre: TslNode = modelViewMatrix.mul(vec4(dirAt.mul(R), 1));
  // the arc's own tangent at this rung (axis × p, the rotation's velocity),
  // projected to the screen and turned a quarter turn to get the width's normal
  const along = safeDir2(
    modelViewMatrix.mul(vec4(cross(uSkySpinAxis, dirAt), 0)).xy,
  );
  const nrm: TslNode = vec2(along.y.negate(), along.x).mul(R.mul(nHalf));
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(
      centre.x.add(nrm.x.mul(side)),
      centre.y.add(nrm.y.mul(side)),
      centre.z,
      centre.w,
    ),
  );

  const vSide: TslNode = varying(side);
  const vInk: TslNode = varying(nInk);
  const vTint: TslNode = varying(nTint);
  // across the band: full ink through the core, feathered to nothing at edge
  const across: TslNode = float(1).sub(
    smoothstep(float(TRAIL_LOOK.core), float(1), abs(vSide)),
  );

  // the theme's ink at this star's temperature — the same product the disc is
  // drawn with, so a trail is its star's colour
  mat.colorNode = uInk.mul(vTint);
  // no `s` term: the ink is the star's, flat from head to tail
  mat.opacityNode = across
    .mul(vInk.max(uInkFloor))
    .mul(uEnvelope)
    .mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_StarTrails";
  // the sky sphere is re-centred on the camera every frame, so it is never out
  // of frame
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
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
