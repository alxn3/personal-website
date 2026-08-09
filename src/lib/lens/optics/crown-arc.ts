import * as THREE from "three/webgpu";
import {
  abs,
  cos,
  float,
  mix,
  positionGeometry,
  pow,
  screenSize,
  sin,
  smoothstep,
  uniform,
  varying,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/algebra-tsl";
import { SKY_INK, type SkyPalette } from "./sky";

// ============================================================================
// THE CROWN ARC — the one stroke of sky ink that becomes the lens.
//
// It starts life looking like one more star trail among the field of them
// (optics/star-trails.ts), and it ends as the TOP EDGE OF THE FRONT ELEMENT:
// the same circle the reassembling lens's front glass draws on screen, held
// there while the element arrives inside it, and faded out once the element is
// unmistakably the thing you are looking at. Trail → arc → lens edge, one mark.
//
// AUTHORED INK, NOT SKY GEOMETRY — and that is the whole reason this file
// exists apart from optics/star-trails.ts. The crown used to be the last arc in
// the trail soup: a physics-true circumpolar trail about `SKY_SPIN_AXIS`. That
// cannot ever register with the lens, for two structural reasons.
//
//   1. THE POLE IS IN THE WRONG PLACE. A trail's circle is centred on the spin
//      pole, which sits ~290 px BELOW frame centre, while the front element's
//      crown lands ~5 px above it. Any arc tight enough to read as a crown was
//      necessarily 200-290 px low, and moving the pole is not on the table —
//      the whole field wheels about it.
//   2. THE CAMERA IS FLYING. Through the reveal the camera reverses back
//      through the lens (world x ≈ +16 → −12 across rewrap-local [0, 0.25]),
//      which drags any fixed sky direction clear across the frame and off it.
//      Measured: the old crown's head went (823, 545) → (41, 587) → off screen
//      over p .78 → .84.
//
// So the crown is drawn where it is WANTED instead: a circle segment in SCREEN
// space, straight to clip space, with no camera and no sphere in the graph at
// all. Which is also the house flat-2D law read literally — only the lens model
// is allowed to be 3D, and this is a vector-graphic arc.
//
// RESOLUTION-FREE BY CONSTRUCTION. Every length here is in FRAME HEIGHTS from
// the frame's centre (+x right, +y DOWN, so it reads like the screen), and the
// only thing the shader asks the renderer for is `screenSize` — used for the
// aspect and nothing else. A fixed perspective camera projects a fixed world
// point to a pixel offset proportional to the canvas HEIGHT (the fov is
// vertical), so these fractions are exactly right at any size and any DPR.
//
// ONE MORE DRAW, AND NOTHING MOVES ON THE CPU. A single strip of `segments`
// quads, built once; the whole shape is six uniforms, so the driver
// (story/trails.ts) re-authors the arc every frame for the price of six writes.
// ============================================================================

/** The crown's look and its two authored positions.
 *
 *  MEASURED, NOT GUESSED (1425×900, dark theme, live scene). `trail` is where
 *  the crown's old circumpolar circle actually projected at the held fly pose —
 *  centre (712.5, 776), radius ~248 px on a 900 px canvas — so the arc opens the
 *  scene sitting exactly where a trail of its old geometry sat, and reads as one
 *  of them. `lens` is WHERE THE LENS WILL BE: the front element's drawn disc at
 *  rewrap-local 0.25 — centre (532, 452), radius 87 — which is the beat the
 *  shading hands back and the element starts being drawn at all. The arc parks
 *  on those numbers for the whole blind stretch before that (the element is
 *  behind the camera through the trails scene and invisible glass after it, so
 *  there is nothing to ask), and story/trails.ts starts tracking the live disc
 *  from exactly there — so the hand-off begins on numbers that already agree and
 *  has nothing to jump. */
export const CROWN_LOOK = {
  /** the arc while it is still one of the trails — frame heights from centre */
  trail: { cx: 0, cy: 0.362, r: 0.275 },
  /** …and where it waits for the lens */
  lens: { cx: -0.2, cy: 0.002, r: 0.096 },
  /** the arc's HALF-width, frame heights. The old sky-space crown drew at 0.01
   *  rad, which at the finale's fov 70 is ~0.008 of the frame height — kept, so
   *  the mark's weight does not change with its geometry. */
  half: 0.008,
  /** how much of the circle the crown inks at the reveal, radians. Wide enough
   *  to read as the top of a round thing, short enough not to close into a ring
   *  the element would have to fill. */
  span: 1.5,
  /** the head's screen angle at zero spin, radians (atan2 with +y DOWN): the top
   *  of the circle, which is both where the old crown's tail sat and where a
   *  crown belongs. */
  phi0: -Math.PI / 2,
  /** rungs along the arc − 1. The arc is at most ~250 px of radius, so 24
   *  segments keeps the chord error well under a pixel. */
  segments: 24,
  /** fraction of the half-width at full ink before the edge feathers —
   *  optics/constellation-lines.ts's `core`, and star-trails' too. */
  core: 0.4,
  /** the TRAIL end of the along-arc fade: alpha ∝ (1 − s)^this, matching
   *  optics/star-trails.ts's `fadePow` so the crown dies away toward its tail
   *  exactly like its neighbours while it is still pretending to be one. */
  fadePow: 1.5,
  /** …and the CROWN end of it: an even stroke with both ends feathered over this
   *  fraction of the arc, because a lens edge has no head and no tail. */
  endFeather: 0.16,
  /** a multiplier on SKY_INK's `starOpacity`. Above the field's 0.55: this is
   *  the one arc the eye is meant to follow. */
  inkGain: 0.88,
};

/** Where a point of the arc lands, in frame heights from the frame's centre
 *  (+x right, +y DOWN) — the CPU mirror of the vertex graph's circle, and the
 *  law the tests hold. `s` runs 0 at the head to 1 at the tail, and the arc
 *  sweeps BACKWARD from the head exactly as a trail's does. */
export function crownPointAt(
  circle: { cx: number; cy: number; r: number },
  phi0: number,
  span: number,
  s: number,
): [number, number] {
  const a = phi0 - s * span;
  return [
    circle.cx + circle.r * Math.cos(a),
    circle.cy + circle.r * Math.sin(a),
  ];
}

export interface CrownArc {
  /** attach this at the SCENE ROOT (SceneHandle.addOverlay) — it is screen
   *  space, so it wants no parent transform and it must outlive the starfield */
  object: THREE.Object3D;
  /** re-author the arc: the circle (frame heights from centre), the head's
   *  screen angle and the arc's length in radians, and `morph` — 0 draws it as
   *  a trail (bright head, dying tail), 1 as an even edge feathered both ends. */
  setShape(
    cx: number,
    cy: number,
    r: number,
    phi0: number,
    span: number,
    morph: number,
  ): void;
  /** the scene envelope, 0..1 — a straight multiplier on the arc's alpha */
  setEnvelope(o: number): void;
  /** re-palette in place: two uniform writes, no rebuild */
  setTheme(light: boolean): void;
  dispose(): void;
}

/**
 * Build the crown. Cheap and synchronous: one strip of quads and one material,
 * no textures and no GPU work at construction.
 */
export function createCrownArc(opts: { light: boolean }): CrownArc {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uCx = uniform(CROWN_LOOK.trail.cx);
  const uCy = uniform(CROWN_LOOK.trail.cy);
  const uR = uniform(CROWN_LOOK.trail.r);
  const uPhi0 = uniform(CROWN_LOOK.phi0);
  const uSpan = uniform(0);
  const uMorph = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().star));
  const uInkOpacity = uniform(palette().starOpacity * CROWN_LOOK.inkGain);

  // ── the strip ──────────────────────────────────────────────────────────────
  // `position` holds the quad's PARAMETERS and not a place, exactly as in
  // optics/star-trails.ts: (side, s, 0), with side ±1 across the width and s
  // running 0 at the head to 1 at the tail.
  const SEG = CROWN_LOOK.segments;
  const position = new Float32Array((SEG + 1) * 2 * 3);
  const index = new Uint32Array(SEG * 6);
  for (let r = 0; r <= SEG; r++)
    for (let k = 0; k < 2; k++) {
      const v = r * 2 + k;
      position[v * 3] = k === 0 ? -1 : 1;
      position[v * 3 + 1] = r / SEG;
      position[v * 3 + 2] = 0;
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // ── the graph ──────────────────────────────────────────────────────────────
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false; // sky ink — optics/constellation-lines.ts's contract
  mat.side = THREE.DoubleSide; // the strip's winding flips with the arc
  mat.toneMapped = false; // flat ink, not a lit surface

  const side: TslNode = positionGeometry.x;
  const s: TslNode = positionGeometry.y;
  // the circle, in frame heights: the width is a RADIAL offset, which is the
  // exact normal of a circle and costs nothing to spell
  const ang = uPhi0.sub(s.mul(uSpan));
  const rr = uR.add(side.mul(float(CROWN_LOOK.half)));
  const px: TslNode = uCx.add(rr.mul(cos(ang)));
  const py: TslNode = uCy.add(rr.mul(sin(ang)));
  // …and straight to clip space. `screenSize` is asked for the ASPECT alone:
  // one frame height is 2 NDC units vertically and 2/aspect horizontally.
  const aspect: TslNode = screenSize.x.div(screenSize.y);
  mat.vertexNode = vec4(
    px.mul(float(2).div(aspect)),
    py.mul(-2), // frame heights run DOWN; NDC y runs up
    0,
    1,
  );

  const vSide: TslNode = varying(side);
  const vS: TslNode = varying(s);
  // across the band: full ink through the core, feathered to nothing at the edge
  const across: TslNode = float(1).sub(
    smoothstep(float(CROWN_LOOK.core), float(1), abs(vSide)),
  );
  // and along it: a trail's dying tail, or an edge's even stroke
  const asTrail: TslNode = pow(float(1).sub(vS), float(CROWN_LOOK.fadePow));
  const feather = float(CROWN_LOOK.endFeather);
  const asEdge: TslNode = smoothstep(float(0), feather, vS).mul(
    smoothstep(float(0), feather, float(1).sub(vS)),
  );
  const along: TslNode = mix(asTrail, asEdge, uMorph);

  mat.colorNode = uInk;
  mat.opacityNode = across.mul(along).mul(uEnvelope).mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_CrownArc";
  // `position` holds quad parameters and the graph never reads a matrix, so
  // three's bounding sphere means nothing here.
  mesh.frustumCulled = false;
  // last of the transparent pass: this mark goes over the sky AND over the model
  mesh.renderOrder = 10;

  return {
    object: mesh,
    setShape(cx, cy, r, phi0, span, morph) {
      uCx.value = cx;
      uCy.value = cy;
      uR.value = r;
      uPhi0.value = phi0;
      uSpan.value = span;
      uMorph.value = morph;
    },
    setEnvelope(o) {
      uEnvelope.value = o;
    },
    setTheme(l) {
      light = l;
      const pal = palette();
      uInk.value.setHex(pal.star);
      uInkOpacity.value = pal.starOpacity * CROWN_LOOK.inkGain;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
