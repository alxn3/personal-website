// THE BLOOM'S PETALS — the rose ending's ambient: cut-paper petals drifting
// down the frame while the flower holds open. They REPLACE the ambient dust
// (story/cinematics.ts) for the length of the bloom — the motes go out at the
// span's edge and come back with it, the way the dive hands the dust off.
//
// LAZY MODULE, like story/fly.ts and story/trails.ts: reached ONLY through
// hero-driver's dynamic import(), never re-exported from index.ts.
//
// THE 2D LAW: a petal is a VIEW-SPACE billboard — its centre, its fall, its
// sway and its turn are authored in the camera's own frame, so the field is a
// flat vector layer over the stage at any camera pose and gravity is always
// screen-down. Only its DEPTH says it is in a 3D scene at all, and that is
// there for one reason: so petals pass BEHIND the flower as well as in front.
//
// NOTHING PER FRAME BUT TWO UNIFORMS. The field is ONE instanced draw of a
// four-vertex template; every petal's fall, sway, spin and flutter is solved in
// the vertex stage from its own attributes and one accumulated time. Time
// accrues only INSIDE the span (dt clamped to 100 ms, story/trails.ts's law, so
// a hero that stopped rendering off-viewport does not teleport the field), and
// the envelope is exactly 0 below the bloom's foot — outside it nothing is
// drawn and nothing is computed.

