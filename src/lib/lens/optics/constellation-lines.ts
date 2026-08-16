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
import type { TslNode } from "../ops/algebra-tsl";
import { SKY_INK, type SkyPalette } from "./sky";
import { STARFIELD_LOOK, safeDir2 } from "./starfield";

// ============================================================================
// CONSTELLATION LINES — strokes that DRAW THEMSELVES between two stars, with a
// travelling head, a gap at each end, and an age fade that takes them away
// again. The sky chapter's ink; story/constellations.ts is the only caller.
//
// ONE DRAW CALL, FOREVER. The geometry is a fixed ring buffer of SLOT_COUNT
// quads, built once and never resized. Spawning a line writes four vertices'
// worth of endpoints plus a birth stamp and a duration; everything that moves
// after that — the head's travel, the soft leading edge, the age fade — is
// solved in the fragment off ONE uniform (`uConstTime`). So the CPU cost of a
// living sky is one attribute write every ~1.2 s, and the GPU cost is 24 quads
// whether the sky is empty or full. A dead slot is not hidden, culled or
// compacted: its age is enormous, so its alpha is exactly 0.
//
// WHY A QUAD AND NOT A LINE. Same reason optics/starfield.ts draws quads:
// three's WebGPU backend gives no usable line width, and a stroke that has to
// read at a consistent weight over a 55° cone needs its width in VIEW SPACE.
// Both endpoints sit on the same sphere about the camera, so one fixed
// view-space offset is one fixed screen width along the whole stroke and at any
// fov — the trick optics/starfield.ts's `lineMark` already uses, reused here.
//
// FLAT-LAW COMPLIANT (only the lens model reads 3D): a stroke is a band of flat
// ink with a feathered edge. No lighting, no texture, no depth cue.
//
// ── MATERIAL: WHERE THIS DIFFERS FROM THE STARFIELD, AND WHY ────────────────
// optics/starfield.ts ships `transparent = false` + CustomBlending so the stars
// land in the OPAQUE list and three's transmission copy picks them up — that is
// what lets the glass refract them mid-dive. These lines take the ordinary
// transparent path instead, deliberately:
//   • They only ever have opacity where NO GLASS IS IN FRAME. The envelope
//     (story/constellations.ts) is 0 until the dive is over and the camera holds
//     deep sky, so being absent from the transmission copy costs nothing.
//   • `depthTest = false` (the starfield keeps depth testing ON, so the barrel
//     occludes stars correctly). Sky ink is drawn OVER everything; the same
//     envelope guarantees there is nothing in front of it to get wrong.
// If a future scene ever wants these strokes seen THROUGH the lens, they must
// move to the starfield's opaque-list contract — read its header first.
// ============================================================================

/** How many line slots the ring buffer holds. Sized against the driver's
 *  cadence and lifetime: at one spawn per ~1.2 s and a ~14 s life a slot is
 *  only ever recycled long after it has faded to nothing, so the buffer never
 *  cuts a living stroke off mid-life. */
export const SLOT_COUNT = 24;

/** THE GAP AT EACH END, RADIANS OF SKY — one fixed angle, so a stroke leaves the
 *  same ring of clear sky around a star whatever its length. It used to be a
 *  fraction of the segment (with a disc-clearing floor), which made the gap grow
 *  with the stroke; the owner read exactly that off the shipped page ("the gap
 *  between the line ends and the star aren't constant — it varies on the length,
 *  it should be a fixed gap size").
 *
 *  0.009 rad ≈ 6 px at the finale's fov 70 on an 800 px canvas, against the
 *  biggest disc in the catalog at ~0.0048 rad of RADIUS (optics/starfield.ts
 *  `starRho` at mag 3.1, ~3 px) — so even the brightest star keeps ~3 px of air,
 *  and a floor-sized speck ~5.
 *
 *  Carried by the GEOMETRY (the endpoints written on spawn are already inset),
 *  not by the shader — the shader has enough to do and the inset never changes
 *  after a spawn. */
export const GAP_RAD = 0.009;

/** the ceiling on either end's inset, as a fraction of the segment. The driver's
 *  own pair window keeps every stroke far clear of it (story/constellations.ts
 *  MIN_SEP is 0.08 rad, i.e. an inset of ~0.11 per end), so this is not a live
 *  limit — it is what makes `lineInsetAt` total: no separation, however
 *  degenerate, can inset a stroke past its own middle and invert it. */
