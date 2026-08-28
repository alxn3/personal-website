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
  // TWO NOTES, AS ONE LAW. First: the reveal must not include camera movement
  // — the camera is bit-for-bit still for every frame of the reveal's
  // crossfade (rewrap-local [0.06, 0.16], story/fly.ts flyRevealAt), so the
  // pieces turn on a parked frame. Second, the correction that moved the
  // hold's far edge: the camera move from the end of trails to the start of
  // reassemble read as jarring and had to be smoothed into reassemble — the
  // chain used to stay parked clear through REVEAL_END and
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
    const park = worldAt(release);
    // WORLD displacement, not `pos`: the ending slides its orbit target under
    // the same window, so an offset-space ruler no longer measures the camera.
    const off = (p: number) => worldAt(p).distanceTo(park);
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
    // THE CREEP'S BOUND, in world units the camera actually travels. The
    // chain's ease leaves at zero rate (smoothstep foot — there is no frame on
    // which motion begins as an event), so the whole displacement under the
    // reveal stays sub-perceptual even with the collapse, the roll and the ink
    // return in full motion over it.
    //
    // What must read as camera-still is the crossfade itself, and that is
    // bit-for-bit still (test above — the pose at CAM_RELEASE is the park
    // exactly). This bound is the tripwire against the release drifting
    // EARLIER into that crossfade or the ease steepening, either of which
    // would put real swing under the reveal.
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
  // frame comes down with the pieces. Nothing else in the suite observes a
  // target, so these are the two laws that make the rewrap row's own
  // `target` load-bearing rather than decorative.
  describe("the ending frames on a sliding orbit target", () => {
    it("keeps the lens dead centre through the face-on pull-back", () => {
      // an on-axis target shift is only DISTANCE: the origin stays on the
      // camera→target ray for every frame, which is what lets the whole leg be
      // a pure dolly with no reframing under the reveal.
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
      // mid-MOVE it is in FLIGHT — with no target the camera would turn about a
      // static centre and the descent would have no vertical move. The sample
      // is the move's own midpoint, not the scene's: the flatten's blend now
      // holds the camera still over the scene's first `camHold`, and a fraction
      // of the range would land inside that hold and measure nothing.
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
      // THE DESCENT'S DIRECTION. From dead astern the quarter-orbit swings to
      // −Z, so the standing column turns the opposite way and the reader
      // follows the pieces down from that side. Everything else about the
      // hand-off frame — its distance, its fov, its up-vector and its target —
      // is the frame the bloom has always played in; only the side moved.
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
  // WHAT IS PINNED HERE IS THE SCHEDULE — where the blend opens, where it is
  // spent, and that the pose is parked under it. NOT its size on screen: the
  // pullback is matched to the fov, so `|pos| · tan(fov/2)` is an identity and
  // a law on it cannot fail for any ortho schedule at all. The no-pop property
  // is a property of the FIGURE, and it is measured over the real cloud through
  // the real projection in story-ending.test.ts.
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
      // …and NOT HELD after it is. The owner's note on this beat was that the
      // view sits too long once it is no longer flat, so the gap between the
      // blend's last frame and the turn's first is bounded, not just signed.
      expect(hold - blendEnd).toBeLessThanOrEqual(0.011);
      // the turn's own first frame, and everything past it, is perspective
      for (const f of [hold, 0.25, 0.44, 0.7, 1])
        expect(poseAt(atFrac(capR, f)).fov, `capsOn ${f}`).toBe(30);
    });
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

  // THE CHAPTER'S CAMERA LAW (story/story.ts peel row: "ONE ARC, NO
  // WAYPOINTS"): from the zoom to the dive's park the camera wears the world
  // up-vector, routes through no waypoint, and only ever swings FORWARD in
  // azimuth — and it spends the whole 90° in the PEEL, which is what puts the
  // lens' back to the reader for the hand-over and leaves every scene after it
  // on the dive's own azimuth. The MOVEMENT from there on is the lens' own (the
  // peel's bore roll, then story/peelcards.ts peelTurnAt), so a re-authored up,
  // a re-added via or an azimuth reversal would put camera roll or a swoop back
  // under it.
  describe("the zoom→dive chapter is one arc", () => {
    const CHAPTER = ["zoom", "peel", "cards", "internals", "flythrough"];
    const rows = CHAPTER.map((id) => rangeOf(id).scene);
    /** a settle pose's azimuth about the world vertical, degrees */
    const azOf = (pos: [number, number, number]) =>
      (Math.atan2(pos[2], pos[0]) * 180) / Math.PI;

    it("wears the world up-vector — no authored roll anywhere in it", () => {
      for (const s of rows) {
        expect(s.cam.up, `${s.id} settle up`).toEqual([0, 1, 0]);
        for (const v of s.via ?? [])
          expect(v.up, `${s.id} via up`).toEqual([0, 1, 0]);
      }
    });

    it("routes through no waypoints", () => {
      for (const s of rows) expect(s.via, `${s.id} via`).toBeUndefined();
    });

    it("swings 90° to 180° in ONE leg and never comes back", () => {
      const az = rows.map((s) => azOf(s.cam.pos));
      expect(az[0], "zoom — the side profile").toBeCloseTo(90, 6);
      // the peel is the leg, and it ends DEAD ASTERN: the scene hands over on
      // the lens' mount, which is the pose the cards scene's turn opens from
      expect(az[1], "peel — the lens' back").toBeCloseTo(180, 6);
      // …and nothing after it moves round, so there is no reversal to make
      for (let k = 2; k < az.length; k++)
        expect(az[k], `${rows[k].id} against the peel`).toBeCloseTo(180, 6);
    });
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
