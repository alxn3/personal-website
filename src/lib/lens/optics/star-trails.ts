import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  cross,
  float,
  modelViewMatrix,
  positionGeometry,
  pow,
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
// `uSkySpin`, driven by story/trails.ts), every bright star drags an arc of ink
// behind it, brightest at the disc and fading away toward where the star was
// when the rotation began.
//
// ONE DRAW CALL, AND NOTHING MOVES ON THE CPU. The geometry is a fixed strip of
// quads per star, built once; each VERTEX carries its star's direction and its
// own position `s` along the trail (0 at the head, 1 at the tail), and the
// vertex graph rotates that direction BACKWARD by `s × uTrailSweep` about the
// same pole the starfield spins about. So the arcs grow, curve and fade purely
// as a function of two uniforms — the CPU writes a sweep and an envelope and
// never touches a buffer again.
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
 *  is done. Small on purpose — this is a long exposure of a few minutes, not a
 *  star-trail circle of a whole night, and it has to read as a turn rather than
 *  as a smear. story/trails.ts owns the law that ramps up to it. */
export const TRAIL_SWEEP_MAX = 0.55;

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
  /** how many stars get a trail. ~90 arcs of 14 segments is ~2700 vertices in
   *  one indexed draw — the same order as the starfield itself. */
  count: 90,
  /** the half-angle about the view axis (world +X, the held fly pose's heading)
   *  a star must be inside to be worth an arc, radians. 1.05 ≈ 60°, which is a
   *  shade past the frame's corner at fov 70 on a 16:10 canvas: everything that
   *  can be seen, and nothing that can only be seen from behind. */
  coneRad: 1.05,
  /** rungs per arc − 1. At the shipped sweep the chord error of 14 segments is
   *  a fraction of a pixel even on the arc furthest from the pole. */
  segments: 14,
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
  /** a multiplier on SKY_INK's `starOpacity` for the whole field of arcs. Well
   *  under 1: a trail is the faint record of a star, never a competitor to it. */
  inkGain: 0.55,
  /** the along-arc fade's exponent: alpha ∝ (1 − s)^this. Above 1 so the ink
   *  concentrates near the head and the tail dies away rather than ending. */
  fadePow: 1.5,
};

// THE CROWN IS NOT HERE ANY MORE. It used to be one last arc appended to this
// soup, anchored near the spin pole so its circle would be tight — a physics-
// true trail asked to register with the front element's top edge at the reveal,
// which it structurally could not (the pole is ~290 px below frame centre; the
// element's crown lands on it). It is now an AUTHORED SCREEN-SPACE arc with its
// own mesh and its own placement — optics/crown-arc.ts, driven alongside these
// by story/trails.ts. This file draws the sky's own record and nothing else.

/**
 * WHICH STARS GET A TRAIL: the brightest inside the visible cone, ties broken by
 * catalog index so the answer is a function of the catalog alone — no rng, no
 * build-order luck. Both populations are eligible (optics/sky.ts appends ~220
 * generated background stars after the 82 authored ones); a long exposure is a
 * FIELD of arcs, and cutting it to the authored table would leave four
 * constellations' worth of lines on empty sky.
 */
export function pickTrailStars(
  stars: readonly Star[],
  look = TRAIL_LOOK,
): number[] {
  const cosCone = Math.cos(look.coneRad);
  return stars
    .map((_, i) => i)
    .filter((i) => dirOf(stars[i].az, stars[i].alt)[0] >= cosCone) // dot with +X
    .sort((a, b) => stars[b].mag - stars[a].mag || a - b)
    .slice(0, look.count);
}

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
  /** per-arc ink multiplier, 0..1 */
  ink: number;
}

/**
 * The arcs the geometry is built over: exactly one per picked star.
 *
 * THE WIDTH FLOOR IS PAID FOR IN INK. A star whose honest half-width falls under
 * `minHalfRad` is drawn at the floor and dimmed by exactly the ratio, so a faint
 * star's trail carries the light it should instead of gaining a third of a stop
 * for being too thin to draw.
 */
export function buildTrailArcs(
  stars: readonly Star[],
  picks: readonly number[],
  look = TRAIL_LOOK,
): TrailArc[] {
  return picks.map((i) => {
    const s = stars[i];
    const wanted = look.widthK * starRho(s.mag);
    const half = Math.max(look.minHalfRad, wanted);
    return {
      dir: dirOf(s.az, s.alt),
      half,
      ink: Math.min(1, wanted / half),
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
  const uInkOpacity = uniform(palette().starOpacity * TRAIL_LOOK.inkGain);

  // ── the strip soup ─────────────────────────────────────────────────────────
  // Per arc: SEG + 1 rungs of two vertices each, indexed as SEG quads. As in the
  // starfield, `position` holds the quad's PARAMETERS — (side, s, 0) — and not a
  // place; where the vertex actually lands is solved from `aDir` and the two
  // spin uniforms every frame.
  const arcs = buildTrailArcs(SKY.stars, pickTrailStars(SKY.stars));
  const SEG = TRAIL_LOOK.segments;
  const RUNGS = SEG + 1;
  const vPerArc = RUNGS * 2;
  const n = arcs.length;
  const position = new Float32Array(n * vPerArc * 3);
  const aDir = new Float32Array(n * vPerArc * 3);
  const aHalf = new Float32Array(n * vPerArc);
  const aInk = new Float32Array(n * vPerArc);
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
  const vS: TslNode = varying(s);
  const vInk: TslNode = varying(nInk);
  // across the band: full ink through the core, feathered to nothing at the edge
  const across: TslNode = float(1).sub(
    smoothstep(float(TRAIL_LOOK.core), float(1), abs(vSide)),
  );
  // and along it: bright at the disc, gone at the far end of the turn
  const tail: TslNode = pow(float(1).sub(vS), float(TRAIL_LOOK.fadePow));

  mat.colorNode = uInk;
  mat.opacityNode = across.mul(tail).mul(vInk).mul(uEnvelope).mul(uInkOpacity);

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
      uInkOpacity.value = pal.starOpacity * TRAIL_LOOK.inkGain;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