export const GAP_MAX = 0.4;

/**
 * THE INSET AT ONE ENDPOINT, as a fraction of the segment — the fixed angular
 * gap expressed in the units the spawn writes its endpoints in, capped.
 */
export const lineInsetAt = (sepRad: number): number =>
  Math.min(GAP_MAX, GAP_RAD / Math.max(sepRad, 1e-6));

/** The head's soft leading edge, in units of the segment parameter t: the pen
 *  fades in over this much of the stroke rather than arriving as a hard chip.
 *  The pen therefore travels from t = 0 to t = 1 + HEAD_SOFT, so a finished
 *  stroke is at FULL ink all the way to its far end. */
export const HEAD_SOFT = 0.08;

/** Look knobs — the owner's to tune in one pass (Task 3 of the phase plan). */
export const CONST_LINES_LOOK = {
  /** the sphere the strokes are drawn on. Just inside the starfield's own radius
   *  — which buys NOTHING optically (this material neither tests nor writes
   *  depth, so the inset cannot make a stroke pass behind a star; what keeps the
   *  ink off the discs is `lineInsetAt`, on the CPU). All it does is sort this
   *  mesh nearer than the starfield in the transparent pass, which is where it
   *  wants to be anyway. Kept as one number so the two sphere radii can never
   *  drift apart. */
  radius: STARFIELD_LOOK.radius * 0.99,
  /** angular HALF-thickness of a stroke, radians. THE ONLY STROKE WIDTH ON THE
   *  SKY now that the starfield's pre-drawn asterisms are gated off
   *  (STARFIELD_LOOK.staticLines) — there is no second line system to be twice
   *  as wide as any more, so this is free to be as fine as it reads.
   *
   *  0.00088 — ONE PIXEL TOTAL, which is where the owner stopped it ("the lines
   *  connecting the stars for constellations are a bit too thick. Lets do 1
   *  pixel thick right now"), down from 0.0015 and 0.0026 before that.
   *
   *  THE ARITHMETIC IS THE ON-AXIS ONE, not the frame-average 655 px/rad the
   *  rest of the sky files quote. A stroke is offset in VIEW space and divided
   *  by the vertex's own depth, so at the finale's fov 70 a stroke through the
   *  middle of an 800 px canvas runs at H/(2·tan 35°) = 571 px/rad and one at
   *  the frame's edge is wider by 1/cos γ. 2 × 0.00088 × 571 = 1.00 px in the
   *  middle and ~1.2 px at the frame's edge: a hairline everywhere, and never
   *  under a pixel where it would start dropping out between pixel centres. */
  halfWidthRad: 0.00088,
  /** the fraction of the half-width that stays at full ink before the edge
   *  feathers — the strokes' version of STARFIELD_LOOK.lineCore. Low: a stroke
   *  whose core runs nearly to its edge reads as an extruded beam, and half the
   *  width in feather is what makes it read as a pen mark instead. */
  core: 0.35,
  /** a multiplier on SKY_INK's `lineOpacity`: these strokes are what the viewer
   *  is meant to be watching, and a mark this fine has to buy back in ink what
   *  it gave up in width.
   *
   *  1.75, up from 1.45 with the width cut to 0.59 of what it was: a stroke's
   *  weight is width × ink, so some of the ink has to come back or a 1 px line
   *  reads as a smudge — measured on the LIGHT stage, where graphite on cream
   *  had gone soft at the old product (dark ink on paper starts with less
   *  contrast to spend than cream on near-black). The products it makes —
   *  0.79 dark, 0.88 light — both stay under 1, which they must: `opacityNode`
   *  is not clamped and an alpha over 1 would over-brighten the blend. */
  inkGain: 1.75,
  /** THE PEN'S SPEED, ms per radian of angular separation — a stroke is drawn
   *  at a constant rate, so a long line honestly takes longer than a short one. */
  penMsPerRad: 4500,
  /** floor and ceiling on that, ms: short enough to be seen travelling, long
   *  enough that no stroke simply appears. */
  drawMsMin: 700,
  drawMsMax: 2000,
  /** how long a finished stroke holds at full ink before it starts to go, ms. */
  lifeMs: 9000,
  /** and how long it takes to go, ms. draw + life + fade is a slot's whole
   *  lifetime — keep it under SLOT_COUNT × the driver's cadence. */
  fadeMs: 3500,
};

