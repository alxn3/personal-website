import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FLY, poseCamX } from "../../optics/fly-core";
import { clamp01, lerp } from "../../core/math";
import { EASE_FRAME_MS, easeStep } from "../../core/scene";
import { sampleStory } from "../camera";
import {
  STORY_R,
  rangeOf,
  atFrac,
  CAM_RELEASE_F,
  DIVE_P0,
  REVEAL_END,
} from "../story";
import {
  HYST,
  X_PARK,
  EXIT_END,
  FOV_BACK,
  GLASS_OUT,
  INK_RETURN,
  IRIS_BACK,
  REVEAL_X,
  createStoryFly,
  flyBodyFadeAt,
  flyDiveP,
  flyDollyAt,
  flyPoseAt,
  flyReturnAt,
  flySeatAt,
  flyRevealAt,
  flyFovBackAt,
  flyApertureAt,
  flyWarpAt,
  flyStreakAt,
  skyOutAt,
  flyInkAt,
  flyCentreAt,
  flyDarkAt,
  flyFocusAt,
  flyFovMixAt,
  flyFovOf,
  flySkyMixAt,
  flySpanApertureAt,
  flySpanFocusAt,
} from "../fly";
import {
  uStarMix,
  uStarRing,
  uStarSize,
  uStarStreak,
  uStreakGain,
} from "../../optics/starfield";
import { uWormhole } from "../../optics/wormhole-post";
import { driverOwnsIris, preShutAt } from "../envelopes";
import { storyStateAt } from "../state";
import { fakeScene, lin } from "./fake-scene";
import { quoteEnvAt } from "../constellations";

// createStoryFly's theme watcher is the only DOM it touches.
(globalThis as unknown as { document: unknown }).document ??= {
  documentElement: { classList: { contains: () => true } },
};
(globalThis as unknown as { MutationObserver: unknown }).MutationObserver ??=
  class {
    observe() {}
  };

const flyR = rangeOf("flythrough");
const coR = rangeOf("constellations");
const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

/** a fly on a fake scene whose members `over` replaces */
const flyOn = (over: Record<string, unknown> = {}) => {
  const f = fakeScene(over);
  return { f, fly: createStoryFly(f.scene) };
};

/** assert `f` never falls (dir +1) or never rises (dir −1) over `ps`, by
 *  more than `tol` per step */
const monotone = (
  f: (p: number) => number,
  ps: number[],
  dir: 1 | -1,
  tol = 1e-12,
) => {
  for (let i = 1; i < ps.length; i++)
    expect(dir * (f(ps[i]) - f(ps[i - 1])), `at ${ps[i]}`) //
      .toBeGreaterThanOrEqual(-tol);
};

