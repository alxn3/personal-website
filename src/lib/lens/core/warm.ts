import type * as THREE from "three/webgpu";

// The scene's dry frames: every draw taken to pay a compile or an upload ahead
// of the frame that first shows it. tick() runs one step per drawn tick, ahead
// of its own render, and never a second pass draw in one tick — the wormhole
// pass draws its scene once per tick (three's frame guard on PassNode), so a
// step that needs the pass on a mounted tick rides the tick's real draw.

/** One dry frame the scene owes. */
export interface WarmStep {
  /** Runs only on a tick with the pass down and no dive live. Every canvas
   *  draw is one: on a live dive a canvas render would compile the dive's
   *  clones in the canvas context, on a real frame. */
  bare: boolean;
  /** `mounted` is whether the tick draws through the pass. A step that mounts
   *  objects for that draw returns the hook that takes them off again, called
   *  after the render. */
  run(mounted: boolean): (() => void) | void;
}

/** What a tick offers a step. */
export interface WarmTick {
  mounted: boolean;
  bare: boolean;
}

export interface WarmQueue {
  push(...steps: WarmStep[]): void;
  readonly length: number;
  /** Run the first step this tick can carry. Steps the tick cannot carry stay
   *  queued for one that can. Returns the step's after-render hook, or null if
   *  nothing ran. */
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

/** The draws a warm step is made of. */
export interface WarmDrawEnv {
  /** where a parked object is mounted for its draw */
  scene: THREE.Object3D;
  /** the canvas-context draw */
  render(): void;
  /** the pass-context draw into a dry target — a tick the pass is down */
  dryPass(): void;
}

/** Mount `objects` that have no parent and turn their culling off, so the
 *  draw cannot skip them; returns the exact undo. */
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

/** The steps that pay `objects`' uploads and pipelines: one canvas draw, and
 *  with `viaPass` one pass draw too — dry while the pass is down, folded into
 *  the tick's real pass draw while it is up. */
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
      if (mounted) return restore; // the objects ride this tick's real draw
      try {
        env.dryPass();
      } finally {
        restore();
      }
    },
  };
  return viaPass ? [canvas, pass] : [canvas];
}
