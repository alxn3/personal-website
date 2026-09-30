// The rose ending's petals: flat paper petals drifting down the screen while the
// flower is open. They replace the ambient dust during the bloom (dustAt in
// story/envelopes.ts turns the dust off here).
//
// Lazy module: only hero-driver's dynamic import() may reach it, and index.ts
// must never re-export it.
//
// Each petal is a view-space billboard, so it always falls screen-down; only
// its depth is 3D, letting petals pass behind the flower. The whole field is
// one instanced draw animated in the vertex shader; per frame only uniforms
// change.

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
import { lcg, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { STORY_R, rangeOf, windowEdges } from "./story";
import { PETALS_P0, ROSE_PULSE } from "./envelopes";

const TAU = Math.PI * 2;

// --- Timing ---

const [ROSE_P0, ROSE_P1] = windowEdges(ROSE_PULSE.rise);

/** Story p where the petals are fully in: halfway through the bloom. */
export const PETAL_RISE = ROSE_P0 + 0.5 * (ROSE_P1 - ROSE_P0);

/** Overall petal opacity: 0 up to the bloom's start, then rises and stays. */
export const petalEnvAt = (p: number): number =>
  smoothstep(ROSE_P0, PETAL_RISE, p);

/** Story-p span the field is mounted over (starts a little before it shows). */
export const SPAN_P0 = PETALS_P0;
export const SPAN_P1 = 1;

// --- Look ---
// Lengths are in units of each petal's depth (a constant fraction of the
// frame). Heights that must clear the top edge use frame half-heights instead.

/** Camera distance in the final scene, in STORY_R units. */
const ENDING_DIST = Math.hypot(...rangeOf("capsOn").scene.cam.pos);

/** Camera distance to the standing lens, world units. */
export const LENS_DIST = ENDING_DIST * STORY_R;

/** How far below frame centre the lens base sits, times the camera distance. */
const BASE_DROP = 0.191;

export const PETAL_LOOK = {
  count: 64,
  /** depth range, as fractions of LENS_DIST (both behind and in front) */
  depth: [0.8, 1.25] as [number, number],
  /** half-width of the spawn band, in depth units */
  spanX: 0.78,
  /** start height range, in frame half-heights (above the top edge) */
  top: [1.35, 2.1] as [number, number],
  /** height where every fall ends: the lens base */
  ground: -BASE_DROP / ENDING_DIST,
  /** height above the ground over which a petal fades to its rest alpha */
  settle: 0.14,
  /** Resting on the ground from cycle fraction `at` to `out`: `alpha` is the
   *  resting opacity, `squash` the lying height, `flatten` how fast it lies. */
  rest: {
    at: 0.72,
    out: 0.94,
    alpha: 0.55,
    squash: 0.32,
    flatten: 0.05,
  },
  /** half-size range, in depth units (constant on screen) */
  size: [0.0075, 0.0135] as [number, number],
  /** seconds to fall the whole band */
  fallSeconds: [16, 28] as [number, number],
  /** side-to-side drift: amplitude in depth units, rate in rad/s */
  sway: {
    amp: [0.012, 0.045] as [number, number],
    rate: [0.1, 0.3] as [number, number],
  },
  /** in-plane spin, rad/s */
  spin: [0.05, 0.2] as [number, number],
  /** width oscillation (paper turning edge-on): rate in rad/s, minimum width */
  flutter: { rate: [0.15, 0.45] as [number, number], floor: 0.45 },
  /** per-petal alpha range */
  alpha: [0.5, 1] as [number, number],
};

/** Petal outline in the quad's ±1 coordinates: pointed at both ends, fuller
 *  below the middle. */
const SHAPE = { width: 0.72, belly: 0.18, feather: 0.09 };

/** Two tints per theme, mixed per petal. */
const PETAL_INK = {
  dark: { warm: 0xd99a63, cool: 0xf1ecde, opacity: 0.82 },
  light: { warm: 0xd18a5d, cool: 0xa89070, opacity: 0.74 },
};

// --- The field ---

interface PetalAttributes {
  /** (column, phase, fall rate, depth) */
  aFall: Float32Array;
  /** (sway amplitude, sway rate, spin rate, flutter rate) */
  aTurn: Float32Array;
  /** (half-size, alpha, tint mix, start height) */
  aLook: Float32Array;
}

/** Per-petal random constants, packed four floats per petal. */
export function buildPetalField(look = PETAL_LOOK): PetalAttributes {
  const rnd = lcg(20260823);
  const pick = (r: readonly [number, number]) => lerp(r[0], r[1], rnd());
  const n = look.count;
  const aFall = new Float32Array(n * 4);
  const aTurn = new Float32Array(n * 4);
  const aLook = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    aFall[i * 4] = rnd() * 2 - 1; // column, ±1 across the band
    aFall[i * 4 + 1] = rnd(); // starting phase in its fall
    aFall[i * 4 + 2] = 1 / pick(look.fallSeconds); // falls per second
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

interface PetalField {
  mesh: THREE.Mesh;
  uTime: { value: number };
  uEnv: { value: number };
  /** frame half-height per unit depth; `top` is measured in this */
  uFrameHalf: { value: number };
  uWarm: { value: THREE.Color };
  uCool: { value: THREE.Color };
  uOpacity: { value: number };
}

/** Build the instanced petal mesh and its material. */
export function buildPetalObject(light: boolean): PetalField {
  const { aFall, aTurn, aLook } = buildPetalField();
  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = PETAL_LOOK.count;
  // `position` holds the quad's ±1 corners; placement comes from the attributes
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
  // petals are placed in view space, so give a fixed bounding sphere
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(),
    PETAL_LOOK.depth[1] * LENS_DIST,
  );

  const pal = light ? PETAL_INK.light : PETAL_INK.dark;
  const uTime = uniform(0);
  const uEnv = uniform(0);
  // default: a 30° fov frame, until the driver writes the live value
  const uFrameHalf = uniform(Math.tan((30 * Math.PI) / 360));
  const uWarm = uniform(new THREE.Color(pal.warm));
  const uCool = uniform(new THREE.Color(pal.cool));
  const uOpacity = uniform(pal.opacity);

  const fall: TslNode = attribute("aFall", "vec4");
  const turn: TslNode = attribute("aTurn", "vec4");
  const look: TslNode = attribute("aLook", "vec4");
  const depth: TslNode = fall.w;
  const phase: TslNode = fall.y.mul(TAU);

  // u: position in the petal's repeating cycle, 0 = top; it rests on the
  // ground from `rest.at` until it wraps
  const u: TslNode = fract(fall.y.add(uTime.mul(fall.z)));
  const R = PETAL_LOOK.rest;
  // animation time, frozen at the moment the petal lands
  const tEff: TslNode = uTime.sub(
    clamp(u.sub(R.at), float(0), float(1)).div(fall.z),
  );
  // ease-out drop from the start height to the ground
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

  // corner offset: spun in the screen plane, width narrowed by the flutter
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

  // on landing, blend to the lying pose: full width, squashed height
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
  // positions are already in view space, so skip modelViewMatrix
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(cx.add(ox), cy.add(oy), depth.negate(), 1),
  );

  // Fade in at the top, fade toward the rest alpha near the ground, then fade
  // out at the end of the cycle.
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

  // petal outline: half-width at height vY
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
  // write depth so the flower hides petals behind it; alphaTest keeps faded
  // petals and empty corners out of the depth buffer
  mat.depthWrite = true;
  mat.alphaTest = 0.02;
  mat.side = THREE.DoubleSide;
  mat.toneMapped = false;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "Lens_Petals";
  mesh.frustumCulled = false;
  mesh.raycast = () => {};

  return { mesh, uTime, uEnv, uFrameHalf, uWarm, uCool, uOpacity };
}

// --- The scene driver ---

export interface StoryPetals {
  /** Pre-upload the petal buffers. Idempotent. */
  warm(): void;
}

/** Start the petals. Registers a per-frame callback for the life of the page. */
export function createStoryPetals(scene: SceneHandle): StoryPetals {
  const field = buildPetalObject(isLightTheme());
  let shown = false;
  /** seconds; advances only while petals are visible */
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
    // always write the envelope so a fast scroll never leaves a stale value
    const env = petalEnvAt(p);
    field.uEnv.value = env;

    if (p < SPAN_P0) {
      if (shown) {
        scene.removeOverlay(field.mesh);
        shown = false;
      }
      return false;
    }

    if (!shown) {
      scene.addOverlay(field.mesh);
      shown = true;
    }
    // mounted but invisible: don't advance time or request frames
    if (env <= 0) return false;
    t += dt;
    field.uTime.value = t;
    field.uFrameHalf.value = scene.frameHalf();
    return true;
  });

  return {
    warm() {
      if (!field.mesh.parent) scene.warmDraw([field.mesh]);
    },
  };
}
