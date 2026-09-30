import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { applyStoryFraming, sampleStory } from "../camera";
import {
  CAM_RELEASE_F,
  RANGES,
  REVEAL_END,
  STORY,
  atFrac,
  rangeOf,
  validateStory,
  type StoryScene,
} from "../story";

const trailsScene = rangeOf("trails");
const rewrapScene = rangeOf("rewrap");
const bloomScene = rangeOf("capsOn");

/** One story sample as plain numbers, so poses compare exactly with toEqual. */
const poseAt = (p: number) => {
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const target = new THREE.Vector3();
  const { fov, xs, ys } = sampleStory(p, pos, up, target);
  return {
    fov,
    xs,
    ys,
    pos: pos.toArray(),
    up: up.toArray(),
    target: target.toArray(),
  };
};

/** The camera's world position (target + orbit offset). */
const worldAt = (p: number) => {
  const q = poseAt(p);
  return new THREE.Vector3(
    q.target[0] + q.pos[0],
    q.target[1] + q.pos[1],
    q.target[2] + q.pos[2],
  );
};

describe("story camera", () => {
  // The camera stays exactly still through the reveal crossfade, until
  // CAM_RELEASE_F.
  it("holds the sky's parked pose, bit for bit, through the reveal crossfade", () => {
    const park = poseAt(atFrac(trailsScene, 0.5));
    // the parked pose is the dive's
    expect(park.pos).toEqual([-9, 0, 0]);
    expect(park.fov).toBe(42);
    const release = atFrac(rewrapScene, CAM_RELEASE_F);
    for (let i = 0; i <= 40; i++) {
      const p = rewrapScene.p0 + (release - rewrapScene.p0) * (i / 40);
      expect(poseAt(p), `at rewrap ${(i / 40) * CAM_RELEASE_F}`).toEqual(park);
    }
    // no jump across the trails → rewrap boundary
    expect(poseAt(trailsScene.p1 - 1e-9)).toEqual(park);
    expect(poseAt(rewrapScene.p0)).toEqual(park);
  });

  // After the release the camera eases off from rest and still reaches the
  // final pose.
  it("creeps from the crossfade top and gets all the way to the settle", () => {
    const release = atFrac(rewrapScene, CAM_RELEASE_F);
    const park = worldAt(release);
    // world distance, since the orbit target also moves
    const off = (p: number) => worldAt(p).distanceTo(park);
    // still on the edge, then moving steadily away over the first stretch
    expect(off(release)).toBe(0);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const d = off(release + (rewrapScene.p1 - release) * (i / 20) * 0.3);
      expect(d, `sample ${i}`).toBeGreaterThan(prev);
      prev = d;
    }
    // only a small creep before the reveal ends
    expect(off(REVEAL_END)).toBeLessThan(0.6);
    expect(off(release + (REVEAL_END - release) / 4)).toBeLessThan(0.1);
    // and it ends on the last scene's pose at the end of its transit
    const settle = poseAt(atFrac(bloomScene, bloomScene.scene.transit));
    expect(settle.fov).toBeCloseTo(30, 6);
    expect(settle.pos[0]).toBeCloseTo(0, 6);
    expect(settle.pos[1]).toBeCloseTo(0, 6);
    expect(settle.pos[2]).toBeCloseTo(bloomScene.scene.cam.pos[2] * 11, 6);
  });

  // The rewrap parks with the orbit target up the bore; the last scene slides
  // it home, so the frame comes down with the pieces.
  describe("the ending frames on a sliding orbit target", () => {
    it("keeps the lens dead centre through the face-on pull-back", () => {
      // the lens stays on the camera → target line throughout
      for (let i = 0; i <= 400; i++) {
        const p =
          rewrapScene.p0 + (rewrapScene.p1 - rewrapScene.p0) * (i / 400);
        const { target } = poseAt(p);
        const cam = worldAt(p);
        const dir = new THREE.Vector3(...target).sub(cam).normalize();
        const toLens = cam.clone().negate();
        const perp = toLens.sub(dir.multiplyScalar(toLens.dot(dir))).length();
        expect(perp, `rewrap ${i / 400}`).toBeLessThan(1e-9);
      }
      // the target is up the bore, so the camera is nearer than its radius
      const park = poseAt(atFrac(rewrapScene, 0.99));
      const radius = Math.hypot(...park.pos);
      const dist = worldAt(atFrac(rewrapScene, 0.99)).length();
      expect(radius - dist).toBeGreaterThan(2);
      expect(dist).toBeCloseTo(radius - park.target[0], 9);
    });

    it("slides the frame down with the pieces, and lands on the lens", () => {
      // held across the boundary, then moved home during the orbit
      const from = poseAt(rewrapScene.p1 - 1e-9).target;
      expect(from[0]).toBeGreaterThan(0);
      expect(poseAt(bloomScene.p0).target).toEqual(from);
      const end = bloomScene.scene.transit;
      let prev = Infinity;
      for (let i = 0; i <= 40; i++) {
        const t = poseAt(atFrac(bloomScene, (end * i) / 40)).target;
        expect(t[1], `capsOn ${(end * i) / 40}`).toBe(0);
        expect(t[2], `capsOn ${(end * i) / 40}`).toBe(0);
        expect(t[0]).toBeLessThanOrEqual(prev);
        prev = t[0];
      }
      // halfway through the move the target is halfway home
      const hold = bloomScene.scene.camHold ?? 0;
      const mid = poseAt(atFrac(bloomScene, (hold + end) / 2)).target[0];
      expect(mid).toBeGreaterThan(0.2 * from[0]);
      expect(mid).toBeLessThan(0.8 * from[0]);
      // it slides along the landing pose's screen-up axis
      const land = poseAt(atFrac(bloomScene, 0.7));
      expect(land.up).toEqual([1, 0, 0]);
      expect(land.target).toEqual([0, 0, 0]);
    });

    it("turns the OTHER way round the column — onto the lens' −Z side", () => {
      // the quarter-orbit swings from directly behind to the −Z side
      const land = poseAt(atFrac(bloomScene, 0.7));
      expect(land.pos[2]).toBeLessThan(0);
      expect(land.pos[0]).toBeCloseTo(0, 9);
      expect(Math.hypot(...land.pos)).toBeCloseTo(
        Math.hypot(...bloomScene.scene.cam.pos) * 11,
        6,
      );
      expect(land.fov).toBe(30);
      // one monotone quarter turn: azimuth 180° → 270°
      const azOf = (q: number[]) => {
        const a = (Math.atan2(q[2], q[0]) * 180) / Math.PI;
        return a < 0 ? a + 360 : a;
      };
      let prev = 180;
      for (let i = 0; i <= 60; i++) {
        const az = azOf(
          poseAt(atFrac(bloomScene, (bloomScene.scene.transit * i) / 60)).pos,
        );
        expect(az, `capsOn ${i / 60}`).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(az).toBeLessThanOrEqual(270 + 1e-9);
        prev = az;
      }
      expect(prev).toBeCloseTo(270, 6);
    });
  });

  // The ending goes flat in the rewrap (orthoIn), stays flat across the
  // boundary, and returns to perspective (orthoOut) before the turn.
  describe("the ending's flat frame", () => {
    it("is wholly flat at the park and wholly flat across the boundary", () => {
      expect(rewrapScene.scene.orthoIn).toBeDefined();
      expect(bloomScene.scene.orthoOut).toBeDefined();
      const flat = poseAt(atFrac(rewrapScene, 0.99));
      expect(flat.fov).toBeCloseTo(3, 9); // ORTHO_FOV, reached
      expect(Math.hypot(...flat.pos)).toBeGreaterThan(9 * 11 * 2.5); // the ~10× pullback
      // same projection on both sides of the boundary
      expect(poseAt(rewrapScene.p1 - 1e-9).fov).toBeCloseTo(3, 9);
      expect(poseAt(bloomScene.p0).fov).toBeCloseTo(3, 9);
    });

    it("blends out on a PARKED pose — the projection is the only thing moving", () => {
      // during camHold only the projection changes
      const hold = bloomScene.scene.camHold ?? 0;
      const held = poseAt(bloomScene.p0);
      for (let i = 0; i <= 40; i++) {
        const q = poseAt(atFrac(bloomScene, (hold * i) / 40));
        const at = `capsOn ${(hold * i) / 40}`;
        expect(q.target, at).toEqual(held.target);
        expect(q.up, at).toEqual(held.up);
        expect(q.xs, at).toBe(held.xs);
        // the offset changes only in length (the pull-back)
        expect(
          new THREE.Vector3(...q.pos)
            .normalize()
            .dot(new THREE.Vector3(...held.pos).normalize()),
          at,
        ).toBeCloseTo(1, 12);
      }
      // and the projection goes all the way back in that time
      expect(poseAt(bloomScene.p0).fov).toBeCloseTo(3, 9);
      expect(poseAt(atFrac(bloomScene, hold)).fov).toBe(30);
    });

    it("arrives at the flat frame while the pull-back is still running", () => {
      // fully flat before the pull-back parks
      expect(rewrapScene.scene.orthoIn![1]).toBeLessThan(
        rewrapScene.scene.transit,
      );
      expect(
        poseAt(atFrac(rewrapScene, rewrapScene.scene.orthoIn![1])).fov,
      ).toBe(3);
    });

    it("is back to perspective just before the descent's turn opens", () => {
      const hold = bloomScene.scene.camHold ?? 0;
      const blendEnd = bloomScene.scene.orthoOut![1];
      // back to perspective before the camera moves...
      expect(blendEnd).toBeLessThanOrEqual(hold);
      // ...with only a short gap before the turn
      expect(hold - blendEnd).toBeLessThanOrEqual(0.011);
      for (const f of [hold, 0.25, 0.44, 0.7, 1])
        expect(poseAt(atFrac(bloomScene, f)).fov, `capsOn ${f}`).toBe(30);
    });
  });

  it("is a pure function of p — revisits reproduce first visits bit for bit", () => {
    const ps: number[] = [];
    for (let i = 0; i <= 400; i++) ps.push(i / 400);
    for (const r of RANGES) ps.push(r.p0, Math.max(0, r.p1 - 1e-9));
    const first = ps.map(poseAt);
    // a backward sweep, then deterministic shuffled jumps
    for (let i = ps.length - 1; i >= 0; i--) poseAt(ps[i]);
    const order = [...ps.keys()].sort(
      (a, b) => ((a * 2654435761) % 97) - ((b * 2654435761) % 97),
    );
    for (const k of order)
      expect(poseAt(ps[k]), `p=${ps[k]}`).toEqual(first[k]);
  });

  it("keeps world up and swings 90° to 180° once, from the zoom to the dive", () => {
    const rows = ["zoom", "peel", "cards", "internals", "flythrough"].map(
      (id) => rangeOf(id).scene,
    );
    // each settle pose's azimuth about world up, degrees
    const az = rows.map(
      (s) => (Math.atan2(s.cam.pos[2], s.cam.pos[0]) * 180) / Math.PI,
    );
    for (const s of rows) expect(s.cam.up, s.id).toEqual([0, 1, 0]);
    expect(az[0], "zoom — the side profile").toBeCloseTo(90, 6);
    // the peel ends directly behind the lens, and every later scene stays
    for (let k = 1; k < az.length; k++)
      expect(az[k], rows[k].id).toBeCloseTo(180, 6);
  });

  it("refuses a camHold that could not do anything", () => {
    const one = (extra: Partial<StoryScene>): StoryScene[] =>
      STORY.map((s) => (s.id === "trails" ? { ...s, ...extra } : s));
    // trails has transit 0, so any hold there is invalid
    expect(() => validateStory(one({ camHold: 0.25 }))).toThrow(/camHold/);
    expect(() => validateStory(one({ camHold: 1 }))).toThrow(/camHold/);
    expect(() => validateStory(one({ camHold: -0.1 }))).toThrow(/camHold/);
    expect(() => validateStory(RANGES.map((r) => r.scene))).not.toThrow();
  });
});

