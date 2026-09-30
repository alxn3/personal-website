import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { STORY_R, rangeOf, windowEdges } from "../story";
import { ROSE_PULSE } from "../envelopes";
import { SPAN_P1 as TRAILS_SPAN_P1 } from "../trails";
import { farFor, frameZoom } from "../../core/scene";
import { fakeScene, lin } from "./fake-scene";
import {
  LENS_DIST,
  PETAL_LOOK,
  createStoryPetals,
  PETAL_RISE,
  SPAN_P0,
  SPAN_P1,
  buildPetalField,
  buildPetalObject,
  petalEnvAt,
} from "../petals";

// createStoryPetals' theme watcher is the only DOM it touches.
(globalThis as unknown as { document: unknown }).document ??= {
  documentElement: { classList: { contains: () => true } },
};
(globalThis as unknown as { MutationObserver: unknown }).MutationObserver ??=
  class {
    observe() {}
  };

const [ROSE_P0, ROSE_P1] = windowEdges(ROSE_PULSE.rise);
const L = PETAL_LOOK;
/** the ending camera's distance to the lens, in STORY_R units */
const ENDING_DIST = Math.hypot(...rangeOf("capsOn").scene.cam.pos);

describe("the petals' window", () => {
  it("draws EXACTLY nothing before the bloom, and is full by its middle", () => {
    // exactly 0, so alphaTest discards every quad
    for (const p of [0, 0.25, 0.5, rangeOf("rewrap").p0, SPAN_P0, ROSE_P0])
      expect(petalEnvAt(p), `p ${p}`).toBe(0);
    expect(PETAL_RISE).toBeCloseTo(ROSE_P0 + 0.5 * (ROSE_P1 - ROSE_P0), 12);
  });

  it("rises with the flower and never falls — the story ends inside it", () => {
    expect(petalEnvAt(ROSE_P0 + 1e-4)).toBeGreaterThan(0);
    for (const p of [PETAL_RISE, ROSE_P1, 1]) expect(petalEnvAt(p)).toBe(1);
    const ps = lin(ROSE_P0, 1, 200);
    for (let i = 1; i < ps.length; i++)
      expect(petalEnvAt(ps[i])).toBeGreaterThanOrEqual(petalEnvAt(ps[i - 1]));
  });

  it("mounts a pad AHEAD of the first drawn frame and runs to the track's end", () => {
    expect(SPAN_P0).toBeLessThan(ROSE_P0);
    expect(SPAN_P1).toBe(1);
    // one ambient field at a time: the star trails unmount first
    expect(TRAILS_SPAN_P1).toBeLessThan(SPAN_P0);
  });
});

