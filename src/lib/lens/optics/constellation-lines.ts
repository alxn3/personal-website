import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  float,
  mix,
  modelViewMatrix,
  positionGeometry,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/tsl-types";
import { SKY_INK, type SkyPalette } from "./sky";
import { STARFIELD_LOOK, safeDir2 } from "./starfield";

// Constellation lines — strokes that draw themselves between two stars, with a
// travelling head, a gap at each end, and an age fade. story/constellations.ts
// is the only caller.
//
// One draw call: a fixed ring buffer of SLOT_COUNT quads, built once and never
// resized. A spawn writes endpoints, a birth stamp and a duration; everything
// after that is solved in the fragment off one uniform (`uConstTime`). A dead
// slot is neither hidden nor culled — its age saturates its alpha to 0.
//
// Quads, not lines: three's WebGPU backend gives no usable line width, and a
// stroke needs its width in view space to hold one screen weight at any fov.
// Both endpoints sit on the same sphere about the camera, so one fixed
// view-space offset is a fixed screen width — starfield.ts's `lineMark` trick.
//
// Material: these take the ordinary transparent path with `depthTest = false`,
// where starfield.ts must ride the opaque list so three's transmission copy
// picks the stars up. That is safe only because the envelope is 0 until the
// dive is over and nothing is ever in front of them. A scene that wants these
// strokes seen through the lens must move them to the opaque-list contract.

/** How many line slots the ring buffer holds. Sized against the driver's
 *  cadence and lifetime so a slot is only recycled long after it has faded to
 *  nothing. */
export const SLOT_COUNT = 24;

/** The gap at each end, radians of sky — one fixed angle, so a stroke leaves
 *  the same ring of clear sky around a star whatever its length, and it must
 *  clear the catalog's biggest disc. Carried by the geometry: spawn writes
 *  already-inset endpoints. */
export const GAP_RAD = 0.009;

/** The ceiling on either end's inset, as a fraction of the segment — what makes
 *  `lineInsetAt` total, so no separation can inset a stroke past its own middle
 *  and invert it. */
export const GAP_MAX = 0.4;

/** The inset at one endpoint, as a fraction of the segment — the fixed angular
 *  gap in the units the spawn writes its endpoints in, capped. */
export const lineInsetAt = (sepRad: number): number =>
  Math.min(GAP_MAX, GAP_RAD / Math.max(sepRad, 1e-6));

/** The head's soft leading edge, in units of the segment parameter t. The pen
 *  therefore travels from t = 0 to t = 1 + HEAD_SOFT, so a finished stroke is
 *  at full ink all the way to its far end. */
export const HEAD_SOFT = 0.08;

export const CONST_LINES_LOOK = {
  /** the sphere the strokes are drawn on: just inside the starfield's, so this
   *  mesh sorts nearer in the transparent pass. Derived from the one starfield
   *  radius so the two cannot drift apart. */
  radius: STARFIELD_LOOK.radius * 0.99,
  /** angular half-thickness of a stroke, radians — about one pixel total. The
   *  on-axis px/rad is H/(2·tan(fov/2)) and the frame's edge is wider by
   *  1/cos γ; keep it above a pixel or the line drops out between centres. */
  halfWidthRad: 0.00088,
  /** the fraction of the half-width at full ink before the edge feathers — the
   *  strokes' version of STARFIELD_LOOK.lineCore. */
  core: 0.35,
  /** a multiplier on SKY_INK's `lineOpacity`, buying back in ink what the width
   *  gave up. The products it makes must stay under 1: `opacityNode` is
   *  unclamped and an alpha over 1 over-brightens. */
  inkGain: 1.75,
  /** the pen's speed, ms per radian of angular separation — constant rate, so a
   *  long line honestly takes longer than a short one. */
  penMsPerRad: 4500,
  /** floor and ceiling on that, ms: short enough to be seen travelling, long
   *  enough that no stroke simply appears. */
  drawMsMin: 700,
  drawMsMax: 2000,
  /** how long a finished stroke holds at full ink before it starts to go */
  lifeMs: 9000,
  /** and how long it takes to go, ms. draw + life + fade is a slot's whole
   *  lifetime — keep it under SLOT_COUNT × the driver's cadence. */
  fadeMs: 3500,
};

/** A unit direction, the form optics/sky.ts's `dirOf` returns. */
export type Dir3 = readonly [number, number, number];

/** The pen's position along the stroke, 0..1, `drawMs` after birth. Smoothstep
 *  rather than linear, so the pen accelerates off the first star and settles
 *  onto the second. Monotone, exactly 0 at age 0 and 1 from `drawMs` on. */
