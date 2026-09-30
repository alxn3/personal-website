import * as THREE from "three/webgpu";
import type { SceneState } from "../core/scene";

// Dev only, dynamically imported. `?mtrace`: records the camera every rendered
// frame, read from the console as `window.__lensMotionTrace`. The lens sits at
// the world origin with its optical axis on world X; during the fly-through the
// lens moves instead of the camera, so `ndc`/`rad` there show its home position.

/** Max samples kept (~5.5 min at 60fps). */
const CAP = 20000;

export interface MotionSample {
  /** performance.now() at the frame */
  t: number;
  /** ms since the previous recorded frame */
  dt: number;
  /** raw scroll progress (state.storyTarget) */
  p: number;
  /** eased progress the camera was actually sampled at (state.story) */
  pe: number;
  pos: [number, number, number];
  /** camera view direction (world) */
  dir: [number, number, number];
  /** camera up (world) */
  up: [number, number, number];
  fov: number;
  /** degrees between the view direction and the optical axis (±X) */
  aim: number;
  /** degrees the world's vertical is rotated on screen */
  roll: number;
  /** where the lens centre (world origin) lands, in NDC */
  ndc: [number, number];
  /** NDC half-height a sphere of the model's radius subtends at the origin */
  rad: number;
  ch: Pick<
    SceneState,
    "zoom" | "focus" | "aperture" | "peel" | "explode" | "assemble"
  >;
}

export interface MotionTrace {
  samples: MotionSample[];
  clear(): void;
  record(camera: THREE.PerspectiveCamera, s: SceneState, radius: number): void;
}

const DEG = 180 / Math.PI;
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wy = new THREE.Vector3();
const _o = new THREE.Vector3();
const _e = new THREE.Vector3();

export function mountMotionTrace(): MotionTrace {
  const samples: MotionSample[] = [];
  let last = 0;
  const trace: MotionTrace = {
    samples,
    clear() {
      samples.length = 0;
      last = 0;
    },
    record(camera, s, radius) {
      const t = performance.now();
      // project() needs matrixWorldInverse, which is otherwise set at render.
      camera.updateMatrixWorld();
      const m = camera.matrixWorld.elements;
      _right.set(m[0], m[1], m[2]).normalize();
      _up.set(m[4], m[5], m[6]).normalize();
      _dir.set(-m[8], -m[9], -m[10]).normalize();
      _pos.setFromMatrixPosition(camera.matrixWorld);
      // world +Y flattened into the screen plane, measured against screen up
      _wy.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
      _o.set(0, 0, 0).project(camera);
      _e.copy(_up).multiplyScalar(radius).project(camera);
      samples.push({
        t,
        dt: last ? t - last : 0,
        p: s.storyTarget,
        pe: s.story,
        pos: [_pos.x, _pos.y, _pos.z],
        dir: [_dir.x, _dir.y, _dir.z],
        up: [_up.x, _up.y, _up.z],
        fov: camera.fov,
        aim: Math.acos(Math.min(1, Math.abs(_dir.x))) * DEG,
        roll:
          _wy.lengthSq() < 1e-8
            ? 0
            : Math.atan2(_wy.dot(_right), _wy.dot(_up)) * DEG,
        ndc: [_o.x, _o.y],
        rad: Math.abs(_e.y - _o.y),
        ch: {
          zoom: s.zoom,
          focus: s.focus,
          aperture: s.aperture,
          peel: s.peel,
          explode: s.explode,
          assemble: s.assemble,
        },
      });
      if (samples.length > CAP) samples.shift();
      last = t;
    },
  };
  (window as unknown as { __lensMotionTrace: MotionTrace }).__lensMotionTrace =
    trace;
  return trace;
}
