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
import type { TslNode } from "../ops/algebra-tsl";
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

// ============================================================================
// STAR TRAILS — the long-exposure look. While the sky turns (optics/starfield's
// `uSkySpin`, driven by story/trails.ts), EVERY star in the catalog drags an arc
// of ink behind it, back to where it stood when the rotation began.
//
// EVERY STAR, AND AT ITS OWN BRIGHTNESS. Owner: "let's have all stars create
// trails that have the same opacity or brightness as their corresponding star."
// So there is no selection and no along-arc decay: an arc's ink is its star's
// ink, held constant from head to tail, and its width is its star's disc radius
// times `widthK`. The hierarchy in the frame is the CATALOG's — an arc is faint
// because its star is (optics/sky.ts BRIGHTNESS_LAW, whose exponential falloff
// is what keeps a sky of 180° arcs from reading as a rope-field) — and the only
// thing that fades the field as a whole is the scene envelope.
//
// TRUE CIRCLES. The pole is on the view axis (optics/starfield.ts
// SKY_SPIN_ELEV_RAD), so every arc is a cone about the camera's own axis and
// projects to a circle concentric with the frame's centre, at any fov.
//
// ONE DRAW CALL, AND NOTHING MOVES ON THE CPU. The geometry is a fixed strip of
// quads per star, built once; each VERTEX carries its star's direction and its
// own position `s` along the trail (0 at the head, 1 at the tail), and the
// vertex graph rotates that direction BACKWARD by `s × uTrailSweep` about the
// same pole the starfield spins about. So the arcs grow and turn purely as a
// function of two uniforms — the CPU writes a sweep and an envelope and never
// touches a buffer again.
//
// HEADS ARE GLUED TO DISCS BY CONSTRUCTION. At s = 0 the backward rotation is
// zero, so the head sits at `rodrigues(aDir, axis, uSkySpin)` — exactly where
// optics/starfield.ts draws the star itself. The one thing that could separate
// them is the driver feeding the two uniforms different numbers, which is why
// story/trails.ts derives both from a single θ.
//
// FLAT-LAW COMPLIANT (only the lens model reads 3D): an arc is a band of flat
// ink with a feathered edge, extruded in VIEW space perpendicular to the local
// arc tangent, so it holds one screen width along its whole length and at any
// fov — optics/constellation-lines.ts's idiom, and its material contract too
// (transparent, no depth write, no depth test: sky ink drawn over everything,
// with an envelope that is 0 wherever there is anything in front of it).
//
// WHY THE TANGENT IS `cross(axis, dir)`. A point rotating about a unit axis has
// velocity `axis × p` — the exact derivative of the arc at that vertex, for the
// price of one cross product. Extruding across THAT rather than across the
// chord to the next rung is what keeps the band even where the arc curves most.
// ============================================================================

/** THE SWEEP, radians: how far the sky has turned by the time the trails scene
 *  is done. HALF A REVOLUTION (owner: "around a 180deg revolution before moving
 *  to the next scene") — the exposure is hours, not minutes, and every arc is a
 *  semicircle about the pole. story/trails.ts owns the law that ramps up to it,
 *  and the scene's `hold` is sized so that ramp reads as a turn rather than a
 *  spin: a π sweep crammed into the old 1.2 screenfuls was a smear. */
export const TRAIL_SWEEP_MAX = Math.PI;

/** How much of the rotation history the tail spans. 1 = all of it: the tail end
 *  of every arc sits at the star's UNROTATED direction, so the trail is a
 *  faithful record of the whole turn and the field un-draws itself exactly as
 *  the sweep scrubs back to 0. Under 1 would clip the oldest part of the arc. */
export const TRAIL_TAIL_FRACTION = 1;

