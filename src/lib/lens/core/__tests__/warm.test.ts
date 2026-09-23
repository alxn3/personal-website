import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createWarmQueue, warmDrawSteps, type WarmStep } from "../warm";

// THE WARM LAW: one step per tick ahead of the tick's own render, never a
// second pass draw in one tick, and a step checks the TICK's state, not the
// queue's — a step that cannot run on this tick waits for one it can.

const step = (bare: boolean, log: string[], name: string): WarmStep => ({
  bare,
  run(mounted) {
    log.push(`${name}:${mounted ? "mounted" : "down"}`);
  },
});

describe("the warm queue", () => {
  it("runs one step per tick, in order", () => {
    const log: string[] = [];
    const q = createWarmQueue();
    q.push(step(true, log, "a"), step(true, log, "b"));
    expect(q.step({ mounted: false, bare: true })).toEqual({});
    expect(log).toEqual(["a:down"]);
    expect(q.length).toBe(1);
    q.step({ mounted: false, bare: true });
    expect(log).toEqual(["a:down", "b:down"]);
    expect(q.step({ mounted: false, bare: true })).toBeNull();
  });

  it("holds a bare step over a live dive and runs it once the tick is bare", () => {
    const log: string[] = [];
    const q = createWarmQueue();
    q.push(step(true, log, "fly"));
    expect(q.step({ mounted: true, bare: false })).toBeNull();
    expect(q.step({ mounted: false, bare: false })).toBeNull(); // glass on, pass down
    expect(log).toEqual([]);
    expect(q.length).toBe(1);
    q.step({ mounted: false, bare: true });
    expect(log).toEqual(["fly:down"]);
  });

  it("runs a pass step on a mounted tick ahead of a held bare one", () => {
    const log: string[] = [];
    const q = createWarmQueue();
    q.push(step(true, log, "fly"), step(false, log, "pass"));
    q.step({ mounted: true, bare: false });
    expect(log).toEqual(["pass:mounted"]);
    expect(q.length).toBe(1); // the bare step is still owed
  });

  it("hands back a step's after-render hook", () => {
    const q = createWarmQueue();
    const after = () => {};
    q.push({ bare: false, run: () => after });
    expect(q.step({ mounted: true, bare: false })).toEqual({ after });
  });
});

/** a scene, a parked object and a draw log */
function rig() {
  const scene = new THREE.Group();
  const obj = new THREE.Group();
  const child = new THREE.Mesh();
  obj.add(child);
  const log: string[] = [];
  const env = {
    scene,
    render() {
      log.push(`canvas:${obj.parent === scene}:${child.frustumCulled}`);
    },
    dryPass() {
      log.push(`dry:${obj.parent === scene}:${child.frustumCulled}`);
    },
  };
  return { scene, obj, child, log, env };
}

describe("warmDrawSteps", () => {
  it("draws a canvas-only job once, mounted and unculled, and puts it back", () => {
    const { scene, obj, child, log, env } = rig();
    const steps = warmDrawSteps([obj], false, env);
    expect(steps).toHaveLength(1);
    expect(steps[0].bare).toBe(true);
    expect(steps[0].run(false)).toBeUndefined();
    expect(log).toEqual(["canvas:true:false"]);
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
    expect(scene.children).toEqual([]);
  });

  it("gives a viaPass job a canvas step and a pass step, the pass one never bare", () => {
    const { log, env, obj } = rig();
    const [canvas, pass] = warmDrawSteps([obj], true, env);
    expect(canvas.bare).toBe(true);
    expect(pass.bare).toBe(false);
    pass.run(false);
    expect(log).toEqual(["dry:true:false"]); // the pass step draws no canvas
  });

  it("on a mounted tick, the pass step rides the real draw: mounted until the after hook", () => {
    const { scene, obj, child, log, env } = rig();
    const [, pass] = warmDrawSteps([obj], true, env);
    const after = pass.run(true);
    expect(log).toEqual([]); // no dry pass draw — that would be a second one
    expect(obj.parent).toBe(scene);
    expect(child.frustumCulled).toBe(false);
    expect(after).toBeTypeOf("function");
    after!();
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
  });

  it("leaves an object that already has a parent where it is", () => {
    const { scene, obj, env } = rig();
    const home = new THREE.Group();
    home.add(obj);
    const [canvas] = warmDrawSteps([obj], false, env);
    canvas.run(false);
    expect(obj.parent).toBe(home);
    expect(scene.children).toEqual([]);
  });

  it("restores even when the draw throws", () => {
    const { obj, child, env } = rig();
    env.render = () => {
      throw new Error("lost context");
    };
    const [canvas] = warmDrawSteps([obj], false, env);
    expect(() => canvas.run(false)).toThrow();
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
  });
});