describe("the dive's framing over the story pose", () => {
  const W = 1440;
  const H = 900;
  /** one framed camera; no `dive` = the story's own framing */
  const framedAt = (
    p: number,
    dive?: Parameters<typeof applyStoryFraming>[8],
  ) => {
    const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    const target = new THREE.Vector3();
    const sample = sampleStory(p, pos, up, target);
    const builds = vi.spyOn(cam, "updateProjectionMatrix");
    applyStoryFraming(cam, sample, pos, up, target, W, H, 1, dive);
    return { cam, sample, builds: builds.mock.calls.length };
  };
  // a p with a real horizontal park
  const p = RANGES.map((r) => atFrac(r, 0.95)).find(
    (q) => framedAt(q).cam.view!.offsetX !== 0,
  )!;
  const framed = (dive?: Parameters<typeof applyStoryFraming>[8]) =>
    framedAt(p, dive);
  const dive = (over: Partial<NonNullable<Parameters<typeof framed>[0]>>) => ({
    centre: 0,
    fov: null,
    fovMix: 0,
    far: (d: number) => d,
    ...over,
  });

  it("builds the projection exactly once per frame", () => {
    expect(framed().builds).toBe(1);
    expect(framed(dive({ centre: 0.5, fov: 80, fovMix: 0.5 })).builds).toBe(1);
  });

  it("scales the park toward zero by `centre`: half at 0.5, gone at 1", () => {
    const story = framed().cam.view!;
    expect(story.offsetX).not.toBe(0);
    const half = framed(dive({ centre: 0.5 })).cam.view!;
    expect(half.offsetX).toBe(story.offsetX * 0.5);
    expect(half.offsetY).toBe(story.offsetY * 0.5);
    const gone = framed(dive({ centre: 1 })).cam.view!;
    expect(Math.abs(gone.offsetX)).toBe(0);
    expect(Math.abs(gone.offsetY)).toBe(0);
  });

  it("ramps the fov by `fovMix` without moving the park, and follows `far`", () => {
    const story = framed();
    const ramped = framed(dive({ fov: 80, fovMix: 0.25, far: () => 123 }));
    expect(ramped.cam.fov).toBe(story.cam.fov + (80 - story.cam.fov) * 0.25);
    expect(ramped.cam.view!.offsetX).toBe(story.cam.view!.offsetX);
    expect(ramped.cam.view!.offsetY).toBe(story.cam.view!.offsetY);
    expect(ramped.cam.far).toBe(123);
    // a null fov keeps the story's
    expect(framed(dive({ fov: null, fovMix: 1 })).cam.fov).toBe(story.cam.fov);
  });
});
