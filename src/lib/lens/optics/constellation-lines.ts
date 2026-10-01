import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
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
import { STARFIELD_LOOK, ribbonVertex, safeDir2 } from "./starfield";

// Constellation strokes that draw themselves between two stars, then fade.
// A fixed ring buffer of SLOT_COUNT quads; `spawn` writes a slot's endpoints and
// birth time, and the shader animates everything from one time uniform.
//
// Unlike the starfield these use the ordinary transparent path with no depth
// test, so they are not visible through the glass.

/** Ring-buffer size; a slot must have faded out before it is reused. */
export const SLOT_COUNT = 24;

/** Gap left at each end of a stroke, radians; must clear the biggest star disc. */
export const GAP_RAD = 0.009;

/** Max inset at either end, as a fraction of the segment. */
export const GAP_MAX = 0.4;

/** Inset at one end as a fraction of a segment `sepRad` long. */
export const lineInsetAt = (sepRad: number): number =>
  Math.min(GAP_MAX, GAP_RAD / Math.max(sepRad, 1e-6));

/** Soft leading edge of the drawing head, in segment units; the head runs to
 *  1 + HEAD_SOFT so a finished stroke is solid to its end. */
export const HEAD_SOFT = 0.08;

export const CONST_LINES_LOOK = {
  /** just inside the starfield sphere */
  radius: STARFIELD_LOOK.radius * 0.99,
  /** angular half-thickness, radians; keep the stroke at least a pixel wide */
  halfWidthRad: 0.00088,
  /** fraction of the half-width at full ink before the edge feathers */
  core: 0.35,
  /** multiplier on the palette's `lineOpacity`; the product must stay ≤ 1 */
  inkGain: 1.75,
  /** draw time, ms per radian of stroke length */
  penMsPerRad: 4500,
  /** draw time limits, ms */
  drawMsMin: 700,
  drawMsMax: 2000,
  /** ms a finished stroke holds at full ink */
  lifeMs: 9000,
  /** fade-out ms; draw + life + fade must stay under SLOT_COUNT × spawn interval */
  fadeMs: 3500,
};

/** A unit direction. */
export type Dir3 = readonly [number, number, number];

/** Head position along the stroke, 0..1, smoothstepped over `drawMs`. */
export const lineHeadAt = (ageMs: number, drawMs: number): number => {
  const x = Math.min(1, Math.max(0, ageMs / Math.max(1, drawMs)));
  return x * x * (3 - 2 * x);
};

/** Stroke alpha, 1..0: holds `lifeMs` after drawing, then fades over `fadeMs`. */
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

/** Draw time for a stroke `sepRad` radians long, clamped. */
export const lineDrawMs = (sepRad: number): number =>
  Math.min(
    CONST_LINES_LOOK.drawMsMax,
    Math.max(CONST_LINES_LOOK.drawMsMin, sepRad * CONST_LINES_LOOK.penMsPerRad),
  );

export interface ConstellationLines {
  /** attach via SceneHandle.starfieldAttach so it follows the camera */
  object: THREE.Object3D;
  /** Start a stroke between two directions at `nowMs` (the `setTime` clock). */
  spawn(a: Dir3, b: Dir3, nowMs: number): void;
  /** set the animation clock, ms */
  setTime(ms: number): void;
  /** overall opacity, 0..1 */
  setEnvelope(o: number): void;
  /** switch palette in place */
  setTheme(light: boolean): void;
}

/** Stroke quad corners as (side ±1 across, t 0..1 along). */
const CORNERS: [side: number, t: number][] = [
  [-1, 0],
  [1, 0],
  [1, 1],
  [-1, 1],
];
const QUAD_TRIS = [0, 1, 2, 0, 2, 3];

/** Birth time of an unused slot, ms; old enough to be fully faded. */
const NEVER = -1e6;

/** Builds the constellation stroke mesh (one draw call). */
export function createConstellationLines(opts: {
  light: boolean;
}): ConstellationLines {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uConstTime = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().line));
  const uInkOpacity = uniform(palette().lineOpacity * CONST_LINES_LOOK.inkGain);

  // `position` holds fixed quad parameters; the other attributes are per-spawn
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
  mat.depthTest = false;
  mat.side = THREE.DoubleSide; // billboard winding flips with the view
  // strokes never overlap, so one pass draws what three's two would
  mat.forceSinglePass = true;
  mat.toneMapped = false;

  const nA: TslNode = attribute("aA", "vec3");
  const nB: TslNode = attribute("aB", "vec3");
  const nBirth: TslNode = attribute("aBirth", "float");
  const nDraw: TslNode = attribute("aDraw", "float");
  const side: TslNode = positionGeometry.x;
  const t: TslNode = positionGeometry.y;

  // a view-space offset across the segment gives a constant screen width
  const va: TslNode = modelViewMatrix.mul(vec4(nA, 1));
  const vb: TslNode = modelViewMatrix.mul(vec4(nB, 1));
  const p: TslNode = mix(va, vb, t);
  const along = safeDir2(vb.xy.sub(va.xy));
  const n: TslNode = vec2(along.y.negate(), along.x).mul(
    CONST_LINES_LOOK.radius * CONST_LINES_LOOK.halfWidthRad,
  );
  mat.vertexNode = ribbonVertex(p, n, side);

  const vSide: TslNode = varying(side);
  const vT: TslNode = varying(t);
  const vBirth: TslNode = varying(nBirth);
  const age: TslNode = uConstTime.sub(vBirth);
  const draw: TslNode = varying(nDraw);

  // `lineHeadAt` in TSL
  const head: TslNode = smoothstep(float(0), draw, age).mul(1 + HEAD_SOFT);
  const drawn: TslNode = float(1).sub(
    smoothstep(head.sub(HEAD_SOFT), head, vT),
  );
  // `lineAlphaAt` in TSL
  const fade: TslNode = float(1).sub(
    smoothstep(
      float(0),
      float(CONST_LINES_LOOK.fadeMs),
      age.sub(draw).sub(CONST_LINES_LOOK.lifeMs),
    ),
  );
  // soft edge across the stroke
  const across: TslNode = float(1).sub(
    smoothstep(float(CONST_LINES_LOOK.core), float(1), abs(vSide)),
  );

  mat.colorNode = uInk;
  mat.opacityNode = across.mul(drawn).mul(fade).mul(uEnvelope).mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_ConstellationLines";
  // `position` holds quad parameters, so the computed bounds are meaningless
  mesh.frustumCulled = false;

  let next = 0;

  return {
    object: mesh,
    spawn(a, b, nowMs) {
      const s = next;
      next = (next + 1) % SLOT_COUNT; // reuse the oldest slot
      const r = CONST_LINES_LOOK.radius;
      const dot = Math.min(
        1,
        Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
      );
      const sep = Math.acos(dot);
      const drawMs = lineDrawMs(sep);
      // inset both endpoints along the chord to leave a gap at each star
      const f = lineInsetAt(sep);
      for (let k = 0; k < 3; k++) {
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
  };
}
