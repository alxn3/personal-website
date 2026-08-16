import * as THREE from "three/webgpu";
import {
  abs,
  cos,
  float,
  mix,
  positionGeometry,
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
//   1. A TRAIL'S CIRCLE IS FIXED, and the lens's is not. The spin pole is on
//      the view axis (optics/starfield.ts), so a trail is a circle centred on
//      the frame's centre — the family's centre is not a knob, the whole field
//      wheels about it — and its RADIUS is its one free number, set once by how
//      far its star sits off the pole. The front element's drawn disc has to be
//      MET, not chosen: it tightens to ~0.041 frame heights at the hand-off
//      (`lens` below), then more than doubles and walks a fifth of a frame
//      height left as the lens seats and the ending's camera swings. No star
//      does that; no member of the family can be re-pointed to follow it.
//   2. THE SKY DOES NOT STAY WHERE THE LENS IS. The crown has to hold its
//      registration from the trails all the way to the end of the reveal, and
//      over that stretch the fly's fov ramp SCALES every sky direction about the
//      frame's centre while the lens's own disc is doing something else
//      entirely; past the reveal the story's camera chain is released and swings
//      off the optical axis, which drags a fixed sky direction clear across the
//      frame and off it. (Under the old two-camera dive the same argument was
//      even blunter: the camera reversed back through the lens, and the old
//      crown's head went (823, 545) → (41, 587) → off screen over p .78 → .84.)
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
 *  `trail` IS A MEMBER OF THE FAMILY, and that is all it has to be. The spin
 *  pole is on the view axis (optics/starfield.ts SKY_SPIN_ELEV_RAD), so a star
 *  trail projects to a circle centred on the FRAME'S CENTRE whatever the fov —
 *  hence cx = cy = 0, which is not a placement but the geometry. The radius is
 *  the one free number, the same way a real trail's radius is just how far its
 *  star sits off the pole: 0.2 frame heights is the circle of a star ~0.27 rad
 *  off the axis at the finale's fov 70, well inside the field's own spread, so
 *  the crown reads as one of its neighbours (owner: "further away from the
 *  camera so it's a smaller arc").
 *  `lens` is WHERE THE LENS WILL BE, and it is MEASURED, not derived — read off
 *  the live scene with `SceneHandle.projectDrawn("Element_01")` at rewrap-local
 *  0.14, which is where story/trails.ts's `crownLiveAt` takes over and starts
 *  tracking the real disc. (Measured through the dev probe rather than off a
 *  screenshot: the same function the tracker reads, so the parked number and the
 *  first live one are the same quantity by construction. It is also
 *  resolution-free — frame heights — and was re-checked identical to five
 *  decimals at 1280×820 and 1425×900.)
 *
 *  IT IS CONCENTRIC NOW, and that is the reveal's whole geometry rather than a
 *  coincidence: the camera holds the dive's parked pose dead on the optical axis
 *  for the whole reveal (story/story.ts REVEAL_END), and the front element sits
 *  ON that axis, so its drawn disc is centred on the frame — measured
 *  (−0.0001, −0.0001), a tenth of a pixel. So the resolve is a pure tightening
 *  now, not the walk-left it was when the story camera had already swung off
 *  axis by 0.14. It also makes the hand-over EXACT: nothing moves between 0.14
 *  and 0.22, so the parked circle and the first live one are the same circle.
 *
 *  IT IS SMALL, and that is the pose, not a mistake: at 0.14 the lens has just
 *  been uncovered under the fly's own fov (70°) at the reveal's overshoot (12.5
 *  units from the parked camera — story/fly.ts REVEAL_X), so the front element
 *  is a ~0.041-frame-height disc. It more than doubles over the next fifth of
 *  the scene as the lens seats and the framing is handed back to the story
 *  (story/fly.ts flySeatAt, flyFovBackAt) — which the crown follows, because
 *  from 0.14 on it is reading the live disc rather than this. The arc parks on
 *  these numbers only for the blind stretch before that, where the element is
 *  behind the camera or fully faded glass and there is nothing to ask. */
export const CROWN_LOOK = {
  /** the arc while it is still one of the trails — frame heights from centre,
   *  and the centre is where every trail's is */
  trail: { cx: 0, cy: 0, r: 0.2 },
  /** …and where it waits for the lens */
  lens: { cx: 0, cy: 0, r: 0.0406 },
  /** the arc's HALF-width, frame heights — a 0.6%-of-height band, ~5 px on a
   *  900 px stage, feathered from `core` outward. Owner, twice: thinner, and
   *  then "way too thick" again at 0.005 (~9 px). The gauge is the FIELD: the
   *  trails around it are 1–2 px arcs, and the crown has to pass for one of them
   *  for a whole scene before it resolves — at 9 px it read as a ring highlight
   *  laid over the sky rather than as kin to the marks beside it. Nothing
   *  derives from it; the mark's weight is its own decision. */
  half: 0.003,
  /** how much of the circle the crown inks at the reveal, radians. Wide enough
   *  to read as the top of a round thing, short enough not to close into a ring
   *  the element would have to fill. */
  span: 1.5,
  /** the head's screen angle at zero spin, radians (atan2 with +y DOWN): the top
   *  of the circle, which is both where the old crown's tail sat and where a
   *  crown belongs. */
  phi0: -Math.PI / 2,
  /** rungs along the arc − 1. Sized on the LONGEST span the arc ever draws,
   *  which is its trail phase: story/trails.ts hands it the sky's own sweep
   *  there, now a half revolution (optics/star-trails.ts TRAIL_SWEEP_MAX). π
   *  over 48 rungs on a ~180 px radius is under a tenth of a pixel of chord sag;
   *  at the old 24 it would have been a third of one. */
  segments: 48,
  /** fraction of the half-width at full ink before the edge feathers —
   *  optics/constellation-lines.ts's `core`, and star-trails' too. */
  core: 0.4,
  /** the CROWN end of the along-arc ink: an even stroke with both ends feathered
   *  over this fraction of the arc, because a lens edge has no head and no tail.
   *  The TRAIL end is a flat 1 and needs no knob — a star trail carries its
   *  star's ink from head to tail (optics/star-trails.ts), so anything else here
   *  would give the crown away while it is still pretending to be one. */
  endFeather: 0.16,
  /** a multiplier on SKY_INK's `starOpacity`. 1 — the same ink a trail is drawn
   *  at, which is what lets it hide in the field; it becomes the one arc the eye
   *  follows by OUTLIVING the field, not by being brighter than it. */
  inkGain: 1,
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
   *  a trail (flat ink, like the field's arcs), 1 as an even edge feathered
   *  both ends. */
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
  // and along it: a trail's flat ink, or an edge's stroke feathered at both ends
  const feather = float(CROWN_LOOK.endFeather);
  const asEdge: TslNode = smoothstep(float(0), feather, vS).mul(
    smoothstep(float(0), feather, float(1).sub(vS)),
  );
  const along: TslNode = mix(float(1), asEdge, uMorph);

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