describe("the field", () => {
  const a = buildPetalField();
  const n = L.count;
  /** every petal's value of one packed lane */
  const lane = (arr: Float32Array, k: number) =>
    Array.from({ length: n }, (_, i) => arr[i * 4 + k]);
  const depths = lane(a.aFall, 3);

  it("is deterministic, and dozens of petals, not thousands", () => {
    expect(buildPetalField()).toEqual(a);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(120);
  });

  it("keeps every per-petal constant inside its authored range", () => {
    // fall rate is in cycles per second; depth is in world units, the authored
    // band a fraction of LENS_DIST
    const depth: [number, number] = [L.depth[0] * LENS_DIST, L.depth[1] * LENS_DIST]; // prettier-ignore
    for (const col of lane(a.aFall, 0))
      expect(Math.abs(col), "column").toBeLessThanOrEqual(1);
    const lanes: [string, number[], readonly [number, number]][] = [
      ["phase", lane(a.aFall, 1), [0, 1]],
      ["fall seconds", lane(a.aFall, 2).map((v) => 1 / v), L.fallSeconds],
      ["depth", depths, depth],
      ["sway amp", lane(a.aTurn, 0), L.sway.amp],
      ["sway rate", lane(a.aTurn, 1), L.sway.rate],
      ["spin", lane(a.aTurn, 2).map(Math.abs), L.spin],
      ["flutter", lane(a.aTurn, 3), L.flutter.rate],
      ["size", lane(a.aLook, 0), L.size],
      ["alpha", lane(a.aLook, 1), L.alpha],
      ["tint", lane(a.aLook, 2), [0, 1]],
      ["top", lane(a.aLook, 3), L.top],
    ];
    for (const [name, vs, [lo, hi]] of lanes)
      for (const [i, v] of vs.entries()) {
        expect(v, `petal ${i} ${name}`).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(v, `petal ${i} ${name}`).toBeLessThanOrEqual(hi + 1e-6);
      }
  });

  it("spreads the phases over the cycle and turns both ways", () => {
    // the fall is `fract(phase + t·rate)`: at t = 0 the phases set the spread,
    // so the first frame in the span is a full field
    const q = [0, 0, 0, 0];
    for (const ph of lane(a.aFall, 1)) q[Math.min(3, (ph * 4) | 0)]++;
    for (const c of q) expect(c).toBeGreaterThan(0);
    expect(new Set(lane(a.aTurn, 2).map(Math.sign)).size).toBe(2);
  });

  it("straddles the flower, so petals pass behind it as well as in front", () => {
    expect(LENS_DIST).toBeCloseTo(ENDING_DIST * STORY_R, 12);
    expect(LENS_DIST).toBeGreaterThan(10); // world units, not STORY_R units
    // the authored band and the built field both straddle the lens
    expect(L.depth[0]).toBeLessThan(1);
    expect(L.depth[1]).toBeGreaterThan(1);
    const lo = Math.min(...depths);
    const hi = Math.max(...depths);
    expect(lo).toBeLessThan(LENS_DIST);
    expect(hi).toBeGreaterThan(LENS_DIST);
    // with a real share behind the flower
    const behind = depths.filter((d) => d > LENS_DIST).length / n;
    expect(behind).toBeGreaterThan(0.25);
    expect(behind).toBeLessThan(0.75);
    // inside the camera's near and far planes
    expect(lo).toBeGreaterThan(0.1);
    expect(hi).toBeLessThan(farFor(LENS_DIST, 0));
  });

  it("keeps every screen-fraction term per unit depth — only the depth is in world units", () => {
    // the vertex stage multiplies these by depth, so they are frame fractions
    for (const [name, r] of [
      ["size", L.size],
      ["sway.amp", L.sway.amp],
    ] as const) {
      expect(r[1], name).toBeLessThan(0.1);
      expect(r[0], name).toBeGreaterThan(0);
    }
    expect(Math.abs(L.ground)).toBeLessThan(0.5);
    expect(L.settle).toBeLessThan(0.5);
  });

  it("falls from off screen ONTO a surface inside the frame, at any viewport shape", () => {
    // `top` is in units of the live half-height, which depends on the viewport
    const fov = rangeOf("capsOn").scene.cam.fov;
    expect(L.ground).toBeLessThan(0); // below the flower's middle
    for (const [w, h] of [
      [1440, 810], // laptop
      [900, 900], // square
      [390, 844], // phone
      [320, 1000], // a very narrow one
    ]) {
      const at = `${w}x${h}`;
      // frame half-height and half-width, per unit depth
      const half = Math.tan((fov * Math.PI) / 360) / frameZoom(w, h);
      // every fall starts above the top edge…
      expect(L.top[0] * half, at).toBeGreaterThan(half);
      // …and is fully faded in (at u = 0.05 of the cycle) before reaching it
      const uf = Math.min(1, 0.05 / L.rest.at);
      const drop = uf * (2 - uf);
      expect(L.top[0] * half * (1 - drop) + L.ground * drop, at).toBeGreaterThan(half); // prettier-ignore
      // the ground line is inside the frame, and the spawn band covers its width
      expect(L.ground, at).toBeGreaterThan(-half);
      expect(L.spanX, at).toBeGreaterThan(half * (w / h));
    }
  });

  it("rests ON the standing lens' base — the line is derived, not tuned", () => {
    // ground scales as 1/distance; 0.191 is the base drop at unit distance
    expect(L.ground * ENDING_DIST).toBeCloseTo(-0.191, 9);
    // in world units, at the lens' depth
    expect(L.ground * LENS_DIST).toBeCloseTo(-0.191 * STORY_R, 9);
    // an angle, not world units
    expect(L.ground).toBeGreaterThan(-0.2);
  });

  it("spends a real slice of every cycle lying on the line, then turns over", () => {
    const R = L.rest;
    // the air, the rest and the dissolve partition the cycle in that order
    expect(R.at).toBeGreaterThan(0.5); // most of the cycle is the fall…
    expect(R.at + R.flatten).toBeLessThan(R.out); // …then a real rest…
    expect(R.out).toBeLessThan(1); // …then the dissolve, inside the cycle
    // the dimmest resting petal still clears the alphaTest
    expect(R.alpha * L.alpha[0] * 0.74).toBeGreaterThan(0.1);
    // and it lies flat on the line
    expect(R.squash).toBeGreaterThan(0);
    expect(R.squash).toBeLessThan(0.5);
  });

  it("writes the live frame every drawn frame, so a resize re-aims the fall", () => {
    let reads = 0;
    const f = fakeScene({
      frameHalf: () => {
        reads++;
        return 0.58;
      },
    });
    createStoryPetals(f.scene);
    // inside the bloom every frame reports motion
    for (let i = 0; i < 3; i++) expect(f.evaluate(1)).toBe(true);
    expect(reads).toBe(3);
    // outside it nothing is read and no motion is reported
    expect(f.evaluate(0.2)).toBe(false);
    expect(reads).toBe(3);
  });
});

describe("the draw", () => {
  const field = buildPetalObject(false);
  const mesh = field.mesh;
  const geo = mesh.geometry as THREE.InstancedBufferGeometry;

  it("is ONE instanced draw of a four-vertex template", () => {
    expect(geo.isInstancedBufferGeometry).toBe(true);
    expect(geo.instanceCount).toBe(L.count);
    const pos = geo.getAttribute("position");
    expect(pos.count).toBe(4);
    expect(pos instanceof THREE.InstancedBufferAttribute).toBe(false);
    expect(geo.getIndex()!.count).toBe(6);
    // the template holds the quad's ±1 corners
    for (let v = 0; v < 4; v++) {
      expect(Math.abs(pos.getX(v))).toBe(1);
      expect(Math.abs(pos.getY(v))).toBe(1);
    }
  });

  it("puts everything per-PETAL in an instance attribute", () => {
    for (const name of ["aFall", "aTurn", "aLook"]) {
      const attr = geo.getAttribute(name);
      expect(attr instanceof THREE.InstancedBufferAttribute, name).toBe(true);
      expect(attr.count, name).toBe(L.count);
      expect(attr.itemSize, name).toBe(4);
    }
  });

  it("declares a bounding sphere out to the band's far edge", () => {
    // set explicitly, since the template is a unit quad
    const r = geo.boundingSphere!.radius;
    expect(r).toBeCloseTo(L.depth[1] * LENS_DIST, 9);
    const aFall = geo.getAttribute("aFall") as THREE.InstancedBufferAttribute;
    for (let i = 0; i < aFall.count; i++)
      expect(aFall.getW(i), `petal ${i}`).toBeLessThanOrEqual(r);
  });

  it("draws flat ink that the flower can hide", () => {
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