import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  cos,
  float,
  fract,
  mix,
  positionGeometry,
  sin,
  smoothstep as smoothstepTsl,
  uniform,
  varying,
  vec4,
} from "three/tsl";
import type { TslNode } from "../ops/tsl-types";
import type { SceneHandle } from "../core/scene";
import { lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { rangeOf, windowEdges } from "./story";
import { ROSE_PULSE } from "./envelopes";

const TAU = Math.PI * 2;

// --- the window --------------------------------------------------------------

const [ROSE_P0, ROSE_P1] = windowEdges(ROSE_PULSE.rise);

/** Where the field is fully in: over the first half of the bloom, so the petals
 *  arrive WITH the flower rather than after it. */
export const PETAL_RISE = ROSE_P0 + 0.5 * (ROSE_P1 - ROSE_P0);

/** The field's envelope — a straight multiplier on every petal's alpha. Exactly
 *  0 at and below the bloom's foot, and it never falls: the story ends inside
 *  the bloom and the reader parks there. */
export const petalEnvAt = (p: number): number =>
  smoothstep(ROSE_P0, PETAL_RISE, p);

/** Slack below the envelope's foot before the field is mounted, so a scrub
 *  parked on the edge cannot thrash attach/detach. Exported (with the span) so
 *  story/cost.ts reads the window rather than re-spelling it. */
const SPAN_PAD = 0.01;
export const SPAN_P0 = ROSE_P0 - SPAN_PAD;
/** …and the top: the track's end. The bloom is the last thing the story does. */
export const SPAN_P1 = 1;

// --- the look ----------------------------------------------------------------

/** All lengths are in units of the petal's own DEPTH, which makes them
 *  fractions of the frame: at fov f a view-space unit at depth d spans
 *  `d · tan(f/2)` vertically, so a length written as `k · d` is a constant
 *  share of the frame at every depth and every distance — but NOT at every
 *  viewport, since core/scene divides the frame's half-height by `camera.zoom`.
 *  Anything that has to clear the TOP EDGE is therefore written in frame
 *  half-heights instead (`top`, live through `uFrameHalf`). */
/** The ending's park distance, read off the capsOn row so the surface line
 *  below stays on the lens' base if the row's distance is retuned. */
const ENDING_DIST = Math.hypot(...rangeOf("capsOn").scene.cam.pos);

/** The lens base's drop below the frame's centre, as an angle times the park
 *  distance — the one measured number the surface line derives from. */
const BASE_DROP = 0.191;

export const PETAL_LOOK = {
  /** dozens, not thousands (the render hot-path law) */
  count: 64,
  /** the depths the field is spread over, world units in front of the camera —
   *  straddling the standing lens (the ending's camera park, `ENDING_DIST`) so
   *  petals pass both sides of the flower */
  depth: [1.7, 3.4] as [number, number],
  /** half the spawn band's width. The frame's half-WIDTH is `aspect/zoom`
   *  half-heights, which is 1 on every portrait viewport and the aspect on a
   *  landscape one, so 0.78 covers the frame out to aspect 2.9 at the ending's
   *  fov 30 (half-height 0.268) and no viewport shows the band's edge. */
  spanX: 0.78,
  /** where a petal's own fall STARTS, in units of THE FRAME'S OWN half-height
   *  (`SceneHandle.frameHalf`, live): past the top edge at every viewport
   *  shape, so a petal is on screen only once it is lit. A fixed depth
   *  fraction would not — core/scene's zoom law makes the frame
   *  `tan(fov/2)/zoom` tall, which is more than twice as much on a phone. */
  top: [1.35, 2.1] as [number, number],
  /** THE SURFACE LINE — where every fall ENDS, whatever height it started at.
   *  It sits at the standing lens' base in the bloom's own frame, so the
   *  petals coming to rest along one level is what makes the rose read as
   *  resting on something. Derived, not tuned: `BASE_DROP` over the park
   *  distance keeps the line on the base if the capsOn row moves. */
  ground: -BASE_DROP / ENDING_DIST,
  /** the height above that line a petal THINS over on the way down — keyed on
   *  the HEIGHT, not the petal's own clock, so the whole field reaches its
   *  rest weight on the same level */
  settle: 0.14,
  /** THE REST — the landing that makes the surface real. Each petal spends the
   *  `at`→`out` span of its own cycle LYING on the line before it dissolves
   *  and wraps: `alpha` is the weight it rests at (a floor under the descent
   *  fade, never 0 until `out`), `squash` is the lying quad's height, and
   *  `flatten` is the u-span it tips flat over as it touches. */
  rest: {
    at: 0.72,
    out: 0.94,
    alpha: 0.55,
    squash: 0.32,
    flatten: 0.05,
  },
  /** the quad's half-size — constant on SCREEN at every depth, which is what
   *  keeps the field reading as layers of flat paper rather than a perspective
   *  cloud */
  size: [0.0075, 0.0135] as [number, number],
  /** seconds to fall the whole band. Ambient: a petal crosses the frame in
   *  about the time a reader spends reading the caption. */
  fallSeconds: [16, 28] as [number, number],
  /** the drift across the fall — amplitude in frame units, rate in rad/s */
  sway: {
    amp: [0.012, 0.045] as [number, number],
    rate: [0.1, 0.3] as [number, number],
  },
  /** the turn IN THE SCREEN PLANE, rad/s. Flat: a petal rotates, it never
   *  tumbles through a third axis. */
  spin: [0.05, 0.2] as [number, number],
  /** the paper turning edge-on — the quad's WIDTH breathes to this floor, the
   *  flat-drawing idiom for a falling leaf */
  flutter: { rate: [0.15, 0.45] as [number, number], floor: 0.45 },
  /** per-petal alpha, so the field has depth without shading */
  alpha: [0.5, 1] as [number, number],
};

/** THE SILHOUETTE, in the quad's own ±1 coordinates: a petal pointed at the tip
 *  and at the base, `belly` fuller below the middle than above it. ONE flat
 *  tone, no gradient and no fold line — a paper cut-out, not a shaded petal. */
const SHAPE = { width: 0.72, belly: 0.18, feather: 0.09 };

/** Two tints per stage, mixed per petal. Terracotta is the site's `--highlight`
 *  and the second is whatever the stage is NOT — cream on the dark stage, muted
 *  brown on paper. */
const PETAL_INK = {
  dark: { warm: 0xd99a63, cool: 0xf1ecde, opacity: 0.82 },
  light: { warm: 0xd18a5d, cool: 0xa89070, opacity: 0.74 },
};

// --- the field ---------------------------------------------------------------

/** Deterministic, never Math.random: the field is the same on every machine and
 *  every reload (optics/sky.ts's law). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface PetalAttributes {
  /** (column, phase, fall rate, depth) */
  aFall: Float32Array;
  /** (sway amplitude, sway rate, spin rate, flutter rate) */
  aTurn: Float32Array;
  /** (half-size, alpha, tint mix, own start height) */
  aLook: Float32Array;
}