/** A unit direction, the form optics/sky.ts's `dirOf` returns. */
export type Dir3 = readonly [number, number, number];

/** THE PEN'S POSITION along the stroke, 0..1, `drawMs` after birth. Smoothstep
 *  rather than linear: the pen accelerates away from the first star and settles
 *  onto the second, which is what makes the stroke read as drawn by a hand
 *  instead of extruded by a machine. Monotone, exactly 0 at age 0 and exactly 1
 *  from `drawMs` on. */
export const lineHeadAt = (ageMs: number, drawMs: number): number => {
  const x = Math.min(1, Math.max(0, ageMs / Math.max(1, drawMs)));
  return x * x * (3 - 2 * x);
};

/** THE AGE FADE, 1..0: a stroke holds at full ink for `lifeMs` AFTER it has
 *  finished drawing, then fades over `fadeMs`. Saturates at both ends, so a
 *  slot that has been dead for a while is exactly 0 — which is what lets a dead
 *  slot stay in the draw call instead of being culled. */
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
   *  driver's accumulated clock (the same clock `setTime` is fed). Both ends are
   *  inset by the fixed gap — see `GAP_RAD`. */
  spawn(a: Dir3, b: Dir3, nowMs: number): void;
  /** advance the one clock every law in the shader reads */
  setTime(ms: number): void;
  /** the scene envelope, 0..1 — a straight multiplier on every stroke's alpha */
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

/**
 * Build the line engine. Cheap and synchronous — one BufferGeometry of 24 quads
 * and one material; no textures, no render target, no GPU work at construction.
 */
export function createConstellationLines(opts: {
  light: boolean;
}): ConstellationLines {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uConstTime = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().line));
  const uInkOpacity = uniform(palette().lineOpacity * CONST_LINES_LOOK.inkGain);

  // ── the ring buffer ────────────────────────────────────────────────────────
  // `position` holds the quad's PARAMETERS (side, t, 0) and never changes — the
  // starfield's idiom. The four dynamic attributes are what a spawn writes.
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
  // the four a spawn rewrites are re-uploaded for the life of the page; the quad
  // parameters and the index are written once and never again
  for (const a of [aAttr, bAttr, birthAttr, drawAttr])
    a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("aA", aAttr);
  geo.setAttribute("aB", bAttr);
  geo.setAttribute("aBirth", birthAttr);
  geo.setAttribute("aDraw", drawAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // ── the graph ──────────────────────────────────────────────────────────────
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

  // VIEW SPACE, exactly as optics/starfield.ts's starMark/lineMark do it: the
  // object carries no rotation (the starfield group it rides only translates
  // onto the camera), so an endpoint through modelViewMatrix is that endpoint in
  // view space, and one offset perpendicular to the segment there is a constant
  // screen width at any fov.
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

  // THE HEAD — `lineHeadAt`, spelled in TSL. The pen runs to 1 + HEAD_SOFT so
  // the feather is fully past the far end when the stroke is finished.
  const head: TslNode = smoothstep(float(0), draw, age).mul(1 + HEAD_SOFT);
  const drawn: TslNode = float(1).sub(
    smoothstep(head.sub(HEAD_SOFT), head, vT),
  );
  // THE AGE FADE — `lineAlphaAt`, spelled in TSL.
  const fade: TslNode = float(1).sub(
    smoothstep(
      float(0),
      float(CONST_LINES_LOOK.fadeMs),
      age.sub(draw).sub(CONST_LINES_LOOK.lifeMs),
    ),
  );
  // and the stroke's own cross-section: full ink through the core, feathered to
  // nothing at the edge.
  const across: TslNode = float(1).sub(
    smoothstep(float(CONST_LINES_LOOK.core), float(1), abs(vSide)),
  );

  mat.colorNode = uInk;
  mat.opacityNode = across.mul(drawn).mul(fade).mul(uEnvelope).mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_ConstellationLines";
  // `position` holds quad parameters, so three's bounding sphere is a 1.5-unit
  // ball at the origin and means nothing — the real extent is the whole sphere.
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
      // THE GAP, baked into the endpoints: the same angle at both ends and on
      // every stroke, which as a FRACTION of this segment is this (lineInsetAt).
      const f = lineInsetAt(sep);
      for (let k = 0; k < 3; k++) {
        // Straight-line interpolation along the chord, matching the straight
        // quad the shader draws between the two endpoints.
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