describe("story fly span", () => {
  // The dive plays as the lens moving away from a parked camera, which only
  // matches the authored camera path if the park is the dive's opening pose.
  it("parks the story camera exactly where the dive's path opens", () => {
    const cam = flyR.scene.cam;
    expect(cam.pos[0] * STORY_R).toBeCloseTo(X_PARK, 12);
    expect([cam.pos[1], cam.pos[2], cam.xs]).toEqual([0, 0, 0]);
    expect(cam.fov).toBe(FLY.fovFar);
    expect(poseCamX(flyPoseAt(DIVE_P0))).toBeCloseTo(X_PARK, 12);
    expect(flyDollyAt(DIVE_P0)).toBeCloseTo(0, 12);
  });

  it("dive progress scrubs from the end of the approach and holds 1 through the sky", () => {
    expect(flyDiveP(flyR.p0)).toBe(0);
    expect(flyDiveP(atFrac(flyR, flyR.scene.transit / 2))).toBe(0);
    expect(flyDiveP(DIVE_P0)).toBe(0);
    expect(flyDiveP(flyR.p1)).toBeCloseTo(1, 10);
    expect(flyDiveP(atFrac(tR, 0.9))).toBe(1);
  });

  // The lens dolly mirrors the dive's camera path about the park.
  it("holds dolly + camera X ≡ the park through the dive", () => {
    for (const p of lin(DIVE_P0, flyR.p1, 100))
      expect(flyDollyAt(p) + poseCamX(flyPoseAt(p)), `at ${p}`) //
        .toBeCloseTo(X_PARK, 10);
    expect(flyDollyAt(flyR.p1)).toBeCloseTo(X_PARK - FLY.xEnd, 10);
  });

  it("takes the lens OUT monotonically and never before the ink is gone", () => {
    monotone(flyDollyAt, lin(DIVE_P0, flyR.p1, 200), -1);
    // The whole dive plays realistic: no ink until the return.
    for (const p of lin(DIVE_P0, INK_RETURN[0], 400))
      expect(flyInkAt(p), `ink at p ${p}`).toBe(0);
    // The ink returns while the lens is still seating.
    const seating = atFrac(rwR, 0.3);
    expect(flyDollyAt(seating)).toBeGreaterThan(0);
    expect(flyInkAt(seating)).toBeGreaterThan(0);
    expect(flyInkAt(atFrac(rwR, 0.5))).toBe(1);
    expect(flyInkAt(atFrac(capR, 0.1))).toBe(1);
  });

  // The lens returns through the camera, so it must reach REVEAL_X (past home)
  // before the reveal uncovers it; it seats home only after the reveal.
  it("parks the lens at the overshoot before the reveal uncovers it, and seats it after", () => {
    const far = X_PARK - FLY.xEnd;
    expect(flyDollyAt(atFrac(coR, 0.5))).toBeCloseTo(far, 10);
    expect(flyDollyAt(atFrac(tR, 0.9))).toBeCloseTo(far, 10);
    // travelling across the scene boundary, with the sky still whole
    const mid = flyDollyAt(rwR.p0);
    expect(mid).toBeGreaterThan(far);
    expect(mid).toBeLessThan(REVEAL_X);
    expect(skyOutAt(rwR.p0)).toBe(1);
    // standing still at the overshoot before the reveal starts, and through it
    expect(flyReturnAt(atFrac(rwR, 0.05))).toBe(1);
    expect(flyRevealAt(atFrac(rwR, 0.06))).toBe(0);
    for (const p of lin(atFrac(rwR, 0.05), REVEAL_END, 40))
      expect(flyDollyAt(p), `at ${p}`).toBe(REVEAL_X);
    expect(flySeatAt(REVEAL_END)).toBe(0);
    // then home for good
    for (const p of [
      atFrac(rwR, 0.34),
      EXIT_END,
      INK_RETURN[1],
      atFrac(capR, 0.5),
    ])
      // prettier-ignore
      expect(flyDollyAt(p), `at ${p}`).toBe(0);
    // monotone out to the overshoot, and back down to exactly 0
    const out = lin(atFrac(tR, 0.85), REVEAL_END, 200);
    expect(flyDollyAt(out[0])).toBeGreaterThanOrEqual(far - 1e-9);
    monotone(flyDollyAt, out, 1, 0);
    for (const p of out) expect(flyDollyAt(p)).toBeLessThanOrEqual(REVEAL_X);
    const home = lin(REVEAL_END, EXIT_END, 200);
    monotone(flyDollyAt, home, -1, 0);
    for (const p of home) expect(flyDollyAt(p)).toBeGreaterThanOrEqual(0);
  });

  it("uncovers the lens while the trails are still on screen, and hands the fov back after they are gone", () => {
    for (const p of [atFrac(tR, 0.95), rwR.p0, atFrac(rwR, 0.06)])
      expect(flyRevealAt(p), `at ${p}`).toBe(0);
    // the lens fades in while the star field is still fading out
    const during = flyRevealAt(atFrac(rwR, 0.11));
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(1);
    expect(flyRevealAt(atFrac(rwR, 0.16))).toBe(1);
    // the fov hand-back starts once the sky is gone and ends inside the span
    expect(skyOutAt(FOV_BACK[0])).toBe(0);
    expect(skyOutAt(FOV_BACK[0] - (rwR.p1 - rwR.p0) * 0.01)).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[0])).toBe(0);
    expect(flyFovBackAt(atFrac(rwR, 0.4))).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[1])).toBe(1);
    expect(FOV_BACK[1]).toBeLessThan(EXIT_END);
    expect(flyFovBackAt(EXIT_END)).toBe(1);
  });

  // The ending's ortho flatten also changes the fov, so they must not overlap.
  it("opens the ending's flatten only once the dive's fov is wholly handed back", () => {
    const orthoIn = rwR.scene.orthoIn!;
    const open = atFrac(rwR, orthoIn[0]);
    expect(flyFovMixAt(open)).toBe(0);
    expect(open).toBeGreaterThanOrEqual(FOV_BACK[1]);
    expect(orthoIn[1]).toBeLessThan(1);
  });

  // Drives the real evaluate() on core/scene's eased clock and checks the drawn
  // frame size, |pos| · tan(fov / 2), against the one the pose asks for.
  it("keeps the drawn frame the size the pose asked for across a flick", () => {
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    const target = new THREE.Vector3();
    /** the fov the fly last handed the scene, and how much of it is in force */
    let fov: number | null = null;
    let mix = 0;
    let centre = 0;
    const { f, fly } = flyOn({
      setStoryFov: (v: number | null, m = 1) => {
        fov = v;
        mix = v === null ? 0 : m;
      },
      setStoryCentre: (k: number) => {
        centre = k;
      },
    });
    const state = f.state;

    /** One frame in the real order: scroll target write (if scrolled), ease,
     *  fly evaluate and camera sample at the eased p. */
    const step = (raw: number, scroll = true) => {
      if (scroll) state.storyTarget = raw;
      state.story = easeStep(state.story, state.storyTarget, EASE_FRAME_MS);
      const pE = clamp01(state.story);
      fly.evaluate(pE);
      const sample = sampleStory(pE, pos, up, target);
      const drawn = mix > 0 ? lerp(sample.fov, fov!, mix) : sample.fov;
      const half = (v: number) => pos.length() * Math.tan((v * Math.PI) / 360);
      return {
        ratio: Math.max(
          half(drawn) / half(sample.fov),
          half(sample.fov) / half(drawn),
        ),
        pose: sample.fov,
        drawn,
      };
    };

    /** Plays a gesture from rest; reports frames drawn on a flattened pose
     *  (fov below the ending's), the worst size ratio and fov gap on them. */
    const worst = (gesture: number[]) => {
      state.story = state.storyTarget = gesture[0];
      for (let i = 0; i < 200; i++) step(gesture[0]);
      let ratio = 1;
      let fovGap = 0;
      let frames = 0;
      for (const p of gesture) {
        const s = step(p);
        if (s.pose >= rwR.scene.cam.fov) continue;
        frames++;
        ratio = Math.max(ratio, s.ratio);
        fovGap = Math.max(fovGap, Math.abs(s.drawn - s.pose));
      }
      return { ratio, fovGap, frames };
    };

    // parked at the end, flicked back into the rewrap's middle, then held;
    // pausing on the flat park puts a run of frames on a flattened pose
    const to = atFrac(rwR, 0.42);
    const flick = worst([
      0.985,
      0.985,
      ...Array<number>(40).fill(atFrac(rwR, 0.9)),
      ...lin(0.985, to, 4).slice(1),
      ...Array<number>(40).fill(to),
    ]);
    expect(flick.frames).toBeGreaterThan(3);
    expect(flick.fovGap).toBe(0);
    expect(flick.ratio).toBe(1);

    // a fast forward fling (0.02 of the track per frame) through the same span
    const fwd: number[] = [];
    for (let p = atFrac(rwR, 0.1); p < 0.99; p += 0.02) fwd.push(p);
    const fling = worst([...fwd, ...Array<number>(40).fill(0.99)]);
    expect(fling.frames).toBeGreaterThanOrEqual(3);
    expect(fling.fovGap).toBe(0);
    expect(fling.ratio).toBe(1);

    // A jump (PageDown, End) is one scroll event then many eased ticks; fov and
    // centre must follow the eased p on every tick.
    state.story = state.storyTarget = 0;
    for (let i = 0; i < 200; i++) step(0);
    const mid = atFrac(flyR, 0.6);
    step(mid);
    const frozen = fov;
    let moved = false;
    let live = 0;
    for (let i = 0; i < 20; i++) {
      step(mid, false);
      const pE = clamp01(state.story);
      if (pE >= DIVE_P0) {
        live++;
        expect(fov, `fov at tick ${i}`).toBe(flyFovOf(flyPoseAt(pE)));
        expect(mix, `mix at tick ${i}`).toBe(flyFovMixAt(pE));
      } else expect(fov, `fov at tick ${i}`).toBe(null);
      expect(centre, `centre at tick ${i}`).toBe(flyCentreAt(pE));
      if (fov !== frozen) moved = true;
    }
    // guards that the loop above actually exercised the dive
    expect(live).toBeGreaterThan(10);
    expect(moved).toBe(true);
    expect(flyFovOf(flyPoseAt(mid))).not.toBe(FLY.fovFar);
    // a pose without its own fov takes the park's
    expect(flyFovOf({ azimuth: 0, elevation: 0, distance: 1 })).toBe(FLY.fovFar); // prettier-ignore
    expect(flyFovOf({ azimuth: 0, elevation: 0, distance: 1, fov: 31 })).toBe(31); // prettier-ignore
  });

  // Camera release, seat and fov push-in each start on their own frame.
  it("staggers the three enders: chain creep, then the seat, then fov", () => {
    const camRelease = atFrac(rwR, CAM_RELEASE_F);
    // the camera stays still until the reveal fade completes
    expect(flyRevealAt(camRelease)).toBe(1);
    expect(flyRevealAt(camRelease - (rwR.p1 - rwR.p0) * 0.01)).toBeLessThan(1);
    expect(camRelease).toBeLessThan(REVEAL_END);
    expect(REVEAL_END).toBeLessThan(FOV_BACK[0]);
    expect(flySeatAt(REVEAL_END)).toBe(0);
    const eps = (rwR.p1 - rwR.p0) * 1e-3;
    expect(flySeatAt(REVEAL_END + eps)).toBeGreaterThan(0);
    expect(flySeatAt(EXIT_END)).toBe(1);
  });

  it("aperture parks shut and is fully open before glass entry", () => {
    expect(flyApertureAt(0)).toBe(FLY.apertureShut);
    expect(flyApertureAt(FLY.pAperture[1])).toBe(0);
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pEnter);
  });

  it("the sky is whole through the dive and leaves monotonely inside rewrap", () => {
    for (const p of [
      atFrac(flyR, 0.5),
      atFrac(coR, 0.5),
      atFrac(tR, 0.9),
      rwR.p0,
      atFrac(rwR, 0.02),
    ])
      // prettier-ignore
      expect(skyOutAt(p), `at ${p}`).toBe(1);
    // still fading at REVEAL_END, gone well before the span ends
    expect(skyOutAt(REVEAL_END)).toBeGreaterThan(0);
    for (const p of [atFrac(rwR, 0.32), atFrac(rwR, 0.5), atFrac(capR, 0.5)])
      expect(skyOutAt(p), `at ${p}`).toBe(0);
    const mid = skyOutAt(atFrac(rwR, 0.12));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    monotone(skyOutAt, lin(tR.p0, rwR.p1, 60), -1);
  });

  // hero-driver owns body fade below DIVE_P0 and the fly from DIVE_P0 on; a gap
  // could leave the lens hidden, since the channel holds its last write.
  it("takes the body-fade channel over from the story with NO unowned p", () => {
    for (const p of lin(DIVE_P0, DIVE_P0 + (flyR.p1 - DIVE_P0) * 0.9, 100))
      expect(flyBodyFadeAt(p), `dive ${p}`).toBe(1);
    // in the hysteresis band both write 1, so the order does not matter
    expect(flyBodyFadeAt(DIVE_P0 - HYST)).toBe(1);
    // covered only where the lens crosses the camera, then revealed again
    for (const p of [flyR.p1, atFrac(tR, 0.5), atFrac(rwR, 0.06)])
      expect(flyBodyFadeAt(p), `at ${p}`).toBe(0);
    for (const p of [atFrac(rwR, 0.16), EXIT_END])
      expect(flyBodyFadeAt(p), `at ${p}`).toBe(1);
  });

  it("writes NOTHING to the channel below DIVE_P0 — a deep link into the approach", () => {
    const writes: number[] = [];
    const { fly } = flyOn({ setBodyFade: (v: number) => writes.push(v) });
    // from the internals scene's end up to the dive's first frame
    const inR = rangeOf("internals");
    for (const p of lin(inR.p1, inR.p1 + (DIVE_P0 - inR.p1) * 0.999, 40))
      fly.evaluate(p);
    expect(writes).toEqual([]);
    fly.evaluate(DIVE_P0);
    expect(writes).toEqual([1]);
  });

  // The glass elements swap materials, so ink must be 0 while they are mounted.
  it("the ink is 1 through the story and 0 through the whole dive", () => {
    for (const p of [
      0,
      atFrac(rangeOf("peel"), 0.5),
      atFrac(rangeOf("internals"), 0.5),
      flyR.p0,
      atFrac(capR, 0.5),
    ])
      // prettier-ignore
      expect(flyInkAt(p), `at ${p}`).toBe(1);
    for (const p of [DIVE_P0, atFrac(flyR, 0.5), atFrac(tR, 0.9)])
      expect(flyInkAt(p), `at ${p}`).toBe(0);
  });

  // The transmissive glass clones are mounted over [DIVE_P0, GLASS_OUT].
  it("neither ink ramp reaches into the GLASS sub-span, hysteresis included", () => {
    // GLASS_OUT − 2·HYST is the remount edge on a scrub back down
    for (const p of [
      DIVE_P0 - HYST,
      GLASS_OUT,
      GLASS_OUT + HYST,
      GLASS_OUT - 2 * HYST,
    ])
      // prettier-ignore
      expect(flyInkAt(p), `at ${p}`).toBe(0);
    expect(INK_RETURN[0]).toBeGreaterThan(GLASS_OUT + HYST);
    // the reveal plays fully realistic
    expect(flyRevealAt(INK_RETURN[0])).toBe(1);
    expect(flyInkAt(atFrac(rwR, 0.16))).toBe(0);
    // both ramps are dissolves, not cuts
    for (const p of [atFrac(flyR, flyR.scene.transit / 2), atFrac(rwR, 0.26)]) {
      expect(flyInkAt(p), `at ${p}`).toBeGreaterThan(0);
      expect(flyInkAt(p), `at ${p}`).toBeLessThan(1);
    }
  });

  // Mounts entering from the dive side, unmounts crossing GLASS_OUT, remounts
  // only a hysteresis below it, and never mounts entering down past EXIT_END.
  it("mounts the transmissive glass only inside its own sub-span", () => {
    const calls: boolean[] = [];
    const { fly } = flyOn({
      setGlassTransmissive: (on: boolean) => calls.push(on),
    });
    fly.evaluate(atFrac(flyR, 0.5));
    expect(calls).toEqual([true]);
    // the body is covered where the glass unmounts
    expect(flyBodyFadeAt(GLASS_OUT)).toBe(0);
    fly.evaluate(atFrac(rwR, 0.1));
    expect(calls).toEqual([true, false]);
    // scrubbing above the edge changes nothing
    fly.evaluate(atFrac(rwR, 0.3));
    fly.evaluate(atFrac(rwR, 0.08));
    expect(calls).toEqual([true, false]);
    fly.evaluate(GLASS_OUT - 2 * HYST);
    expect(calls).toEqual([true, false, true]);
    // a downward entry across EXIT_END never mounts
    const calls2: boolean[] = [];
    const second = flyOn({
      setGlassTransmissive: (on: boolean) => calls2.push(on),
    }).fly;
    second.evaluate(atFrac(rwR, 0.45)); // inside the span, above GLASS_OUT
    second.evaluate(atFrac(rwR, 0.3));
    expect(calls2).toEqual([]);
  });

  // exit() runs before the ink is written and enter() after it.
  it("frame() leaves, then writes the look, then arrives", () => {
    const log: string[] = [];
    const { fly } = flyOn({
      setInkMix: (v: number) => log.push(`ink ${v}`),
      setGlassTransmissive: (on: boolean) => log.push(on ? "enter" : "exit"),
    });
    fly.evaluate(atFrac(flyR, flyR.scene.transit + 0.05));
    expect(log).toEqual(["ink 0", "enter"]);
    // leaving: pick a p clear of the exit hysteresis band
    log.length = 0;
    const out = atFrac(rwR, 0.65);
    expect(out).toBeGreaterThan(EXIT_END + HYST);
    fly.evaluate(out);
    expect(log.slice(0, 2)).toEqual(["exit", `ink ${flyInkAt(out)}`]);
  });

  it("the composed sky mix is still 0 before the dive's sky window", () => {
    for (const p of [
      flyR.p0,
      DIVE_P0,
      DIVE_P0 + (flyR.p1 - DIVE_P0) * FLY.pSkyIn[0] * 0.5,
      atFrac(rwR, 0.32),
    ])
      // prettier-ignore
      expect(flySkyMixAt(p), `at ${p}`).toBe(0);
    expect(flySkyMixAt(atFrac(tR, 0.5))).toBe(1);
  });

  // Outside the span the ramps must equal what exit() leaves: exactly 0.
  it("the span's ramps are ALREADY what exit() leaves, outside the span", () => {
    const outside = [
      ...lin(0, 1, 2000).filter((p) => p < DIVE_P0 || p > EXIT_END),
      DIVE_P0 - HYST,
      EXIT_END + HYST,
    ];
    for (const p of outside)
      for (const f of [flySkyMixAt, flyDarkAt, flyWarpAt, flyStreakAt])
        expect(f(p), `${f.name} ${p}`).toBe(0);
  });

  describe("the wormhole envelope", () => {
    // A radial warp would draw the circular star trails as ellipses.
    it("is exactly 0 for every frame of the trails scene and after", () => {
      for (const p of lin(tR.p0, rwR.p1, 400)) {
        expect(flyWarpAt(p)).toBe(0);
        expect(flyStreakAt(p)).toBe(0);
      }
    });

    // The quote is drawn in-scene and the warp would bend its glyphs.
    it("is exactly 0 on every frame the QUOTE is drawn on", () => {
      const quoted = lin(coR.p0, 1, 4000).filter((p) => quoteEnvAt(p) > 0);
      for (const p of quoted) {
        expect(flyWarpAt(p)).toBe(0);
        expect(flyStreakAt(p)).toBe(0);
      }
      // guards against a vacuous pass: the quote is live and the warp is not
      expect(quoted.length).toBeGreaterThan(1000);
      expect(flyWarpAt(atFrac(flyR, 0.6))).toBeGreaterThan(0);
    });

    // Strong warp only while the dive is visibly moving.
    it("dies with the dive's motion — no parked full-warp frames", () => {
      expect(flyWarpAt(flyR.p1)).toBe(0);
      expect(flyStreakAt(flyR.p1)).toBe(0);
      expect(flyWarpAt(atFrac(coR, 0.2))).toBe(0);
      expect(flyWarpAt(atFrac(flyR, 0.55))).toBeGreaterThan(0.5);
    });

    it("is 0 before the dive, and never goes back up", () => {
      expect(flyWarpAt(flyR.p0)).toBe(0);
      expect(flyWarpAt(DIVE_P0)).toBe(0);
      expect(flyStreakAt(DIVE_P0)).toBe(0);
      // a single peak for both ramps: rise, then fall
      const ps = lin(DIVE_P0, tR.p0, 600);
      for (const f of [flyWarpAt, flyStreakAt]) {
        const xs = ps.map(f);
        const peak = xs.indexOf(Math.max(...xs));
        monotone(f, ps.slice(0, peak + 1), 1);
        monotone(f, ps.slice(peak), -1);
      }
    });

    // uStarRing follows the warp and bends the streaks, so both end together.
    it("ends both halves of the ring on the same frame", () => {
      const ps = lin(DIVE_P0, tR.p0, 2000).slice(1001);
      const zeroAt = (f: (p: number) => number) => ps.find((p) => f(p) === 0);
      expect(zeroAt(flyWarpAt)).toBeCloseTo(zeroAt(flyStreakAt)!, 12);
    });
  });
});

