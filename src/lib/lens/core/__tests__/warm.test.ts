import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createWarmQueue, warmDrawStep, type WarmStep } from "../warm";

// At most one warm step per frame; a step that can't run on this frame waits
// for one where it can.

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
    draw() {
      log.push(`draw:${obj.parent === scene}:${child.frustumCulled}`);
    },
  };
  return { scene, obj, child, log, env };
}

describe("warmDrawStep", () => {
  it("draws the object once, mounted and unculled, and puts it back", () => {
    const { scene, obj, child, log, env } = rig();
    const step = warmDrawStep([obj], false, env);
    expect(step.bare).toBe(true);
    expect(step.run(false)).toBeUndefined();
    expect(log).toEqual(["draw:true:false"]);
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
    expect(scene.children).toEqual([]);
  });

  it("an inDive step is never bare, and rides a mounted frame's own draw", () => {
    const { scene, obj, child, log, env } = rig();
    const step = warmDrawStep([obj], true, env);
    expect(step.bare).toBe(false);
    const after = step.run(true);
    expect(log).toEqual([]); // no draw of its own: that would be a second one
    expect(obj.parent).toBe(scene);
    expect(child.frustumCulled).toBe(false);
    expect(after).toBeTypeOf("function");
    after!();
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
    // without the dive it draws itself
    step.run(false);
    expect(log).toEqual(["draw:true:false"]);
  });

  it("leaves an object that already has a parent where it is", () => {
    const { scene, obj, env } = rig();
    const home = new THREE.Group();
    home.add(obj);
    warmDrawStep([obj], false, env).run(false);
    expect(obj.parent).toBe(home);
    expect(scene.children).toEqual([]);
  });

  it("restores even when the draw throws", () => {
    const { obj, child, env } = rig();
    env.draw = () => {
      throw new Error("lost context");
    };
    expect(() => warmDrawStep([obj], false, env).run(false)).toThrow();
    expect(obj.parent).toBeNull();
    expect(child.frustumCulled).toBe(true);
  });
});