/** Look knobs — the owner's to tune in one pass (Task 3 of the phase plan). */
export const TRAIL_LOOK = {
  /** the sphere the arcs are drawn on: just inside the starfield's, so the
   *  transparent pass sorts them behind the sky ink and in front of nothing.
   *  Nothing optical depends on it (this material neither tests nor writes
   *  depth) — it is one number so the radii cannot drift apart. */
  radius: STARFIELD_LOOK.radius * 0.995,
  /** rungs per arc − 1. TIED TO THE SWEEP, not to a taste: an arc is drawn as
   *  chords, so what has to stay small is the ANGLE PER SEGMENT. 80 over the π
   *  sweep is 0.039 rad a rung, and a chord's sag off its circle is
   *  R·(1 − cos(θ/2)) = 1.9e-4·R — a fifth of a pixel on an arc whose SCREEN
   *  radius is a thousand pixels, which is already outside a 820 px frame.
   *  Raise the sweep, raise this with it.
   *
   *  IT IS ALSO THE COST KNOB. Every star in the catalog gets an arc, so the
   *  draw is `stars × (segments + 1) × 2` vertices — at 795 stars that is 129k
   *  in one indexed draw, ~40× the starfield's own 3.2k. Still cheap (no
   *  texture, no depth, one uniform-driven vertex graph, and arcs are a pixel or
   *  two wide so there is nearly no fill), but this is the number to cut first
   *  if a frame budget ever needs it. */
  segments: 80,
  /** the arc's angular HALF-width as a fraction of the star's own disc radius
   *  (optics/starfield.ts `starRho`) — under 1, so the disc stays the widest
   *  part of the mark and the trail reads as something the star LEFT. */
  widthK: 0.8,
  /** …with a floor, radians. The finale holds fov 70, so an ~800px-tall canvas
   *  runs ~655 px/rad and this is a ~0.9 px half-width: the faint end of the
   *  catalog asks for arcs thinner than that, and a line under a pixel does not
   *  get dimmer as it narrows — it crawls and flickers along its own length.
   *  Arcs held at the floor pay for the extra width in INK instead (see
   *  `buildTrailArcs`), which is the same light spread honestly. */
  minHalfRad: 0.0014,
  /** the fraction of the half-width at full ink before the edge feathers —
   *  optics/constellation-lines.ts's `core`. */
  core: 0.4,
};

// THE CROWN IS NOT HERE ANY MORE. It used to be one last arc appended to this
// soup — a physics-true circumpolar trail asked to register with the front
// element's top edge at the reveal, which it structurally could not: the camera
// reverses back through the lens over the reveal and drags any fixed sky
// direction clear across the frame. It is now an AUTHORED SCREEN-SPACE arc with
// its own mesh and its own placement — optics/crown-arc.ts, driven alongside
// these by story/trails.ts. This file draws the sky's own record and nothing
// else.

/**
 * THE ARC LAW, on the CPU — the exact expression the vertex graph evaluates, so
 * a test can hold it: the direction of the trail's `s` point when the sky has
 * turned by `spin` and the trail spans `sweep` radians of history.
 *
 * At s = 0 this is the star's CURRENT direction (the head is the disc); at s = 1
 * and sweep = spin it is the star's ORIGINAL direction (the tail is where the
 * turn started).
 */
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
  /** per-arc ink multiplier, 0..1 — THE STAR'S OWN, held along the whole arc */
  ink: number;
  /** the star's temperature tint (optics/sky.ts `Star.tint`) */
  tint: readonly [number, number, number];
}

/**
 * The arcs the geometry is built over: exactly one per star in the catalog, in
 * catalog order.
 *
 * THE INK IS THE STAR'S. `Star.ink` (optics/sky.ts `inkOf`) times the width
 * floor's compensation — the same two factors optics/starfield.ts folds into a
 * disc's `aInk`, so an arc is drawn at the brightness of the star it came off.
 *
 * THE WIDTH FLOOR IS PAID FOR IN INK. A star whose honest half-width falls under
 * `minHalfRad` is drawn at the floor and dimmed by exactly the ratio, so a faint
 * star's trail carries the light it should instead of gaining a third of a stop
 * for being too thin to draw.
 */
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
  /** attach this (via SceneHandle.starfieldAttach) — it carries no transform of
   *  its own and rides the starfield group's per-frame camera-centring */
  object: THREE.Object3D;
  /** how many radians of rotation history the tails span. story/trails.ts hands
   *  this the SAME θ it writes to `uSkySpin`, which is what glues the heads to
   *  the discs. */
  setSweep(rad: number): void;
  /** the scene envelope, 0..1 — a straight multiplier on every arc's alpha */
  setEnvelope(o: number): void;
  /** re-palette in place: two uniform writes, no rebuild */
  setTheme(light: boolean): void;
  dispose(): void;
}

