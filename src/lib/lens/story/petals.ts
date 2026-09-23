// THE BLOOM'S PETALS — the rose ending's ambient: cut-paper petals drifting
// down the frame while the flower holds open. They REPLACE the ambient dust
// (story/cinematics.ts) for the length of the bloom; the driver's dust law
// (story/envelopes.ts dustAt) turns the motes off at this span's foot.
//
// LAZY MODULE, like story/fly.ts and story/trails.ts: reached ONLY through
// hero-driver's dynamic import(), never re-exported from index.ts.
//
// THE 2D LAW: a petal is a VIEW-SPACE billboard — centre, fall, sway and turn
// are authored in the camera's own frame, so gravity is always screen-down.
// Only its DEPTH is 3D, so petals pass behind the flower as well as in front.
//
// NOTHING PER FRAME BUT TWO UNIFORMS. The field is ONE instanced draw of a
// four-vertex template; every petal's fall, sway, spin and flutter is solved in
// the vertex stage. Time accrues only INSIDE the span, off the tick's dt, and
// the envelope is exactly 0 below the bloom's foot.

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
import { STORY_R, rangeOf, windowEdges } from "./story";
import { PETALS_P0, ROSE_PULSE } from "./envelopes";

const TAU = Math.PI * 2;

// --- the window --------------------------------------------------------------

const [ROSE_P0, ROSE_P1] = windowEdges(ROSE_PULSE.rise);

/** Where the field is fully in: over the first half of the bloom, so the petals
 *  arrive WITH the flower rather than after it. */
export const PETAL_RISE = ROSE_P0 + 0.5 * (ROSE_P1 - ROSE_P0);

/** The field's envelope — a straight multiplier on every petal's alpha, exactly
 *  0 at and below the bloom's foot, and it never falls. */
export const petalEnvAt = (p: number): number =>
  smoothstep(ROSE_P0, PETAL_RISE, p);

/** Where the field mounts: a pad below the envelope's foot, authored with the
 *  dust law in story/envelopes.ts, so a scrub parked on the edge cannot thrash
 *  attach/detach. */
export const SPAN_P0 = PETALS_P0;
/** …and the top: the track's end. The bloom is the last thing the story does. */
export const SPAN_P1 = 1;

// --- the look ----------------------------------------------------------------

// All lengths are in units of the petal's own DEPTH, which makes them constant
// fractions of the frame at every depth — but NOT at every viewport, since
// core/scene divides the frame's half-height by `camera.zoom`. Anything that
// has to clear the TOP EDGE is written in frame half-heights instead (`top`,
// live through `uFrameHalf`).

/** The ending's park distance in STORY_R units, read off the capsOn row so the
 *  surface line below stays on the lens' base if the row's distance is retuned. */
const ENDING_DIST = Math.hypot(...rangeOf("capsOn").scene.cam.pos);

/** The same distance in world units: how far in front of the camera the
 *  standing lens is, which the depth band is written against. */
export const LENS_DIST = ENDING_DIST * STORY_R;

/** The lens base's drop below the frame's centre, as an angle times the park
 *  distance — what the surface line derives from. */
const BASE_DROP = 0.191;

export const PETAL_LOOK = {
  /** dozens, not thousands (the render hot-path law) */
  count: 64,
  /** the depths the field is spread over, as fractions of the standing lens'
   *  distance (`LENS_DIST`): behind the flower as well as in front of it */
  depth: [0.8, 1.25] as [number, number],
  /** half the spawn band's width, in units of depth. Wide enough that no
   *  viewport shows the band's edge out to about aspect 2.9. */
  spanX: 0.78,
  /** where a petal's own fall STARTS, in units of THE FRAME'S OWN half-height
   *  (`SceneHandle.frameHalf`, live): past the top edge at every viewport
   *  shape. A fixed depth fraction would not clear a phone's taller frame. */
  top: [1.35, 2.1] as [number, number],
  /** THE SURFACE LINE — where every fall ENDS, whatever height it started at:
   *  the standing lens' base in the bloom's frame. Derived, so it stays on the
   *  base if the capsOn row moves. */
  ground: -BASE_DROP / ENDING_DIST,
  /** the height above that line a petal THINS over — keyed on the HEIGHT, not
   *  the petal's own clock, so the field reaches rest weight on one level */
  settle: 0.14,
  /** THE REST: each petal spends the `at`→`out` span of its cycle lying on the
   *  line. `alpha` is the weight it rests at (a floor under the descent fade),
   *  `squash` the lying quad's height, `flatten` the u-span it tips over. */
  rest: {
    at: 0.72,
    out: 0.94,
    alpha: 0.55,
    squash: 0.32,
    flatten: 0.05,
  },
  /** the quad's half-size — constant on SCREEN at every depth, so the field
   *  reads as layers of flat paper rather than a perspective cloud */
  size: [0.0075, 0.0135] as [number, number],
  /** seconds to fall the whole band */
  fallSeconds: [16, 28] as [number, number],
  /** the drift across the fall — amplitude in frame units, rate in rad/s */
  sway: {
    amp: [0.012, 0.045] as [number, number],
    rate: [0.1, 0.3] as [number, number],
  },
  /** the turn IN THE SCREEN PLANE, rad/s — a petal never tumbles through a
   *  third axis */
  spin: [0.05, 0.2] as [number, number],
  /** the paper turning edge-on — the quad's WIDTH breathes to this floor */
  flutter: { rate: [0.15, 0.45] as [number, number], floor: 0.45 },
  /** per-petal alpha, so the field has depth without shading */
  alpha: [0.5, 1] as [number, number],
};

