import type * as THREE from "three/webgpu";

// Warm-up draws: off-screen draws that compile shaders or upload buffers before
// the frame that first shows something. tick() runs at most one per frame. The
// post pass renders the scene only once per frame, so a pass step on a frame
// already drawing through the pass just joins that draw.

/** One queued warm-up draw. */
export interface WarmStep {
  /** only run on a frame with no post pass and no fly-through */
  bare: boolean;
  /** `mounted`: this frame draws through the post pass. May return a cleanup
   *  to run after the frame's render. */
  run(mounted: boolean): (() => void) | void;
}

/** The current frame's state. */
export interface WarmTick {
  mounted: boolean;
  bare: boolean;
}

export interface WarmQueue {
  push(...steps: WarmStep[]): void;
  readonly length: number;
  /** Run the first step this frame allows. Returns its after-render hook, or
   *  null if nothing ran. */
  step(tick: WarmTick): { after?: () => void } | null;
}

export function createWarmQueue(): WarmQueue {
  const steps: WarmStep[] = [];
  return {
    push(...s) {
      steps.push(...s);
    },
    get length() {
      return steps.length;
    },
    step(tick) {
      const i = steps.findIndex((s) => !s.bare || tick.bare);
      if (i < 0) return null;
      const [s] = steps.splice(i, 1);
      const after = s.run(tick.mounted);
      return after ? { after } : {};
    },
  };
}

export interface WarmDrawEnv {
  /** where unparented objects are added for the draw */
  scene: THREE.Object3D;
  /** draw to the canvas */
  render(): void;
  /** draw through the post pass into a throwaway target */
  dryPass(): void;
}

/** Add unparented `objects` to `scene` and disable culling so the draw can't
 *  skip them. Returns the undo. */
function mountForDraw(objects: THREE.Object3D[], scene: THREE.Object3D) {
  const parked = objects.filter((o) => !o.parent);
  const culled: THREE.Object3D[] = [];
  for (const o of objects)
    o.traverse((c) => {
      if (c.frustumCulled) {
        c.frustumCulled = false;
        culled.push(c);
      }
    });
  for (const o of parked) scene.add(o);
  return () => {
    for (const o of parked) scene.remove(o);
    for (const c of culled) c.frustumCulled = true;
  };
}

/** Steps that draw `objects` once on the canvas and, with `viaPass`, once
 *  through the post pass. */
export function warmDrawSteps(
  objects: THREE.Object3D[],
  viaPass: boolean,
  env: WarmDrawEnv,
): WarmStep[] {
  const canvas: WarmStep = {
    bare: true,
    run() {
      const restore = mountForDraw(objects, env.scene);
      try {
        env.render();
      } finally {
        restore();
      }
    },
  };
  const pass: WarmStep = {
    bare: false,
    run(mounted) {
      const restore = mountForDraw(objects, env.scene);
      if (mounted) return restore; // drawn by this frame's real render
      try {
        env.dryPass();
      } finally {
        restore();
      }
    },
  };
  return viaPass ? [canvas, pass] : [canvas];
}