export const lineHeadAt = (ageMs: number, drawMs: number): number => {
  const x = Math.min(1, Math.max(0, ageMs / Math.max(1, drawMs)));
  return x * x * (3 - 2 * x);
};

/** The age fade, 1..0: a stroke holds at full ink for `lifeMs` after it has
 *  finished drawing, then fades over `fadeMs`. Saturates at both ends, so a
 *  long-dead slot is exactly 0 and can stay in the draw call. */
export const lineAlphaAt = (
  ageMs: number,
  drawMs: number,
  lifeMs: number,
  fadeMs: number,
): number => {
  const t0 = drawMs + lifeMs;
  const x = Math.min(1, Math.max(0, (ageMs - t0) / Math.max(1, fadeMs)));
  return 1 - x * x * (3 - 2 * x);
};

/** How long the pen takes over a stroke of `sepRad` radians — constant speed,
 *  clamped at both ends. */
export const lineDrawMs = (sepRad: number): number =>
  Math.min(
    CONST_LINES_LOOK.drawMsMax,
    Math.max(CONST_LINES_LOOK.drawMsMin, sepRad * CONST_LINES_LOOK.penMsPerRad),
  );

export interface ConstellationLines {
  /** attach this (via SceneHandle.starfieldAttach) — it carries no transform of
   *  its own and expects to ride the starfield group's camera-centring */
  object: THREE.Object3D;
  /** Start a new stroke between two unit directions, born at `nowMs` on the
   *  driver's accumulated clock (the clock `setTime` is fed). Both ends are
   *  inset by the fixed gap — see `GAP_RAD`. */
  spawn(a: Dir3, b: Dir3, nowMs: number): void;
  /** advance the one clock every law in the shader reads */
  setTime(ms: number): void;
  /** the scene envelope, 0..1 — a flat multiplier on every stroke's alpha */
  setEnvelope(o: number): void;
  /** re-palette in place: one uniform write, no rebuild */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** The four corners of a stroke quad as (side, t): side ±1 across the width,
 *  t 0 at the first star's end and 1 at the second's. */
const CORNERS: [side: number, t: number][] = [
  [-1, 0],
  [1, 0],
  [1, 1],
  [-1, 1],
];
const QUAD_TRIS = [0, 1, 2, 0, 2, 3];

/** Birth stamp of a slot that has never been used, ms: far enough in the past
 *  that its age saturates every fade to zero on the first frame. */
const NEVER = -1e6;

/** Build the line engine: one BufferGeometry of quads and one material, with no
 *  GPU work at build. */
export function createConstellationLines(opts: {
  light: boolean;
}): ConstellationLines {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uConstTime = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().line));
  const uInkOpacity = uniform(palette().lineOpacity * CONST_LINES_LOOK.inkGain);

  // The ring buffer: `position` holds the quad's parameters (side, t, 0) and
  // never changes; the four dynamic attributes are what a spawn writes.
  const position = new Float32Array(SLOT_COUNT * 4 * 3);
  const aA = new Float32Array(SLOT_COUNT * 4 * 3);
  const aB = new Float32Array(SLOT_COUNT * 4 * 3);
  const aBirth = new Float32Array(SLOT_COUNT * 4);
  const aDraw = new Float32Array(SLOT_COUNT * 4);
  const index = new Uint16Array(SLOT_COUNT * 6);
  for (let s = 0; s < SLOT_COUNT; s++) {
    for (let c = 0; c < 4; c++) {
      const v = s * 4 + c;
      position[v * 3] = CORNERS[c][0];
      position[v * 3 + 1] = CORNERS[c][1];
      position[v * 3 + 2] = 0;
      aBirth[v] = NEVER;
      aDraw[v] = CONST_LINES_LOOK.drawMsMin;
    }
    for (let t = 0; t < 6; t++) index[s * 6 + t] = s * 4 + QUAD_TRIS[t];
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(position, 3);
  const aAttr = new THREE.BufferAttribute(aA, 3);
  const bAttr = new THREE.BufferAttribute(aB, 3);
  const birthAttr = new THREE.BufferAttribute(aBirth, 1);
  const drawAttr = new THREE.BufferAttribute(aDraw, 1);
  // the four a spawn rewrites are re-uploaded for the life of the page; the
  // quad parameters and the index are written once and never again
  for (const a of [aAttr, bAttr, birthAttr, drawAttr])
    a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("aA", aAttr);
  geo.setAttribute("aB", bAttr);
  geo.setAttribute("aBirth", birthAttr);
  geo.setAttribute("aDraw", drawAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false; // sky ink — see the material note in the header
  mat.side = THREE.DoubleSide; // a view-space billboard's winding flips
  mat.toneMapped = false; // flat ink, not a lit surface

  const nA: TslNode = attribute("aA", "vec3");
  const nB: TslNode = attribute("aB", "vec3");
  const nBirth: TslNode = attribute("aBirth", "float");
  const nDraw: TslNode = attribute("aDraw", "float");
  const side: TslNode = positionGeometry.x;
  const t: TslNode = positionGeometry.y;

  // View space, as starfield.ts's starMark/lineMark do it: the object has no
  // rotation (the starfield group it rides only translates onto the camera), so
  // an offset perpendicular to the segment there is a constant screen width.
  const va: TslNode = modelViewMatrix.mul(vec4(nA, 1));
  const vb: TslNode = modelViewMatrix.mul(vec4(nB, 1));
  const p: TslNode = mix(va, vb, t);
  const along = safeDir2(vb.xy.sub(va.xy));
  const n: TslNode = vec2(along.y.negate(), along.x).mul(
    CONST_LINES_LOOK.radius * CONST_LINES_LOOK.halfWidthRad,
  );
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(p.x.add(n.x.mul(side)), p.y.add(n.y.mul(side)), p.z, p.w),
  );

  const vSide: TslNode = varying(side);
  const vT: TslNode = varying(t);
  const vBirth: TslNode = varying(nBirth);
  const age: TslNode = uConstTime.sub(vBirth);
  const draw: TslNode = varying(nDraw);

  // the head — `lineHeadAt` in TSL. The pen runs to 1 + HEAD_SOFT so the
  // feather is fully past the far end when the stroke is finished.
  const head: TslNode = smoothstep(float(0), draw, age).mul(1 + HEAD_SOFT);
  const drawn: TslNode = float(1).sub(
    smoothstep(head.sub(HEAD_SOFT), head, vT),
  );
  // the age fade — `lineAlphaAt` in TSL
  const fade: TslNode = float(1).sub(
    smoothstep(
      float(0),
      float(CONST_LINES_LOOK.fadeMs),
      age.sub(draw).sub(CONST_LINES_LOOK.lifeMs),
    ),
  );
  // the stroke's cross-section: full ink through the core, feathered to nothing
  const across: TslNode = float(1).sub(
    smoothstep(float(CONST_LINES_LOOK.core), float(1), abs(vSide)),
  );

  mat.colorNode = uInk;
  mat.opacityNode = across.mul(drawn).mul(fade).mul(uEnvelope).mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_ConstellationLines";
  // `position` holds quad parameters, so three's bounding sphere means nothing
  // — the real extent is the whole sphere
  mesh.frustumCulled = false;

  let next = 0;

  return {
    object: mesh,
    spawn(a, b, nowMs) {
      const s = next;
      next = (next + 1) % SLOT_COUNT; // oldest slot first, always
      const r = CONST_LINES_LOOK.radius;
      const dot = Math.min(
        1,
        Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
      );
      const sep = Math.acos(dot);
      const drawMs = lineDrawMs(sep);
      // the gap, baked into the endpoints as a fraction of this segment
      const f = lineInsetAt(sep);
      for (let k = 0; k < 3; k++) {
        // along the chord, matching the straight quad the shader draws
        const ea = a[k] * r;
        const eb = b[k] * r;
        const d = eb - ea;
        for (let c = 0; c < 4; c++) {
          aA[(s * 4 + c) * 3 + k] = ea + d * f;
          aB[(s * 4 + c) * 3 + k] = eb - d * f;
        }
      }
      for (let c = 0; c < 4; c++) {
        aBirth[s * 4 + c] = nowMs;
        aDraw[s * 4 + c] = drawMs;
      }
      // only what a spawn touched, and only on a spawn frame
      aAttr.needsUpdate = true;
      bAttr.needsUpdate = true;
      birthAttr.needsUpdate = true;
      drawAttr.needsUpdate = true;
    },
    setTime(ms) {
      uConstTime.value = ms;
    },
    setEnvelope(o) {
      uEnvelope.value = o;
    },
    setTheme(l) {
      light = l;
      const pal = palette();
      uInk.value.setHex(pal.line);
      uInkOpacity.value = pal.lineOpacity * CONST_LINES_LOOK.inkGain;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