/**
 * Build the trail engine. Cheap and synchronous — one BufferGeometry and one
 * material over the authored catalog; no textures, no render target, no GPU work
 * at construction.
 */
export function createStarTrails(opts: { light: boolean }): StarTrails {
  let light = opts.light;
  const palette = (): SkyPalette => (light ? SKY_INK.light : SKY_INK.dark);

  const uTrailSweep = uniform(0);
  const uEnvelope = uniform(0);
  const uInk = uniform(new THREE.Color(palette().star));
  // THE FIELD'S OWN OPACITY IS THE STARS' — no gain, up or down. An arc is drawn
  // at its star's brightness (owner), so the only per-arc dimming is `aInk` and
  // the only field-wide one is the scene envelope.
  const uInkOpacity = uniform(palette().starOpacity);

  // ── the strip soup ─────────────────────────────────────────────────────────
  // Per arc: SEG + 1 rungs of two vertices each, indexed as SEG quads. As in the
  // starfield, `position` holds the quad's PARAMETERS — (side, s, 0) — and not a
  // place; where the vertex actually lands is solved from `aDir` and the two
  // spin uniforms every frame.
  const arcs = buildTrailArcs(SKY.stars);
  const SEG = TRAIL_LOOK.segments;
  const RUNGS = SEG + 1;
  const vPerArc = RUNGS * 2;
  const n = arcs.length;
  const position = new Float32Array(n * vPerArc * 3);
  const aDir = new Float32Array(n * vPerArc * 3);
  const aHalf = new Float32Array(n * vPerArc);
  const aInk = new Float32Array(n * vPerArc);
  const aTint = new Float32Array(n * vPerArc * 3);
  const index = new Uint32Array(n * SEG * 6);
  for (let a = 0; a < n; a++) {
    const arc = arcs[a];
    for (let r = 0; r < RUNGS; r++) {
      const s = r / SEG;
      for (let k = 0; k < 2; k++) {
        const v = a * vPerArc + r * 2 + k;
        position[v * 3] = k === 0 ? -1 : 1; // side, ±1 across the width
        position[v * 3 + 1] = s; // 0 at the head, 1 at the tail
        position[v * 3 + 2] = 0;
        aDir[v * 3] = arc.dir[0];
        aDir[v * 3 + 1] = arc.dir[1];
        aDir[v * 3 + 2] = arc.dir[2];
        aTint[v * 3] = arc.tint[0];
        aTint[v * 3 + 1] = arc.tint[1];
        aTint[v * 3 + 2] = arc.tint[2];
        aHalf[v] = arc.half;
        aInk[v] = arc.ink;
      }
    }
    for (let q = 0; q < SEG; q++) {
      const b = a * vPerArc + q * 2;
      const t = (a * SEG + q) * 6;
      index[t] = b;
      index[t + 1] = b + 1;
      index[t + 2] = b + 2;
      index[t + 3] = b + 1;
      index[t + 4] = b + 3;
      index[t + 5] = b + 2;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("aDir", new THREE.BufferAttribute(aDir, 3));
  geo.setAttribute("aHalf", new THREE.BufferAttribute(aHalf, 1));
  geo.setAttribute("aInk", new THREE.BufferAttribute(aInk, 1));
  geo.setAttribute("aTint", new THREE.BufferAttribute(aTint, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

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
  // the arc's own tangent at THIS rung (axis × p, the rotation's velocity),
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
  // across the band: full ink through the core, feathered to nothing at the edge
  const across: TslNode = float(1).sub(
    smoothstep(float(TRAIL_LOOK.core), float(1), abs(vSide)),
  );

  // the theme's ink at this star's temperature — the same product the disc is
  // drawn with (optics/starfield.ts `starMark`), so a trail is its star's colour
  mat.colorNode = uInk.mul(vTint);
  // NOTHING ALONG THE ARC. There is no `s` term here on purpose: the ink an arc
  // is drawn at is its star's, from head to tail (see the header).
  mat.opacityNode = across.mul(vInk).mul(uEnvelope).mul(uInkOpacity);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_StarTrails";
  // `position` holds quad parameters, so three's bounding sphere is a unit ball
  // at the origin and means nothing — the real extent is the whole sphere.
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
      uInk.value.setHex(pal.star);
      uInkOpacity.value = pal.starOpacity;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
