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

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

/** one story sample, flattened to plain numbers so a whole pose compares with
 *  toEqual — and EXACTLY, not to a tolerance: the laws below are about the
 *  camera being bit-for-bit still, which a closeTo would not catch. */
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

/** where the camera actually IS: `pos` is the orbit OFFSET from the scene's
 *  target (story/camera.ts), so a scene that slides its target moves the camera
 *  even where `pos` is still. */
const worldAt = (p: number) => {
  const q = poseAt(p);
  return new THREE.Vector3(
    q.target[0] + q.pos[0],
    q.target[1] + q.pos[1],
    q.target[2] + q.pos[2],
  );
};

describe("story camera", () => {
  // The reveal must not include camera movement: the camera is bit-for-bit
  // still for every frame of the crossfade, so the pieces turn on a parked
  // frame. The hold ends at CAM_RELEASE_F (the crossfade's own top) and the
  // chain CREEPS from there — see the release test for the sub-perceptual
  // bound that keeps the reveal reading as camera-still.
  it("holds the sky's parked pose, bit for bit, through the reveal crossfade", () => {
    const park = poseAt(atFrac(tR, 0.5));
    // the park itself is the authored dive pose, so a wrong `first` would show
    expect(park.pos).toEqual([-9, 0, 0]);
    expect(park.fov).toBe(42);
    const release = atFrac(rwR, CAM_RELEASE_F);
    for (let i = 0; i <= 40; i++) {
      const p = rwR.p0 + (release - rwR.p0) * (i / 40);
      expect(poseAt(p), `at rewrap ${(i / 40) * CAM_RELEASE_F}`).toEqual(park);
    }
    // …and the seam INTO it: the trails scene's last frames and the rewrap's
    // first are one unbroken hold, which is what keeps the boundary invisible
    expect(poseAt(tR.p1 - 1e-9)).toEqual(park);
    expect(poseAt(rwR.p0)).toEqual(park);
  });

  // The other half: the move is DELAYED, not deleted, and its start is a CREEP.
  // The chain's ease leaves at zero rate, so between the release and REVEAL_END
  // the displacement stays sub-perceptual and the ending's move is already
  // under way when the fov push and the seat join it.
  it("creeps from the crossfade top and gets all the way to the settle", () => {
    const release = atFrac(rwR, CAM_RELEASE_F);
    const park = worldAt(release);
    // WORLD displacement, not `pos`: the ending slides its orbit target under
    // the same window, so an offset-space ruler no longer measures the camera.
    const off = (p: number) => worldAt(p).distanceTo(park);
    // still exactly still ON the edge, and away on every frame past it,
    // monotonically for the first stretch — further along the chain curves
    // around the lens and distance-from-the-park stops being the right ruler
    expect(off(release)).toBe(0);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const d = off(release + (rwR.p1 - release) * (i / 20) * 0.3);
      expect(d, `sample ${i}`).toBeGreaterThan(prev);
      prev = d;
    }
    // THE CREEP'S BOUND, in world units the camera actually travels: a tripwire
    // against the release drifting earlier into the crossfade or the ease
    // steepening, either of which would put real swing under the reveal.
    expect(off(REVEAL_END)).toBeLessThan(0.6);
    expect(off(release + (REVEAL_END - release) / 4)).toBeLessThan(0.1);
    // the chain still ENDS where it did: the tail scene's own settle pose, at
    // the end of its transit (the hold shortens the move, it never re-aims it)
    const settle = poseAt(atFrac(capR, capR.scene.transit));
    expect(settle.fov).toBeCloseTo(30, 6);
    expect(settle.pos[0]).toBeCloseTo(0, 6);
    expect(settle.pos[1]).toBeCloseTo(0, 6);
    expect(settle.pos[2]).toBeCloseTo(capR.scene.cam.pos[2] * 11, 6);
  });

  // THE ENDING'S VERTICAL FRAMING is the orbit TARGET, not `ys`: the rewrap
  // parks with the target up the bore and the last scene slides it home, so the
  // frame comes down with the pieces.
  describe("the ending frames on a sliding orbit target", () => {
    it("keeps the lens dead centre through the face-on pull-back", () => {
      // an on-axis target shift is only DISTANCE: the origin stays on the
      // camera→target ray, so the leg is a pure dolly with no reframing.
      for (let i = 0; i <= 400; i++) {
        const p = rwR.p0 + (rwR.p1 - rwR.p0) * (i / 400);
        const { target } = poseAt(p);
        const cam = worldAt(p);
        const dir = new THREE.Vector3(...target).sub(cam).normalize();
        const toLens = cam.clone().negate();
        const perp = toLens.sub(dir.multiplyScalar(toLens.dot(dir))).length();
        expect(perp, `rewrap ${i / 400}`).toBeLessThan(1e-9);
      }
      // …and the target is genuinely UP the bore, so the park frames the lens
      // from nearer than its orbit radius — the reach the pose is authored for
      const park = poseAt(atFrac(rwR, 0.99));
      const radius = Math.hypot(...park.pos);
      const dist = worldAt(atFrac(rwR, 0.99)).length();
      expect(radius - dist).toBeGreaterThan(2);
      expect(dist).toBeCloseTo(radius - park.target[0], 9);
    });

    it("slides the frame down with the pieces, and lands on the lens", () => {
      // held across the scene boundary, then walked home over the one orbit
      const from = poseAt(rwR.p1 - 1e-9).target;
      expect(from[0]).toBeGreaterThan(0);
      expect(poseAt(capR.p0).target).toEqual(from);
      const end = capR.scene.transit;
      let prev = Infinity;
      for (let i = 0; i <= 40; i++) {
        const t = poseAt(atFrac(capR, (end * i) / 40)).target;
        expect(t[1], `capsOn ${(end * i) / 40}`).toBe(0);
        expect(t[2], `capsOn ${(end * i) / 40}`).toBe(0);
        expect(t[0]).toBeLessThanOrEqual(prev);
        prev = t[0];
      }
      // mid-MOVE it is in FLIGHT: with no target the camera would turn about a
      // static centre and the descent would have no vertical move. The sample
      // is the MOVE's midpoint, not the scene's — a scene fraction would land
      // inside the flatten's camHold and measure nothing.
      const hold = capR.scene.camHold ?? 0;
      const mid = poseAt(atFrac(capR, (hold + end) / 2)).target[0];
      expect(mid).toBeGreaterThan(0.2 * from[0]);
      expect(mid).toBeLessThan(0.8 * from[0]);
      // …and the slide runs along the landing pose's own screen-up axis, which
      // is what makes it read as the frame descending rather than tracking
      const land = poseAt(atFrac(capR, 0.7));
      expect(land.up).toEqual([1, 0, 0]);
      expect(land.target).toEqual([0, 0, 0]);
    });

    it("turns the OTHER way round the column — onto the lens' −Z side", () => {
      // THE DESCENT'S DIRECTION: from dead astern the quarter-orbit swings to
      // −Z, so the standing column turns the other way and the reader follows
      // the pieces down from that side.
      const land = poseAt(atFrac(capR, 0.7));
      expect(land.pos[2]).toBeLessThan(0);
      expect(land.pos[0]).toBeCloseTo(0, 9);
      expect(Math.hypot(...land.pos)).toBeCloseTo(
        Math.hypot(...capR.scene.cam.pos) * 11,
        6,
      );
      expect(land.fov).toBe(30);
      // ONE quarter turn, monotone, no reversal and no long way round: the
      // azimuth walks 180° → 270° and stops
      const azOf = (q: number[]) => {
        const a = (Math.atan2(q[2], q[0]) * 180) / Math.PI;
        return a < 0 ? a + 360 : a;
      };
      let prev = 180;
      for (let i = 0; i <= 60; i++) {
        const az = azOf(
          poseAt(atFrac(capR, (capR.scene.transit * i) / 60)).pos,
        );
        expect(az, `capsOn ${i / 60}`).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(az).toBeLessThanOrEqual(270 + 1e-9);
        prev = az;
      }
      expect(prev).toBeCloseTo(270, 6);
    });
  });

  // THE ENDING OPENS FLAT. The flatten is a fov change paired with a pullback
  // (story/camera.ts ORTHO_FOV + `back`), authored on the rewrap's own window
  // and closed on the descent's (story/story.ts `orthoIn`/`orthoOut`), so ONE
  // flat frame spans the scene boundary and the depth is back before the turn.
  //
  // What is pinned here is the SCHEDULE — where the blend opens, where it is
  // spent, and that the pose is parked under it. Not its size on screen: the
  // pullback is matched to the fov, so `|pos| · tan(fov/2)` is an identity. The
  // no-pop property is measured over the real cloud in story-ending.test.ts.
  describe("the ending's flat frame", () => {
    it("is wholly flat at the park and wholly flat across the boundary", () => {
      expect(rwR.scene.orthoIn).toBeDefined();
      expect(capR.scene.orthoOut).toBeDefined();
      const flat = poseAt(atFrac(rwR, 0.99));
      expect(flat.fov).toBeCloseTo(3, 9); // ORTHO_FOV, reached
      expect(Math.hypot(...flat.pos)).toBeGreaterThan(9 * 11 * 2.5); // the ~10× pullback
      // …and the seam: the last frame of the rewrap and the first of the
      // descent are the same projection, or the boundary is a cut
      expect(poseAt(rwR.p1 - 1e-9).fov).toBeCloseTo(3, 9);
      expect(poseAt(capR.p0).fov).toBeCloseTo(3, 9);
    });

    it("blends out on a PARKED pose — the projection is the only thing moving", () => {
      // the blend-out runs over the descent's camHold, and the camera is
      // bit-still for every frame of it: same offset, same target, same up, so
      // what the reader sees change is the projection and nothing else
      const hold = capR.scene.camHold ?? 0;
      const held = poseAt(capR.p0);
      for (let i = 0; i <= 40; i++) {
        const q = poseAt(atFrac(capR, (hold * i) / 40));
        const at = `capsOn ${(hold * i) / 40}`;
        expect(q.target, at).toEqual(held.target);
        expect(q.up, at).toEqual(held.up);
        expect(q.xs, at).toBe(held.xs);
        // the offset only ever changes by the pullback, i.e. along its own line
        expect(
          new THREE.Vector3(...q.pos)
            .normalize()
            .dot(new THREE.Vector3(...held.pos).normalize()),
          at,
        ).toBeCloseTo(1, 12);
      }
      // …and the projection really does walk the whole way over that hold
      expect(poseAt(capR.p0).fov).toBeCloseTo(3, 9);
      expect(poseAt(atFrac(capR, hold)).fov).toBe(30);
    });

    it("arrives at the flat frame while the pull-back is still running", () => {
      // the flatten has to be SPENT before the dolly parks, so the reader gets
      // a still, flat frame to sit on rather than a projection still draining
      // as the scene hands over
      expect(rwR.scene.orthoIn![1]).toBeLessThan(rwR.scene.transit);
      expect(poseAt(atFrac(rwR, rwR.scene.orthoIn![1])).fov).toBe(3);
    });

    it("is back to perspective BEFORE the descent's turn opens — by a BREATH", () => {
      const hold = capR.scene.camHold ?? 0;
      const blendEnd = capR.scene.orthoOut![1];
      // SEQUENCED: the projection is wholly back before anything moves…
      expect(blendEnd).toBeLessThanOrEqual(hold);
      // …and NOT HELD after it is: the gap between the blend's last frame and
      // the turn's first is bounded, not just signed.
      expect(hold - blendEnd).toBeLessThanOrEqual(0.011);
      // the turn's own first frame, and everything past it, is perspective
      for (const f of [hold, 0.25, 0.44, 0.7, 1])
        expect(poseAt(atFrac(capR, f)).fov, `capsOn ${f}`).toBe(30);
    });
  });

  // The hold is authored ONCE (story.ts CAM_RELEASE_F); this pins the camera's
  // copy to the constant rather than to a number that happens to match.
  it("takes its hold from the story's own constant", () => {
    expect(rwR.scene.camHold).toBe(CAM_RELEASE_F);
    expect(CAM_RELEASE_F).toBeLessThan(0.25); // strictly inside the old edge
  });

  // THE PRECOMPUTE LAW: the per-scene plans sampleStory rides are
  // resolved ONCE at module load, so revisiting any p after sweeping the story
  // must reproduce the first visit bit for bit, or the plans hold per-call
  // state.
  it("is a pure function of p — revisits reproduce first visits bit for bit", () => {
    const ps: number[] = [];
    for (let i = 0; i <= 400; i++) ps.push(i / 400);
    for (const r of RANGES) ps.push(r.p0, Math.max(0, r.p1 - 1e-9));
    const first = ps.map(poseAt);
    // stress the plans: a full backward sweep, then deterministic shuffled jumps
    for (let i = ps.length - 1; i >= 0; i--) poseAt(ps[i]);
    const order = [...ps.keys()].sort(
      (a, b) => ((a * 2654435761) % 97) - ((b * 2654435761) % 97),
    );
    for (const k of order)
      expect(poseAt(ps[k]), `p=${ps[k]}`).toEqual(first[k]);
  });

  // THE CHAPTER'S CAMERA LAW ("ONE ARC"): from the zoom to the dive's park the
  // camera wears the world up-vector and swings its whole 90° inside the PEEL —
  // so every later scene sits on the dive's azimuth and the movement from there
  // is the lens' own.
  describe("the zoom→dive chapter is one arc", () => {
    const CHAPTER = ["zoom", "peel", "cards", "internals", "flythrough"];
    const rows = CHAPTER.map((id) => rangeOf(id).scene);
    /** a settle pose's azimuth about the world vertical, degrees */
    const azOf = (pos: [number, number, number]) =>
      (Math.atan2(pos[2], pos[0]) * 180) / Math.PI;

    it("wears the world up-vector — no authored roll anywhere in it", () => {
      for (const s of rows)
        expect(s.cam.up, `${s.id} settle up`).toEqual([0, 1, 0]);
    });

    it("swings 90° to 180° in ONE leg and never comes back", () => {
      const az = rows.map((s) => azOf(s.cam.pos));
      expect(az[0], "zoom — the side profile").toBeCloseTo(90, 6);
      // the peel is the leg and it ends DEAD ASTERN, on the lens' mount, which
      // is the pose the cards scene's turn opens from
      expect(az[1], "peel — the lens' back").toBeCloseTo(180, 6);
      // …and nothing after it moves round, so there is no reversal to make
      for (let k = 2; k < az.length; k++)
        expect(az[k], `${rows[k].id} against the peel`).toBeCloseTo(180, 6);
    });
  });

  it("refuses a camHold that could not do anything", () => {
    const one = (extra: Partial<StoryScene>): StoryScene[] =>
      STORY.map((s) => (s.id === "trails" ? { ...s, ...extra } : s));
    // trails has transit 0 — a hold there would be silently dead
    expect(() => validateStory(one({ camHold: 0.25 }))).toThrow(/camHold/);
    expect(() => validateStory(one({ camHold: 1 }))).toThrow(/camHold/);
    expect(() => validateStory(one({ camHold: -0.1 }))).toThrow(/camHold/);
    // the shipped table is the case that must pass
    expect(() => validateStory(RANGES.map((r) => r.scene))).not.toThrow();
  });
});

describe("the dive's framing over the story pose", () => {
  const W = 1440;
  const H = 900;
  /** one framed camera; `dive` undefined is the story's own framing */
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
  // a scene with a real horizontal park, so the scaling laws are not vacuous
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
    // a null fov is the story's own, whatever the mix says
    expect(framed(dive({ fov: null, fovMix: 1 })).cam.fov).toBe(story.cam.fov);
  });
});
