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
import type { TslNode } from "../ops/tsl-types";
import { SKY_INK, type SkyPalette } from "./sky";

// The crown arc — the one stroke of sky ink that becomes the lens: it starts as
// one more star trail among the field of them (optics/star-trails.ts) and ends
// as the top edge of the front element's drawn disc.
//
// AUTHORED INK, NOT SKY GEOMETRY, which is why this is not a star-trails arc: a
// trail's circle is fixed (centred on the spin pole, radius set by its star)
// and the lens's drawn disc is not, and a fixed sky direction is dragged across
// the frame by the fov ramp and by the story camera swinging off axis. So the
// crown is a circle segment in SCREEN space, straight to clip space, with no
// camera and no sphere in the graph.
//
// RESOLUTION-FREE: every length is in FRAME HEIGHTS from the frame's centre
// (+x right, +y DOWN), and the shader asks the renderer only for `screenSize`,
// for the aspect. A perspective camera's vertical fov makes a fixed world point
// project proportional to canvas HEIGHT, so the fractions hold at any size/DPR.
//
// One strip of quads built once; the whole shape is six uniforms, so the driver
// (story/trails.ts) re-authors the arc each frame for six writes.

/** The crown's look and its two authored positions.
 *
 *  `trail` is a member of the trail family: the spin pole is on the view axis
 *  (starfield.ts SKY_SPIN_ELEV_RAD), so every trail projects to a circle
 *  centred on the FRAME — cx = cy = 0 is the geometry, not a placement.
 *
 *  `lens` is where the lens will be, read off the live scene with
 *  `SceneHandle.projectDrawn("Element_01")` at the beat story/trails.ts's
 *  `crownLiveAt` takes over and tracks the real disc. The arc parks here only
 *  for the blind stretch before that, where the element is behind the camera or
 *  fully faded glass and there is nothing to ask. */
export const CROWN_LOOK = {
  /** the arc while it is still one of the trails — frame heights from centre,
   *  and the centre is where every trail's is */
  trail: { cx: 0, cy: 0, r: 0.2 },
  /** …and where it waits for the lens */
  lens: { cx: 0, cy: 0, r: 0.0406 },
  /** the arc's HALF-width, frame heights, feathered from `core` outward. Gauged
   *  against the FIELD: the trails around it are 1–2 px arcs and the crown has
   *  to pass for one of them for a whole scene. */
  half: 0.003,
  /** how much of the circle the crown inks at the reveal, radians. Wide enough
   *  to read as the top of a round thing, short enough not to close into a ring
   *  the element would have to fill. */
  span: 1.5,
  /** the head's screen angle at zero spin, radians (atan2 with +y DOWN) — the
   *  top of the circle. */
  phi0: -Math.PI / 2,
  /** rungs along the arc − 1. Sized on the LONGEST span the arc ever draws —
   *  its trail phase (star-trails.ts TRAIL_SWEEP_MAX) — so the chord sag of
   *  each rung stays subpixel. */
  segments: 48,
  /** fraction of the half-width at full ink before the edge feathers —
   *  optics/constellation-lines.ts's `core`, and star-trails' too. */
  core: 0.4,
  /** the CROWN end of the along-arc ink: an even stroke feathered over this
   *  fraction at BOTH ends, because a lens edge has no head and no tail. The
   *  TRAIL end is a flat 1 and needs no knob — a star trail carries its star's
   *  ink from head to tail, and anything else would give the crown away. */
  endFeather: 0.16,
  /** a multiplier on SKY_INK's `starOpacity`. 1 = the ink a trail is drawn at,
   *  which is what lets it hide in the field; it becomes the arc you follow
   *  by outliving the field, not by being brighter. */
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
   *  space, so it wants no parent transform and must outlive the starfield */
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

/** Build the crown. Cheap and synchronous: one strip of quads and one material,
 *  no textures and no GPU work at construction. */
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
  // `position` holds the quad's PARAMETERS, not a place: (side, s, 0), side ±1
  // across the width, s running 0 at the head to 1 at the tail.
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
  // across the band: full ink through the core, feathered to nothing at edge
  const across: TslNode = float(1).sub(
    smoothstep(float(CROWN_LOOK.core), float(1), abs(vSide)),
  );
  // along it: a trail's flat ink, or an edge's stroke feathered at both ends
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
  // last of the transparent pass: this mark goes over the sky AND the model
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