// Hysteresis gates only the mounts; every written value is a function of p.
describe("the hysteresis bands draw the same frame from either side", () => {
  /** every drawn value, after walking `path` and parking on its last p */
  const restAfter = (path: number[]) => {
    const { f, fly } = flyOn();
    for (const p of path) {
      // the driver's iris writes, which hero-driver runs before the fly
      if (driverOwnsIris(p)) {
        f.state.focus = f.state.focusTarget = 0;
        f.state.aperture = f.state.apertureTarget = preShutAt(p);
      }
      fly.evaluate(p);
    }
    const w = f.writes;
    const fov: [number | null, number] = Array.isArray(w.setStoryFov)
      ? (w.setStoryFov as [number | null, number])
      : [null, 0];
    return {
      aperture: f.state.aperture,
      focus: f.state.focus,
      fov: fov[0] === null || fov[1] <= 0 ? null : fov,
      dolly: w.setLensDolly ?? 0,
      bodyFade: w.setBodyFade ?? 1,
      roomLight: w.setRoomLight ?? 1,
      glint: w.setGlassGlint ?? 1,
      inkMix: w.setInkMix,
      centre: w.setStoryCentre,
      skyMix: uStarMix.value,
      warp: uWormhole.value,
      streak: uStarStreak.value,
      ring: uStarRing.value,
      gain: uStreakGain.value,
      size: uStarSize.value,
    };
  };

  it("at the dive edge, and at the exit edge", () => {
    const step = HYST / 8;
    for (const [lo, hi] of [
      [DIVE_P0 - HYST, DIVE_P0],
      [EXIT_END, EXIT_END + HYST],
    ]) {
      for (let p = lo + step; p < hi; p += step) {
        const below = restAfter([lo - 0.05, lo - 0.01, p]);
        const above = restAfter([hi + 0.05, hi + 0.01, p]);
        expect(below, `arriving at ${p} from either side`).toEqual(above);
        // and it matches the story report
        const s = storyStateAt(p);
        expect(below.aperture, `aperture ${p}`).toBe(s.channels.aperture);
        expect(below.focus, `focus ${p}`).toBe(s.channels.focus);
        expect(below.fov, `fov ${p}`).toBe(null);
      }
    }
  });

  it("hands the iris back under the body cover, so the span's edge is a rest", () => {
    // both iris channels equal the driver's values at either span edge
    for (const p of [DIVE_P0, EXIT_END]) {
      expect(flySpanApertureAt(p), `at ${p}`).toBe(preShutAt(p));
      expect(flySpanFocusAt(p), `at ${p}`).toBe(0);
    }
    // the hand-back runs while the body is hidden
    for (const p of lin(IRIS_BACK[0], IRIS_BACK[1], 50))
      expect(flyBodyFadeAt(p), `body fade at ${p}`).toBe(0);
    expect(IRIS_BACK[1]).toBeLessThan(EXIT_END);
    // inside the dive the dive's own ramps apply
    for (const p of lin(DIVE_P0, flyR.p1, 50)) {
      expect(flySpanApertureAt(p), `aperture ${p}`) //
        .toBe(flyApertureAt(flyDiveP(p)));
      expect(flySpanFocusAt(p), `focus ${p}`).toBe(flyFocusAt(flyDiveP(p)));
    }
  });
});