/** The per-petal constants, one draw's worth. Pure and exported so a test can
 *  hold the ranges and the determinism. */
export function buildPetalField(look = PETAL_LOOK): PetalAttributes {
  const rnd = lcg(20260823);
  const pick = (r: readonly [number, number]) => lerp(r[0], r[1], rnd());
  const n = look.count;
  const aFall = new Float32Array(n * 4);
  const aTurn = new Float32Array(n * 4);
  const aLook = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    aFall[i * 4] = rnd() * 2 - 1; // column, ±1 across the band
    aFall[i * 4 + 1] = rnd(); // phase: where in its own fall it starts
    aFall[i * 4 + 2] = 1 / pick(look.fallSeconds); // bands per second
    aFall[i * 4 + 3] = pick(look.depth);
    aTurn[i * 4] = pick(look.sway.amp);
    aTurn[i * 4 + 1] = pick(look.sway.rate);
    aTurn[i * 4 + 2] = pick(look.spin) * (rnd() < 0.5 ? -1 : 1);
    aTurn[i * 4 + 3] = pick(look.flutter.rate);
    aLook[i * 4] = pick(look.size);
    aLook[i * 4 + 1] = pick(look.alpha);
    aLook[i * 4 + 2] = rnd();
    aLook[i * 4 + 3] = pick(look.top);
  }
  return { aFall, aTurn, aLook };
}

export interface PetalField {
  mesh: THREE.Mesh;
  uTime: { value: number };
  uEnv: { value: number };
  /** the live frame half-height per unit depth — the ruler `top` is written in */
  uFrameHalf: { value: number };
  uWarm: { value: THREE.Color };
  uCool: { value: THREE.Color };
  uOpacity: { value: number };
}

/** Build the one draw. Cheap and synchronous — a four-vertex template, three
 *  instanced attributes and one material; no texture, no GPU work until the
 *  first draw. */
