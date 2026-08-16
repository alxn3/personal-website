import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { sampleStory } from "../camera";
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

describe("story camera", () => {
  // THE OWNER'S TWO NOTES, AS ONE LAW. First: "the reveal shouldn't include
  // camera movement" — the camera is bit-for-bit still for every frame of the
  // reveal's crossfade (rewrap-local [0.06, 0.16], story/fly.ts flyRevealAt),
  // so the pieces turn on a parked frame. Second, the correction that moved
  // the hold's far edge: "the camera movement from the end of trails to the
  // start of reassemble is very jarring… smoothed or just incorporated into
  // reassemble" — the chain used to stay parked clear through REVEAL_END and
  // then onset TOGETHER with the fov push and the seat, a dead stop into a
  // fast move. The hold now ends at CAM_RELEASE_F (the crossfade's own top)
  // and the chain CREEPS from there — see the release test below for the
  // sub-perceptual bound that keeps the reveal reading as camera-still.
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

  // The other half of the same law: the move is DELAYED, not deleted — and its
  // start is a CREEP, not an onset. The chain's ease leaves at zero rate, so
  // between the release and REVEAL_END the camera is moving in the analytic
  // sense while still reading as parked: the whole displacement across the
  // collapse stays sub-perceptual, which is what lets the ending's move be
  // already under way when the fov push and the seat join it (the de-stack).
  it("creeps from the crossfade top and gets all the way to the settle", () => {
    const release = atFrac(rwR, CAM_RELEASE_F);
    const park = poseAt(release);
    const off = (p: number) =>
      new THREE.Vector3(...poseAt(p).pos).distanceTo(
        new THREE.Vector3(...park.pos),
      );
    // still exactly still ON the edge, and away on every frame past it —
    // monotonically for the first stretch (the chain leaves the park and does
    // not come back to it; further along it curves around the lens, so the
    // distance from the park is no longer the right ruler — 0.3 of the scene's
    // remainder stays inside the outbound leg now that the rewrap holds a
    // larger share of the fused chain's span)
    expect(off(release)).toBe(0);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const d = off(release + (rwR.p1 - release) * (i / 20) * 0.3);
      expect(d, `sample ${i}`).toBeGreaterThan(prev);
      prev = d;
    }
    // THE CREEP'S BOUND. The chain's ease leaves at zero rate (smoothstep
    // foot — there is no frame on which motion begins as an event), and by
    // REVEAL_END — with the collapse, the roll and the ink return all in full
    // motion over it — it has covered ~1.55 world units (measured 1.5479).
    //
    // THE SWING GREW, and the tripwire's re-base 1.5 → 1.7 accommodates a real
    // increase rather than a bookkeeping one. Measured against the old map
    // rows, under either consistent pivot: 1.2747 → 1.5479 world units, 4.50°
    // → 5.85° about the subject (the dolly, 12.5 units out), 6.29° → 8.07°
    // about the orbit target — ~29 % on all three. The cause is mechanical and
    // was unavoidable: REVEAL_END − CAM_RELEASE grew 0.0086 → 0.0104 in p
    // (+21 %) because the rewrap scene grew 21 % with the fluid-transition
    // rework while both fractions stayed exactly where they were, so the same
    // local window sits deeper in the ease. Headroom against the bound is now
    // 9.8 %, down from 15 %.
    //
    // What did NOT move is the beat that must read as camera-still: the
    // crossfade, where the pieces alone turn on a parked frame, is bit-for-bit
    // still (test above — the pose at CAM_RELEASE is the park exactly). That
    // is the "incorporated into reassemble" shape the owner chose. The bound
    // is a tripwire against the release drifting EARLIER into that crossfade
    // or the ease steepening, either of which would put real swing under the
    // reveal.
    expect(off(REVEAL_END)).toBeLessThan(1.7);
    expect(off(release + (REVEAL_END - release) / 4)).toBeLessThan(0.1);
    // the chain still ENDS where it did: the tail scene's own settle pose, at
    // the end of its transit (the hold shortens the move, it never re-aims it)
    const settle = poseAt(atFrac(capR, capR.scene.transit));
    expect(settle.fov).toBeCloseTo(30, 6);
    expect(settle.pos[0]).toBeCloseTo(0, 6);
    expect(settle.pos[1]).toBeCloseTo(0, 6);
    expect(settle.pos[2]).toBeCloseTo(capR.scene.cam.pos[2] * 11, 6);
  });

  // The hold is authored ONCE (story/story.ts CAM_RELEASE_F) and read here and
  // by the camera; this pins the camera's copy of it to the constant rather
  // than to a number that happens to match today. (Its coupling to the reveal
  // crossfade's top edge is pinned in story-fly.test.ts, which can import the
  // lazy fly module.)
  it("takes its hold from the story's own constant", () => {
    expect(rwR.scene.camHold).toBe(CAM_RELEASE_F);
    expect(CAM_RELEASE_F).toBeLessThan(0.25); // strictly inside the old edge
  });

  // THE PRECOMPUTE LAW (perf batch): the per-scene paths/chains sampleStory
  // rides are resolved ONCE at module load from the static STORY table, so the
  // function must stay a pure function of p — revisiting any p after sweeping
  // the whole story (forward, backward, shuffled cross-scene jumps) must
  // reproduce the first visit bit for bit, or the precomputed plans have
  // picked up per-call state. (The refactor itself was verified bit-identical
  // against the per-frame-rebuild implementation over a 4000-point sweep; this
  // pin is what keeps the cache honest from here on.)
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

  it("refuses a camHold that could not do anything", () => {
    const one = (extra: Partial<StoryScene>): StoryScene[] =>
      STORY.map((s) => (s.id === "trails" ? { ...s, ...extra } : s));
    // trails is not a linked head — a hold there would be silently dead
    expect(() => validateStory(one({ camHold: 0.25 }))).toThrow(/camHold/);
    expect(() => validateStory(one({ camHold: 1, linkNext: true }))).toThrow(
      /camHold/,
    );
    expect(() => validateStory(one({ camHold: -0.1, linkNext: true }))).toThrow(
      /camHold/,
    );
    // the shipped table is the case that must pass
    expect(() => validateStory(RANGES.map((r) => r.scene))).not.toThrow();
  });
});
