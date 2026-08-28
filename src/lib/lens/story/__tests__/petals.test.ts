import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { rangeOf, windowEdges } from "../story";
import { ROSE_PULSE } from "../envelopes";
import { SPAN_P1 as TRAILS_SPAN_P1 } from "../trails";
import { frameZoom } from "../../core/scene";
import {
  PETAL_LOOK,
  createStoryPetals,
  PETAL_RISE,
  SPAN_P0,
  SPAN_P1,
  buildPetalField,
  buildPetalObject,
  petalEnvAt,
} from "../petals";

// createStoryPetals' theme watcher reads the document (core/theme.ts) — the
// only DOM this file's subject touches, and only from inside the factory.
(globalThis as unknown as { document: unknown }).document ??= {
  documentElement: { classList: { contains: () => true } },
};
(globalThis as unknown as { MutationObserver: unknown }).MutationObserver ??=
  class {
    observe() {}
  };

const [ROSE_P0, ROSE_P1] = windowEdges(ROSE_PULSE.rise);

describe("the petals' window", () => {
  it("is resolved from the bloom's own window at import time", () => {
    // the field IS the bloom's ambient: its foot is the rose's foot, and it is
    // full by the middle of the bloom, so the petals arrive WITH the flower
    expect(PETAL_RISE).toBeCloseTo(ROSE_P0 + 0.5 * (ROSE_P1 - ROSE_P0), 12);
    expect(PETAL_RISE).toBeGreaterThan(ROSE_P0);
    expect(PETAL_RISE).toBeLessThan(ROSE_P1);
  });

  it("draws EXACTLY nothing outside the bloom", () => {
    // an exact 0, not a small number: below the foot the envelope multiplies
    // every petal's alpha to zero and alphaTest discards the quads entirely
    for (const p of [0, 0.25, 0.5, rangeOf("rewrap").p0, SPAN_P0, ROSE_P0])
      expect(petalEnvAt(p), `p ${p}`).toBe(0);
  });

  it("rises with the flower and never falls — the story ends inside it", () => {
    expect(petalEnvAt(ROSE_P0 + 1e-4)).toBeGreaterThan(0);
    expect(petalEnvAt(PETAL_RISE)).toBe(1);
    expect(petalEnvAt(ROSE_P1)).toBe(1);
    expect(petalEnvAt(1)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const e = petalEnvAt(ROSE_P0 + (i / 200) * (1 - ROSE_P0));
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it("mounts a pad AHEAD of the first drawn frame and runs to the track's end", () => {
    expect(SPAN_P0).toBeLessThan(ROSE_P0);
    expect(petalEnvAt(SPAN_P0)).toBe(0); // mounted, drawing nothing
    expect(SPAN_P1).toBe(1);
    // ONE ambient field at a time: the sky's arcs are off the starfield well
    // before the petals mount
    expect(TRAILS_SPAN_P1).toBeLessThan(SPAN_P0);
  });
});

describe("the field", () => {
  const a = buildPetalField();
  const n = PETAL_LOOK.count;
  const at = (arr: Float32Array, i: number, w: number, k: number) =>
    arr[i * w + k];

  it("is deterministic — the same field on every machine and every reload", () => {
    const b = buildPetalField();
    expect([...a.aFall]).toEqual([...b.aFall]);
    expect([...a.aTurn]).toEqual([...b.aTurn]);
    expect([...a.aLook]).toEqual([...b.aLook]);
  });

  it("is dozens of petals, not thousands (the render hot-path law)", () => {
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(120);
    expect(a.aFall.length).toBe(n * 4);
    expect(a.aTurn.length).toBe(n * 4);
    expect(a.aLook.length).toBe(n * 4);
  });

  it("keeps every per-petal constant inside its authored range", () => {
    const inR = (v: number, r: readonly [number, number]) =>
      v >= r[0] - 1e-6 && v <= r[1] + 1e-6;
    for (let i = 0; i < n; i++) {
      expect(Math.abs(at(a.aFall, i, 4, 0))).toBeLessThanOrEqual(1); // column
      expect(inR(at(a.aFall, i, 4, 1), [0, 1])).toBe(true); // phase
      // the fall rate is bands per second — every petal falls, none stalls
      const secs = 1 / at(a.aFall, i, 4, 2);
      expect(inR(secs, PETAL_LOOK.fallSeconds), `petal ${i} fall`).toBe(true);
      expect(inR(at(a.aFall, i, 4, 3), PETAL_LOOK.depth)).toBe(true);
      expect(inR(at(a.aTurn, i, 4, 0), PETAL_LOOK.sway.amp)).toBe(true);
      expect(inR(at(a.aTurn, i, 4, 1), PETAL_LOOK.sway.rate)).toBe(true);
      expect(inR(Math.abs(at(a.aTurn, i, 4, 2)), PETAL_LOOK.spin)).toBe(true);
      expect(inR(at(a.aTurn, i, 4, 3), PETAL_LOOK.flutter.rate)).toBe(true);
      expect(inR(at(a.aLook, i, 4, 0), PETAL_LOOK.size)).toBe(true);
      expect(inR(at(a.aLook, i, 4, 1), PETAL_LOOK.alpha)).toBe(true);
      expect(inR(at(a.aLook, i, 4, 2), [0, 1])).toBe(true);
      expect(inR(at(a.aLook, i, 4, 3), PETAL_LOOK.top)).toBe(true);
    }
  });

  it("spreads the phases, so the first frame in the span is a full field", () => {
    // the fall is `fract(phase + t·rate)`: at t = 0 the phases ARE the field's
    // vertical spread, so a reader arriving at the bloom sees petals mid-fall
    // rather than a curtain dropping from the top edge
    const q = [0, 0, 0, 0];
    for (let i = 0; i < n; i++)
      q[Math.min(3, (at(a.aFall, i, 4, 1) * 4) | 0)]++;
    for (const c of q) expect(c).toBeGreaterThan(0);
  });

  it("turns both ways", () => {
    const signs = new Set<number>();
    for (let i = 0; i < n; i++) signs.add(Math.sign(at(a.aTurn, i, 4, 2)));
    expect(signs.size).toBe(2);
  });

  it("straddles the flower, so petals pass behind it as well as in front", () => {
    // the ending's camera parks at this distance and the depths are view-space
    const dist = Math.hypot(...rangeOf("capsOn").scene.cam.pos);
    expect(PETAL_LOOK.depth[0]).toBeLessThan(dist);
    expect(PETAL_LOOK.depth[1]).toBeGreaterThan(dist);
  });

  it("falls from off screen ONTO a surface inside the frame, at any viewport shape", () => {
    // THE FRAME IS NOT THE FOV ALONE. core/scene divides the frame's half-height
    // by `camera.zoom`, which its own law drives from min(w,h)/h — so a phone's
    // frame is more than twice as tall in petal units as a laptop's, and a fall
    // written as a fraction of DEPTH would start well inside it. `top` is
    // therefore in units of the LIVE half-height (petals.ts `uFrameHalf`), and
    // the law below is checked at the shapes the story is really read at.
    const fov = rangeOf("capsOn").scene.cam.fov;
    const L = PETAL_LOOK;
    for (const [w, h] of [
      [1440, 810], // laptop
      [900, 900], // square
      [390, 844], // phone
      [320, 1000], // a very narrow one
    ]) {
      const at = `${w}x${h}`;
      const zoom = frameZoom(w, h);
      // the frame, in the petals' own units: half-height, and half-width
      const half = Math.tan((fov * Math.PI) / 360) / zoom;
      const halfW = half * (w / h);
      // EVERY fall starts above the top edge…
      expect(L.top[0] * half, at).toBeGreaterThan(half);
      // …and is fully lit before it reaches it: the alpha ramp is spent at
      // u = 0.05 of the cycle, whose eased fall (petals.ts `uf`/`drop`) has
      // covered this much of the way down
      const uf = Math.min(1, 0.05 / L.rest.at);
      const drop = uf * (2 - uf);
      const lit = L.top[0] * half * (1 - drop) + L.ground * drop;
      expect(lit, at).toBeGreaterThan(half);
      // …the surface line is INSIDE the frame (a ground below the bottom edge
      // is just a fall off the screen again)…
      expect(L.ground, at).toBeGreaterThan(-half);
      expect(L.ground).toBeLessThan(0); // below the flower's middle
      // …and the spawn band still covers the frame's width
      expect(L.spanX, at).toBeGreaterThan(halfW);
    }
  });

  it("rests ON the standing lens' base — the line is derived, not tuned", () => {
    // the surface line must sit on the lens base whatever distance the capsOn
    // row parks at: ground scales as 1/distance so the WORLD level is fixed.
    // 0.191 is the measured base drop at unit distance (petals.ts BASE_DROP).
    const dist = Math.hypot(...rangeOf("capsOn").scene.cam.pos);
    expect(PETAL_LOOK.ground * dist).toBeCloseTo(-0.191, 9);
  });

  it("spends a real slice of every cycle lying on the line, then turns over", () => {
    const R = PETAL_LOOK.rest;
    // the air, the rest and the dissolve partition the cycle in that order
    expect(R.at).toBeGreaterThan(0.5); // most of the cycle is the fall…
    expect(R.at + R.flatten).toBeLessThan(R.out); // …then a real rest…
    expect(R.out).toBeLessThan(1); // …then the dissolve, inside the cycle
    // a resting petal is VISIBLE: its floor clears the material's alphaTest
    // through the dimmest per-petal alpha and both stage opacities
    const dimmest = R.alpha * PETAL_LOOK.alpha[0] * 0.74;
    expect(dimmest).toBeGreaterThan(0.1);
    // and it LIES DOWN rather than standing on the line
    expect(R.squash).toBeGreaterThan(0);
    expect(R.squash).toBeLessThan(0.5);
  });

  it("writes the live frame every drawn frame, so a resize re-aims the fall", () => {
    // the ruler `top` is written in is a UNIFORM, and story/petals.ts's own
    // onFrame is what keeps it true — driven here rather than described, so a
    // write that stops happening fails this instead of going stale on screen
    let cb: (() => void) | null = null;
    let reads = 0;
    const scene = {
      state: { storyTarget: 1 },
      onFrame: (f: () => void) => {
        cb = f;
      },
      frameHalf: () => {
        reads++;
        return 0.58;
      },
      addOverlay: () => {},
      removeOverlay: () => {},
      setDust: () => {},
      invalidate: () => {},
      warmDraw: () => {},
    } as unknown as Parameters<typeof createStoryPetals>[0];
    createStoryPetals(scene);
    expect(cb).not.toBeNull();
    for (let i = 0; i < 3; i++) cb!();
    expect(reads).toBe(3);
    // …and outside the bloom nothing is drawn, so nothing is read either
    (scene.state as { storyTarget: number }).storyTarget = 0.2;
    cb!();
    expect(reads).toBe(3);
  });
});

describe("the draw", () => {
  const field = buildPetalObject(false);
  const mesh = field.mesh;
  const geo = mesh.geometry as THREE.InstancedBufferGeometry;

  it("is ONE instanced draw of a four-vertex template", () => {
    expect(geo.isInstancedBufferGeometry).toBe(true);
    expect(geo.instanceCount).toBe(PETAL_LOOK.count);
    const pos = geo.getAttribute("position");
    expect(pos.count).toBe(4);
    expect(pos instanceof THREE.InstancedBufferAttribute).toBe(false);
    expect(geo.getIndex()!.count).toBe(6);
    // the template holds the quad's ±1 CORNER, not a place
    for (let v = 0; v < 4; v++) {
      expect(Math.abs(pos.getX(v))).toBe(1);
      expect(Math.abs(pos.getY(v))).toBe(1);
    }
  });

  it("puts everything per-PETAL in an instance attribute", () => {
    for (const [name, w] of [
      ["aFall", 4],
      ["aTurn", 4],
      ["aLook", 4],
    ] as const) {
      const attr = geo.getAttribute(name);
      expect(attr instanceof THREE.InstancedBufferAttribute, name).toBe(true);
      expect(attr.count, name).toBe(PETAL_LOOK.count);
      expect(attr.itemSize, name).toBe(w);
    }
  });

  it("draws flat ink that the flower can hide (the 2D/3D design law)", () => {
    const mat = mesh.material as THREE.MeshBasicNodeMaterial;
    expect(mat.toneMapped).toBe(false); // not a lit surface
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(true); // occlusion against the model
    expect(mat.alphaTest).toBeGreaterThan(0);
    expect(mesh.frustumCulled).toBe(false); // placed in view space
    expect(field.uEnv.value).toBe(0); // nothing shows until the driver opens it
  });

  it("re-palettes for the stage", () => {
    const dark = buildPetalObject(false);
    expect(field.uWarm.value.getHex()).toBe(dark.uWarm.value.getHex());
    const light = buildPetalObject(true);
    expect(light.uWarm.value.getHex()).not.toBe(dark.uWarm.value.getHex());
    expect(light.uCool.value.getHex()).not.toBe(dark.uCool.value.getHex());
  });
});