describe("what the span does not own", () => {
  it("never writes the dust — that is the driver's law", () => {
    const { f, fly } = flyOn();
    for (const p of [0, DIVE_P0, atFrac(flyR, 0.7), EXIT_END + 0.1, 0.3])
      fly.evaluate(p);
    expect(f.calls).not.toContain("setDust");
  });

  it("multiplies the __lensStars size and streak-gain knobs instead of stomping them", () => {
    // the uniforms are module-wide, so reset what earlier tests left
    uStarSize.value = 1;
    uStreakGain.value = 1;
    const { fly } = flyOn();
    const knobs = () => [uStarSize.value, uStreakGain.value];
    const near = (v: number[], want: number[]) =>
      v.forEach((x, i) => expect(x).toBeCloseTo(want[i], 12));
    const peak = DIVE_P0 + (flyR.p1 - DIVE_P0) * 0.44;
    const quiet = DIVE_P0 + (flyR.p1 - DIVE_P0) * 0.8;
    fly.evaluate(quiet);
    expect(knobs()).toEqual([1, 1]);
    // a knob set live while parked in the dive
    uStarSize.value = 0.6;
    uStreakGain.value = 2;
    fly.evaluate(peak);
    near(knobs(), [0.6 * 1.3, 2 * 1.6]);
    fly.evaluate(quiet);
    near(knobs(), [0.6, 2]);
    // exit() restores the knob values
    fly.evaluate(EXIT_END + 2 * HYST);
    near(knobs(), [0.6, 2]);
    uStarSize.value = 1;
    uStreakGain.value = 1;
  });
});