export function buildPetalObject(light: boolean): PetalField {
  const { aFall, aTurn, aLook } = buildPetalField();
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = PETAL_LOOK.count;
  // `position` holds the quad's ±1 CORNER, not a place: the landing point is
  // solved from the instance's own attributes below (optics/star-trails.ts's
  // template idiom).
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
      3,
    ),
  );
  geo.setIndex(
    new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1),
  );
  geo.setAttribute("aFall", new THREE.InstancedBufferAttribute(aFall, 4));
  geo.setAttribute("aTurn", new THREE.InstancedBufferAttribute(aTurn, 4));
  geo.setAttribute("aLook", new THREE.InstancedBufferAttribute(aLook, 4));
  // stated, not computed: the template is a unit quad and the petals are placed
  // in view space, so a measured sphere would describe nothing
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(),
    PETAL_LOOK.depth[1],
  );

  const pal = light ? PETAL_INK.light : PETAL_INK.dark;
  const uTime = uniform(0);
  const uEnv = uniform(0);
  // the landscape frame at the ending's fov, until the driver writes the live one
  const uFrameHalf = uniform(Math.tan((30 * Math.PI) / 360));
  const uWarm = uniform(new THREE.Color(pal.warm));
  const uCool = uniform(new THREE.Color(pal.cool));
  const uOpacity = uniform(pal.opacity);

  const fall: TslNode = attribute("aFall", "vec4");
  const turn: TslNode = attribute("aTurn", "vec4");
  const look: TslNode = attribute("aLook", "vec4");
  const depth: TslNode = fall.w;
  const phase: TslNode = fall.y.mul(TAU);

  // THE FALL: one wrapped ramp, 0 at the petal's own top, on the surface from
  // `rest.at` until the wrap. `fract` is what makes the field endless without
  // a single CPU respawn.
  const u: TslNode = fract(fall.y.add(uTime.mul(fall.z)));
  const R = PETAL_LOOK.rest;
  // THE LANDING CLOCK: past `rest.at` every animated term runs on the moment
  // this petal touched down — exact and stateless, since the overshoot in u
  // over the fall rate IS the time since touchdown.
  const tEff: TslNode = uTime.sub(
    clamp(u.sub(R.at), float(0), float(1)).div(fall.z),
  );
  // EVERY FALL ENDS ON THE SAME LINE, from its own start height, and SETTLES
  // onto it: the ease-out is what turns a fall into a landing.
  const uf: TslNode = clamp(u.div(R.at), float(0), float(1));
  const drop: TslNode = uf.mul(float(2).sub(uf));
  const sway: TslNode = sin(tEff.mul(turn.y).add(phase)).mul(turn.x);
  const cx: TslNode = fall.x.mul(PETAL_LOOK.spanX).add(sway).mul(depth);
  const y: TslNode = mix(
    look.w.mul(uFrameHalf),
    float(PETAL_LOOK.ground),
    drop,
  );
  const cy: TslNode = y.mul(depth);

  // the corner, turned in the SCREEN plane and squashed across its width as the
  // paper turns edge-on
  const half: TslNode = look.x.mul(depth);
  const edgeOn: TslNode = cos(tEff.mul(turn.w).add(phase)).mul(0.5).add(0.5);
  const flutter: TslNode = mix(
    float(PETAL_LOOK.flutter.floor),
    float(1),
    edgeOn,
  );
  const ang: TslNode = phase.add(tEff.mul(turn.z));
  const ca: TslNode = cos(ang);
  const sa: TslNode = sin(ang);
  const px: TslNode = positionGeometry.x.mul(half).mul(flutter);
  const py: TslNode = positionGeometry.y.mul(half);

  // THE TOUCHDOWN: over `rest.flatten` of u the turned quad tips into the
  // lying pose — full width, height squashed — and holds it for the rest.
  const g: TslNode = smoothstepTsl(float(R.at), float(R.at + R.flatten), u);
  const ox: TslNode = mix(
    px.mul(ca).sub(py.mul(sa)),
    positionGeometry.x.mul(half),
    g,
  );
  const oy: TslNode = mix(
    px.mul(sa).add(py.mul(ca)),
    positionGeometry.y.mul(half).mul(R.squash),
    g,
  );

  const mat = new THREE.MeshBasicNodeMaterial();
  // NO modelViewMatrix: the petal IS its view-space place, which is why the
  // object's own transform is irrelevant and the fall is always screen-down.
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(cx.add(ox), cy.add(oy), depth.negate(), 1),
  );

  // THE FADE IS THE FALL'S: a petal lights as it leaves its top (off screen,
  // which hides the ramp's seam) and thins over the way down — keyed on the
  // HEIGHT, so the whole field is at the same weight at the same level — but
  // only to the REST floor: what is left is the petal lying on the line, and
  // the tail of its own cycle dissolves it there so the field turns over
  // without a pop.
  const hFade: TslNode = smoothstepTsl(
    float(PETAL_LOOK.ground),
    float(PETAL_LOOK.ground + PETAL_LOOK.settle),
    y,
  )
    .mul(1 - R.alpha)
    .add(R.alpha);
  const wrapOut: TslNode = float(1).sub(
    smoothstepTsl(float(R.out), float(1), u),
  );
  const edge: TslNode = smoothstepTsl(float(0), float(0.05), u)
    .mul(hFade)
    .mul(wrapOut);
  const vInk: TslNode = varying(edge.mul(look.y));
  const vTint: TslNode = varying(look.z);
  const vX: TslNode = varying(positionGeometry.x);
  const vY: TslNode = varying(positionGeometry.y);

  // THE SILHOUETTE: half-width closes to a point at the tip and at the base,
  // fuller below the middle — one flat petal cut out of paper.
  const hw: TslNode = float(1)
    .sub(vY.mul(vY))
    .mul(float(1).sub(vY.mul(SHAPE.belly)))
    .mul(SHAPE.width);
  const inside: TslNode = clamp(
    hw.sub(abs(vX)).div(SHAPE.feather),
    float(0),
    float(1),
  );

  mat.colorNode = mix(uWarm, uCool, vTint);
  mat.opacityNode = inside.mul(vInk).mul(uEnv).mul(uOpacity);
  mat.transparent = true;
  // DEPTH IS THE POINT (story/peelcards.ts's card field, for its reason): a
  // petal behind the flower must be hidden by it, and alphaTest keeps the
  // faded-out ones and the quad's empty corners out of the depth buffer.
  mat.depthWrite = true;
  mat.alphaTest = 0.02;
  mat.side = THREE.DoubleSide;
  // flat ink, not a lit surface (the 2D/3D design law)
  mat.toneMapped = false;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_Petals";
  // placed in view space: three's frustum test would ask about the origin
  mesh.frustumCulled = false;
  mesh.raycast = () => {};

  return { mesh, uTime, uEnv, uFrameHalf, uWarm, uCool, uOpacity };
}