/** THE SILHOUETTE, in the quad's own ±1 coordinates: a petal pointed at the tip
 *  and at the base, `belly` fuller below the middle. One flat tone. */
const SHAPE = { width: 0.72, belly: 0.18, feather: 0.09 };

/** Two tints per stage, mixed per petal: the site's `--highlight` terracotta
 *  and whatever the stage is not. */
const PETAL_INK = {
  dark: { warm: 0xd99a63, cool: 0xf1ecde, opacity: 0.82 },
  light: { warm: 0xd18a5d, cool: 0xa89070, opacity: 0.74 },
};

// --- the field ---------------------------------------------------------------

/** Deterministic, never Math.random: the field is the same on every machine and
 *  every reload. */
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

/** The per-petal constants, one draw's worth. */
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
    aFall[i * 4 + 3] = pick(look.depth) * LENS_DIST; // world units
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

/** Build the one draw: a four-vertex template, three instanced attributes and
 *  one material, with no GPU work until the first draw. */
export function buildPetalObject(light: boolean): PetalField {
  const { aFall, aTurn, aLook } = buildPetalField();
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = PETAL_LOOK.count;
  // `position` holds the quad's ±1 CORNER, not a place: the landing point is
  // solved from the instance's own attributes below
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
    PETAL_LOOK.depth[1] * LENS_DIST,
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
  // `rest.at` until the wrap. `fract` makes the field endless with no respawn.
  const u: TslNode = fract(fall.y.add(uTime.mul(fall.z)));
  const R = PETAL_LOOK.rest;
  // the landing clock: past `rest.at` every animated term runs on the moment
  // this petal touched down — the overshoot in u over the fall rate
  const tEff: TslNode = uTime.sub(
    clamp(u.sub(R.at), float(0), float(1)).div(fall.z),
  );
  // every fall ends on the same line, from its own start height, easing out
  // onto it
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

  // the touchdown: over `rest.flatten` of u the turned quad tips into the lying
  // pose — full width, height squashed — and holds it for the rest
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
  // no modelViewMatrix: the petal IS its view-space place, so the object's own
  // transform is irrelevant and the fall is always screen-down
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(cx.add(ox), cy.add(oy), depth.negate(), 1),
  );

  // The fade is the fall's: a petal lights off screen as it leaves its top and
  // thins on the way down, keyed on HEIGHT, but only to the REST floor. The
  // tail of its own cycle then dissolves it on the line.
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

  // the silhouette: half-width closes to a point at the tip and at the base,
  // fuller below the middle
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
  // a petal behind the flower must be hidden by it, and alphaTest keeps the
  // faded-out ones and the quad's empty corners out of the depth buffer
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

export interface StoryPetals {
  /** Upload the field's buffers off the gesture. Idempotent. */
  warm(): void;
}

/**
 * Start the petals. Registers a scene.onEvaluate callback for the life of the
 * page; the hero's scene is never disposed, so there is no teardown.
 */
export function createStoryPetals(scene: SceneHandle): StoryPetals {
  const field = buildPetalObject(isLightTheme());
  let shown = false;
  /** the field's own clock, seconds — accrues only while petals are drawn */
  let t = 0;

  watchTheme((l) => {
    const pal = l ? PETAL_INK.light : PETAL_INK.dark;
    field.uWarm.value.setHex(pal.warm);
    field.uCool.value.setHex(pal.cool);
    field.uOpacity.value = pal.opacity;
    scene.invalidate();
  });

  scene.onEvaluate((p, dtMs) => {
    const dt = dtMs / 1000;
    // written unconditionally: a flick can leave the bloom between two frames,
    // and a held envelope freezes a field of petals on the stage
    const env = petalEnvAt(p);
    field.uEnv.value = env;

    if (p < SPAN_P0) {
      if (shown) {
        scene.removeOverlay(field.mesh);
        shown = false;
      }
      return false; // outside the bloom: nothing drawn, no time accrued
    }

    if (!shown) {
      scene.addOverlay(field.mesh);
      shown = true;
    }
    // mounted at envelope 0 (the pad below the foot) nothing is drawn, so the
    // fall neither runs nor asks for a frame
    if (env <= 0) return false;
    t += dt;
    field.uTime.value = t;
    // the frame the fall is written against, live: a resize or a fov change
    // moves the top edge the petals have to start above
    field.uFrameHalf.value = scene.frameHalf();
    return true; // the fall runs on time
  });

  return {
    warm() {
      if (!field.mesh.parent) scene.warmDraw([field.mesh]);
    },
  };
}