// --- the module --------------------------------------------------------------

/** dt clamp, ms — story/internals.ts's number, for its reason */
const DT_CLAMP_MS = 100;

export interface StoryPetals {
  /** Upload the field's buffers off the gesture. Idempotent. */
  warm(): void;
}

/**
 * Start the petals. Registers a scene.onFrame callback for the life of the page
 * — no teardown, because the hero's scene is never disposed.
 */
export function createStoryPetals(scene: SceneHandle): StoryPetals {
  const field = buildPetalObject(isLightTheme());
  let shown = false;
  /** the field's own clock, seconds — accrues only inside the span */
  let t = 0;
  let last = performance.now();
  /** whether THIS module is the one holding the ambient dust down */
  let dustHeld = false;

  watchTheme((l) => {
    const pal = l ? PETAL_INK.light : PETAL_INK.dark;
    field.uWarm.value.setHex(pal.warm);
    field.uCool.value.setHex(pal.cool);
    field.uOpacity.value = pal.opacity;
    scene.invalidate();
  });

  scene.onFrame(() => {
    const now = performance.now();
    const dt = Math.min(DT_CLAMP_MS, now - last) / 1000;
    last = now;

    // THE SCROLL p, NOT THE EASED CHANNEL — story/trails.ts's law: one clock.
    const p = scene.state.storyTarget;
    // ZERO FIRST, ALWAYS: a flick can take p from inside the bloom to outside
    // it between two frames, and without an unconditional write the last
    // envelope would hold — freezing a field of petals on the stage.
    field.uEnv.value = petalEnvAt(p);

    if (p < SPAN_P0) {
      if (shown) {
        scene.removeOverlay(field.mesh);
        shown = false;
      }
      if (dustHeld) {
        scene.setDust(true);
        dustHeld = false;
      }
      return; // outside the bloom: nothing drawn, no time accrued
    }

    if (!dustHeld) {
      // the petals REPLACE the motes for the ending (story/cinematics.ts)
      scene.setDust(false);
      dustHeld = true;
    }
    if (!shown) {
      scene.addOverlay(field.mesh);
      shown = true;
    }
    t += dt;
    field.uTime.value = t;
    // the frame the fall is written against, live: a resize or a fov change
    // moves the top edge the petals have to start above
    field.uFrameHalf.value = scene.frameHalf();
  });

  return {
    warm() {
      if (!field.mesh.parent) scene.warmDraw([field.mesh]);
    },
  };
}
