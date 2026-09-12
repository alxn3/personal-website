import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FLY, poseCamX } from "../../optics/fly-core";
import { clamp01, lerp, smoothstep } from "../../core/math";
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
  flySkyInAt,
  flySkyMixAt,
} from "../fly";
// the quote's own envelope, read rather than copied: the warp's far edge exists
// to clear it, so the coupling is pinned against the thing that owns the number.
import { quoteEnvAt } from "../constellations";

// createStoryFly's theme watcher reads the document — the only DOM this file's
// subject touches, and only from inside the factory.
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
// DIVE_P0 — the dive's first frame — is imported from story.ts, where fly.ts
// and hero-driver both read it, rather than re-derived here.

describe("story fly span", () => {
  // THE EQUIVALENCE THE SPAN RESTS ON: the dive is authored as a camera flying
  // to camX and PLAYED as a lens at X_PARK − camX in front of a camera parked
  // at X_PARK, which only matches if the story rig's parked pose IS the dive's
  // opening pose.
  it("parks the story camera exactly where the dive's path opens", () => {
    const cam = flyR.scene.cam;
    expect(cam.pos[0] * STORY_R).toBeCloseTo(X_PARK, 12);
    expect(cam.pos[1]).toBe(0);
    expect(cam.pos[2]).toBe(0);
    expect(cam.fov).toBe(FLY.fovFar);
    expect(cam.xs).toBe(0);
    // …and the dive's own first pose agrees, so the dolly opens at 0
    expect(poseCamX(flyPoseAt(DIVE_P0))).toBeCloseTo(X_PARK, 12);
    expect(flyDollyAt(DIVE_P0)).toBeCloseTo(0, 12);
  });

  it("dive progress scrubs from the end of the approach and holds 1 through the sky", () => {
    // the approach is the camera's, and the dive is parked at its first frame
    // for the whole of it
    expect(flyDiveP(flyR.p0)).toBe(0);
    expect(flyDiveP(atFrac(flyR, flyR.scene.transit / 2))).toBe(0);
    expect(flyDiveP(DIVE_P0)).toBe(0);
    expect(flyDiveP(flyR.p1)).toBeCloseTo(1, 10);
    expect(flyDiveP(atFrac(rangeOf("trails"), 0.9))).toBe(1);
  });

  // THE DOLLY IS THE DIVE. Every frame of it is the demo's camera reading,
  // mirrored about the park — so the invariant below is the whole architecture.
  it("holds dolly + camera X ≡ the park through the dive", () => {
    for (let i = 0; i <= 100; i++) {
      const p = DIVE_P0 + (flyR.p1 - DIVE_P0) * (i / 100);
      expect(
        flyDollyAt(p) + poseCamX(flyPoseAt(p)),
        `at dive ${i / 100}`,
      ).toBeCloseTo(X_PARK, 10);
    }
    // 25 world units out by the end: the dive's whole reach (distFar + xEnd)
    expect(flyDollyAt(flyR.p1)).toBeCloseTo(X_PARK - FLY.xEnd, 10);
  });

  it("takes the lens OUT monotonically and never before the ink is gone", () => {
    let prev = 0;
    for (let i = 0; i <= 200; i++) {
      const p = DIVE_P0 + (flyR.p1 - DIVE_P0) * (i / 200);
      const d = flyDollyAt(p);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
    }
    // The fade planes track the SUBJECT (the orbit target plus the lens' own
    // dolly), so the ink needs no dolly gate. What the law protects on the way
    // OUT is the look: the whole dive plays realistic, so the ink is gone by
    // the dive's first frame and stays gone until the reveal draws the lens.
    for (let i = 0; i <= 400; i++) {
      const p = DIVE_P0 + (INK_RETURN[0] - DIVE_P0) * (i / 400);
      expect(flyInkAt(p), `ink at p ${p}`).toBe(0);
    }
    // THE RETURN OVERLAPS THE SEAT BY DESIGN: the ink is live while the
    // overshoot is still giving itself back, which the tracked planes license.
    const seating = atFrac(rwR, 0.3);
    expect(flyDollyAt(seating)).toBeGreaterThan(0);
    expect(flyInkAt(seating)).toBeGreaterThan(0);
    // …and the look is FULLY ink well before caps-on (the far edge)
    expect(flyInkAt(atFrac(rwR, 0.5))).toBe(1);
    expect(flyInkAt(atFrac(rangeOf("capsOn"), 0.1))).toBe(1);
  });

  // THE RETURN IS BLIND: the lens travels straight through the camera's own
  // position, so it must be FINISHED by the first frame of the reveal, where
  // story/fly.ts lifts the body cover.
  //
  // It does not return HOME, though — it returns to REVEAL_X, past home, and
  // stands there for the whole reveal, since seated at home the lens reads too
  // close to the camera. The last leg is its own beat, with the camera's move.
  it("parks the lens at the overshoot before the reveal uncovers it, and seats it after", () => {
    // out through the whole sky chapter, right up to the trails' last tenth…
    expect(flyDollyAt(atFrac(rangeOf("constellations"), 0.5))).toBeCloseTo(
      X_PARK - FLY.xEnd,
      10,
    );
    expect(flyDollyAt(atFrac(tR, 0.9))).toBeCloseTo(X_PARK - FLY.xEnd, 10);
    // …travelling across the scene boundary, with the sky still whole over it…
    const mid = flyDollyAt(rwR.p0);
    expect(mid).toBeGreaterThan(X_PARK - FLY.xEnd);
    expect(mid).toBeLessThan(REVEAL_X);
    expect(skyOutAt(rwR.p0)).toBe(1);
    // …and STANDING STILL at the overshoot before the reveal starts…
    expect(flyDollyAt(atFrac(rwR, 0.05))).toBe(REVEAL_X);
    expect(flyReturnAt(atFrac(rwR, 0.05))).toBe(1);
    expect(flyRevealAt(atFrac(rwR, 0.06))).toBe(0);
    // …for every frame of it: no dolly move at all between the cover lifting
    // and the reveal's end (the seat's window opens exactly at REVEAL_END)
    for (let i = 0; i <= 40; i++) {
      const p = atFrac(rwR, 0.05) + (REVEAL_END - atFrac(rwR, 0.05)) * (i / 40);
      expect(flyDollyAt(p), `at ${i}/40 of the reveal`).toBe(REVEAL_X);
    }
    expect(flySeatAt(REVEAL_END)).toBe(0);
    // …then home, and home for good: the story's poses all orbit the ORIGIN
    expect(flyDollyAt(atFrac(rwR, 0.34))).toBe(0);
    expect(flyDollyAt(EXIT_END)).toBe(0);
    expect(flyDollyAt(INK_RETURN[1])).toBe(0);
    expect(flyDollyAt(atFrac(rangeOf("capsOn"), 0.5))).toBe(0);
    // the way back is monotone to the overshoot — no bounce, no early creep
    let prev = X_PARK - FLY.xEnd - 1e-9;
    for (let i = 0; i <= 200; i++) {
      const p = atFrac(tR, 0.85) + (REVEAL_END - atFrac(tR, 0.85)) * (i / 200);
      const d = flyDollyAt(p);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(REVEAL_X);
      prev = d;
    }
    // …and the last leg is monotone the other way, down to exactly 0
    prev = REVEAL_X + 1e-9;
    for (let i = 0; i <= 200; i++) {
      const p = REVEAL_END + (EXIT_END - REVEAL_END) * (i / 200);
      const d = flyDollyAt(p);
      expect(d).toBeLessThanOrEqual(prev);
      expect(d).toBeGreaterThanOrEqual(0);
      prev = d;
    }
  });

  // THE REVEAL'S OWN ORDER: the exploded, still-spinning lens crossfades in
  // UNDER the last of the star trails, and the framing only comes back once the
  // sky it would scale is gone.
  it("uncovers the lens while the trails are still on screen, and hands the fov back after they are gone", () => {
    // covered for every frame of the journey home…
    expect(flyRevealAt(atFrac(tR, 0.95))).toBe(0);
    expect(flyRevealAt(rwR.p0)).toBe(0);
    expect(flyRevealAt(atFrac(rwR, 0.06))).toBe(0);
    // …then up while the field is still fading — the crossfade IS that overlap,
    // and it is long: the shell is fully drawn at 0.16 with the arcs' fall not
    // half spent (the trail side is pinned in trails.test.ts)
    const during = flyRevealAt(atFrac(rwR, 0.11));
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(1);
    expect(flyRevealAt(atFrac(rwR, 0.16))).toBe(1);
    expect(atFrac(rwR, 0.16)).toBeLessThan(atFrac(rwR, 0.28));
    // THE FRAMING WAITS FOR THE SKY IT WOULD SCALE: the fov hand-back is a
    // push-in, a camera move in all but name, so its first edge is the frame
    // skyOutAt lands on 0 (pinned against the function, not a number) and it
    // must finish before the span's edge, where exit() cuts the override.
    expect(skyOutAt(FOV_BACK[0])).toBe(0);
    expect(skyOutAt(FOV_BACK[0] - (rwR.p1 - rwR.p0) * 0.01)).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[0])).toBe(0);
    expect(flyFovBackAt(atFrac(rwR, 0.4))).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[1])).toBe(1);
    expect(FOV_BACK[1]).toBeLessThan(EXIT_END);
    expect(flyFovBackAt(EXIT_END)).toBe(1);
  });

  // …AND SO DOES THE FLATTEN, behind the same edge: the ending's ortho blend is
  // a fov change too, and while the dive still holds a share of the fov the two
  // owners would each scale what the other draws. So the flatten may not open
  // until that mix is exactly 0 — the hand-back's far edge, not its foot.
  it("opens the ending's flatten only once the dive's fov is wholly handed back", () => {
    const orthoIn = rwR.scene.orthoIn!;
    const open = atFrac(rwR, orthoIn[0]);
    expect(flyFovMixAt(open)).toBe(0);
    expect(open).toBeGreaterThanOrEqual(FOV_BACK[1]);
    // …and it is still open (not dead weight) by the time the scene parks
    expect(orthoIn[1]).toBeLessThan(1);
  });

  // …AND THE SAME PAIRING ON THE CLOCK THE FRAME IS DRAWN FROM: core/scene
  // samples the camera at the EASED `state.story` and evaluates the fly at the
  // same p. Inside the flatten `back` pulls the camera far out to match a 3°
  // fov, and a fov mix read off any other clock would scale a frame the pose
  // never asked for. So this drives the REAL evaluate() against core/scene's
  // ease and reads what the frame COMPOSES: |pos| · tan(drawn fov / 2).
  it("keeps the drawn frame the size the pose asked for across a flick", () => {
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    const target = new THREE.Vector3();
    /** the fov the fly last handed core/scene, and how much of it is in force */
    let fov: number | null = null;
    let mix = 0;
    let centre = 0;
    const state: Record<string, number> = {
      story: 0,
      storyTarget: 0,
      zoom: 0,
      explode: 0,
      assemble: 0,
      aperture: 0,
      apertureTarget: 0,
      focus: 0,
      focusTarget: 0,
    };
    const scene = {
      state,
      worldAxialSpans: () => ({}),
      setLensDolly: () => {},
      setStoryFov: (f: number | null, m = 1) => {
        fov = f;
        mix = f === null ? 0 : m;
      },
      setStoryCentre: (k: number) => {
        centre = k;
      },
      setBodyFade: () => {},
      setInkMix: () => {},
      setGlassTransmissive: () => {},
      setGlassFade: () => {},
      setGlassElementFade: () => {},
      setGlassGlint: () => {},
      setDust: () => {},
      setRoomLight: () => {},
      setSkyDim: () => {},
      enableStarfield: () => Promise.resolve(true),
      enableWormholePost: () => Promise.resolve(true),
      warmFly: () => Promise.resolve(),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly = createStoryFly(scene);

    /** one displayed frame, in the real order: the scroll rAF's target write
     *  (only on a frame with a scroll event), then core/scene's tick — the
     *  story ease, the fly's evaluate at the eased p, the camera at the same
     *  p, the render. Reports the frame's half-height AT THE ORBIT TARGET as
     *  drawn, against the one the pose alone asks for (which the matching
     *  identity makes exactly `baseLen · tan(fovKey/2)`, flatten or no
     *  flatten). */
    const step = (raw: number, scroll = true) => {
      if (scroll) state.storyTarget = raw;
      state.story = easeStep(state.story, state.storyTarget, EASE_FRAME_MS);
      const pE = clamp01(state.story);
      fly.evaluate(pE);
      const sample = sampleStory(pE, pos, up, target);
      const drawn = mix > 0 ? lerp(sample.fov, fov!, mix) : sample.fov;
      const half = (f: number) => pos.length() * Math.tan((f * Math.PI) / 360);
      return {
        ratio: Math.max(
          half(drawn) / half(sample.fov),
          half(sample.fov) / half(drawn),
        ),
        // …and the pose's own fov beside the drawn one, for the frames where
        // the flatten owns the pullback
        pose: sample.fov,
        drawn,
      };
    };

    /** a gesture, settled at its first p first: how many frames were drawn on a
     *  FLATTENED pose, the worst size error on one of those, and the worst fov
     *  disagreement. "Flattened" = the pose's fov is under the one the ending's
     *  rows author, so its distance has been scaled to match a fov of its own. */
    const worst = (gesture: number[]) => {
      state.story = state.storyTarget = gesture[0];
      for (let i = 0; i < 200; i++) step(gesture[0]);
      let ratio = 1;
      let fovGap = 0;
      let frames = 0;
      for (const p of gesture) {
        const f = step(p);
        if (f.pose >= rwR.scene.cam.fov) continue;
        frames++;
        ratio = Math.max(ratio, f.ratio);
        fovGap = Math.max(fovGap, Math.abs(f.drawn - f.pose));
      }
      return { ratio, fovGap, frames };
    };

    // the reader's own gesture: parked in the bloom, flicked back into the
    // rewrap's middle (where the flatten is wide open on the eased clock and
    // the dive re-enters on the raw one), then held while the ease catches up
    const back = [0.985, 0.985];
    const to = atFrac(rwR, 0.42);
    // the flick CATCHES on the flat park on its way through, which is what puts
    // a run of drawn frames on a flattened pose rather than three of them
    for (let i = 0; i < 40; i++) back.push(atFrac(rwR, 0.9));
    for (let i = 1; i <= 4; i++) back.push(0.985 + ((to - 0.985) * i) / 4);
    for (let i = 0; i < 40; i++) back.push(to);
    const flick = worst(back);
    // the gesture really does draw flat frames — a law that never reaches the
    // state it is about is the blind one this replaces
    expect(flick.frames).toBeGreaterThan(3);
    expect(flick.fovGap).toBe(0);
    expect(flick.ratio).toBe(1);

    // …and the way in, at a fling's speed through the same span (0.02 of the
    // track per frame). The flat band is a few hundredths of p wide, so a fling
    // that fast draws exactly three frames inside it.
    const fwd: number[] = [];
    for (let p = atFrac(rwR, 0.1); p < 0.99; p += 0.02) fwd.push(p);
    for (let i = 0; i < 40; i++) fwd.push(0.99);
    const fling = worst(fwd);
    expect(fling.frames).toBeGreaterThanOrEqual(3);
    expect(fling.fovGap).toBe(0);
    expect(fling.ratio).toBe(1);

    // THE JUMP: PageDown / End / a scrollbar drag is ONE scroll event, then
    // ~19 ticks of ease with no scroll. The fov and the centre are the
    // camera's, so they must follow the eased p on every one of those ticks —
    // not hold the value the one scroll event saw.
    state.story = state.storyTarget = 0;
    for (let i = 0; i < 200; i++) step(0);
    const mid = atFrac(flyR, 0.6);
    step(mid); // the one scroll event
    const frozen = fov;
    let moved = false;
    let live = 0;
    for (let i = 0; i < 20; i++) {
      step(mid, false);
      const pE = clamp01(state.story);
      // the span arms on the eased p too: the override exists only inside it
      if (pE >= DIVE_P0) {
        live++;
        expect(fov, `fov at tick ${i}`).toBe(flyFovOf(flyPoseAt(pE)));
        expect(mix, `mix at tick ${i}`).toBe(flyFovMixAt(pE));
      } else expect(fov, `fov at tick ${i}`).toBe(null);
      expect(centre, `centre at tick ${i}`).toBe(flyCentreAt(pE));
      if (fov !== frozen) moved = true;
    }
    // …the glide really enters the dive, and the eased pose really asks for a
    // different fov than the park's, or the pin above could not tell an
    // evaluate from a freeze
    expect(live).toBeGreaterThan(10);
    expect(moved).toBe(true);
    expect(flyFovOf(flyPoseAt(mid))).not.toBe(FLY.fovFar);
  });

  // THE STAGGERED ONSETS: the chain, the fov push-in and the dolly's last leg
  // each have their own edge, in a fixed order, so no frame carries more than
  // one onset. The chain creeps first (CAM_RELEASE_F, the reveal crossfade's
  // top), the seat waits for the exploded radius to be spent (REVEAL_END), and
  // the fov push opens at the sky's far edge.
  it("staggers the three enders: chain creep, then the seat, then fov", () => {
    const camRelease = atFrac(rwR, CAM_RELEASE_F);
    // the chain's release IS the crossfade's top: the camera is bit-still for
    // every frame of the reveal fade and creeping only after it saturates
    expect(flyRevealAt(camRelease)).toBe(1);
    expect(flyRevealAt(camRelease - (rwR.p1 - rwR.p0) * 0.01)).toBeLessThan(1);
    // strict order, no shared frames
    expect(camRelease).toBeLessThan(REVEAL_END);
    expect(REVEAL_END).toBeLessThan(FOV_BACK[0]);
    expect(flySeatAt(REVEAL_END)).toBe(0);
    const eps = (rwR.p1 - rwR.p0) * 1e-3;
    expect(flySeatAt(REVEAL_END + eps)).toBeGreaterThan(0);
    // both saturate before the span hands back
    expect(flySeatAt(EXIT_END)).toBe(1);
    expect(flyFovBackAt(EXIT_END)).toBe(1);
  });

  it("aperture parks shut and is fully open before glass entry", () => {
    expect(flyApertureAt(0)).toBe(FLY.apertureShut);
    expect(flyApertureAt(FLY.pAperture[1])).toBe(0);
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pEnter);
  });

  it("the sky is whole through the dive and gone inside rewrap", () => {
    const rwR = rangeOf("rewrap");
    expect(skyOutAt(atFrac(rangeOf("flythrough"), 0.5))).toBe(1);
    expect(skyOutAt(atFrac(rangeOf("constellations"), 0.5))).toBe(1);
    expect(skyOutAt(atFrac(rangeOf("trails"), 0.9))).toBe(1);
    expect(skyOutAt(rwR.p0)).toBe(1);
    expect(skyOutAt(atFrac(rwR, 0.02))).toBe(1);
    // …still ALIVE over the whole reveal and collapse (REVEAL_END sits inside
    // the fade), and gone at SKY_OUT_END, well before the span's own edge
    expect(skyOutAt(REVEAL_END)).toBeGreaterThan(0);
    expect(skyOutAt(atFrac(rwR, 0.32))).toBe(0);
    expect(skyOutAt(atFrac(rwR, 0.5))).toBe(0);
    expect(skyOutAt(atFrac(rangeOf("capsOn"), 0.5))).toBe(0);
    // halfway down the window it is on the way out, not at either end
    const mid = skyOutAt(atFrac(rwR, 0.12));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("the sky's way out is monotone", () => {
    const rwR = rangeOf("rewrap");
    let prev = 1;
    for (let i = 0; i <= 60; i++) {
      const v = skyOutAt(
        rangeOf("trails").p0 + (rwR.p1 - rangeOf("trails").p0) * (i / 60),
      );
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  // THE BODY-FADE CHANNEL'S HAND-OVER: hero-driver holds a constant 1 below
  // DIVE_P0 and this module's cover owns it from DIVE_P0 on, off the SAME
  // constant, so the channel has an owner at every p. applyBodyFade holds its
  // last level when a write does not change it, so an unowned band could leave
  // the lens hidden with nothing to restore it.
  it("takes the body-fade channel over from the story with NO unowned p", () => {
    // the seam: the driver holds a constant 1 below DIVE_P0 and the fly opens
    // on 1, so the hand-over is stepless as well as gapless
    expect(flyBodyFadeAt(DIVE_P0)).toBe(1);
    // …and the cover stays out of the way until the lens is behind the camera
    for (let i = 0; i <= 100; i++)
      expect(
        flyBodyFadeAt(DIVE_P0 + (flyR.p1 - DIVE_P0) * (i / 100) * 0.9),
        `dive ${i / 100}`,
      ).toBe(1);
    // the hysteresis band below DIVE_P0, where an already-active fly still
    // writes while hero-driver also does: both are 1, so the double-write is
    // harmless in either order
    expect(flyBodyFadeAt(DIVE_P0 - HYST)).toBe(1);
  });

  it("writes NOTHING to the channel below DIVE_P0 — a deep link into the approach", () => {
    // The other side of the same law, through the real frame(): a jump into the
    // flythrough's approach leaves this module inactive, so it writes no body
    // fade there and hero-driver's tile must reach all the way to DIVE_P0.
    const writes: number[] = [];
    const state: Record<string, number> = {
      zoom: 0,
      explode: 0,
      assemble: 0,
      aperture: 0,
      apertureTarget: 0,
      focus: 0,
      focusTarget: 0,
    };
    const scene = {
      state,
      worldAxialSpans: () => ({}),
      setLensDolly: () => {},
      setStoryFov: () => {},
      setStoryCentre: () => {},
      setBodyFade: (v: number) => writes.push(v),
      setInkMix: () => {},
      setGlassTransmissive: () => {},
      setGlassFade: () => {},
      setGlassElementFade: () => {},
      setGlassGlint: () => {},
      setDust: () => {},
      setRoomLight: () => {},
      setSkyDim: () => {},
      enableStarfield: () => Promise.resolve(true),
      enableWormholePost: () => Promise.resolve(true),
      warmFly: () => Promise.resolve(),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly = createStoryFly(scene);
    // the whole band between the internals scene's end and the dive's first
    // frame
    const inR = rangeOf("internals");
    for (let i = 0; i <= 40; i++)
      fly.evaluate(inR.p1 + (DIVE_P0 - inR.p1) * (i / 40) * 0.999);
    expect(writes).toEqual([]);
    // …and the first frame it does own is written at exactly 1, matching the
    // level hero-driver hands over
    fly.evaluate(DIVE_P0);
    expect(writes).toEqual([1]);
  });

  it("covers the body only where the lens crosses the camera, and reveals it again", () => {
    // ON over the dive's last tenth (FLY.pClear — behind the camera, unseen)…
    expect(flyBodyFadeAt(flyR.p1)).toBe(0);
    expect(flyBodyFadeAt(atFrac(tR, 0.5))).toBe(0);
    // …and OFF again over the reveal, which is a beat of its own
    expect(flyBodyFadeAt(atFrac(rwR, 0.06))).toBe(0);
    expect(flyBodyFadeAt(atFrac(rwR, 0.16))).toBe(1);
    expect(flyBodyFadeAt(EXIT_END)).toBe(1);
  });

  // THE LOOK'S HAND-OVER. materials/unified.ts blends realistic↔ink on one
  // material, but the ELEMENTS still swap (transmission cannot merge), so the
  // ink has to be wholly gone before enter() clones them and may not come back
  // until exit() has handed them over — hysteresis included, at BOTH edges.
  it("the ink is 1 through the story and 0 through the whole dive", () => {
    expect(flyInkAt(0)).toBe(1);
    expect(flyInkAt(atFrac(rangeOf("peel"), 0.5))).toBe(1);
    expect(flyInkAt(atFrac(rangeOf("internals"), 0.5))).toBe(1);
    // the drawing is still whole where the camera STARTS its approach and gone
    // by the time the dive opens — the dissolve rides that swing
    expect(flyInkAt(flyR.p0)).toBe(1);
    expect(flyInkAt(DIVE_P0)).toBe(0);
    expect(flyInkAt(atFrac(flyR, 0.5))).toBe(0);
    expect(flyInkAt(atFrac(rangeOf("trails"), 0.9))).toBe(0);
    expect(flyInkAt(atFrac(rangeOf("capsOn"), 0.5))).toBe(1);
  });

  it("neither ink ramp reaches into the GLASS sub-span, hysteresis included", () => {
    // What the bar protects is the transmissive CLONES: any ink while they are
    // mounted swaps the elements' material out from under them and poisons the
    // clone cache. The clones hold a sub-span of their own ([DIVE_P0,
    // GLASS_OUT]), so the dissolve OUT finishes a slack's width before it opens
    // and the way back starts well past the glass edge — the return ramp itself
    // running inside the active span, deliberately.
    expect(flyInkAt(DIVE_P0 - HYST)).toBe(0);
    expect(flyInkAt(GLASS_OUT)).toBe(0);
    expect(flyInkAt(GLASS_OUT + HYST)).toBe(0);
    // the remount edge on a scrub back down sits below GLASS_OUT − HYST, and
    // the ink is exactly 0 there too (it is 0 all the way down to the rise)
    expect(flyInkAt(GLASS_OUT - 2 * HYST)).toBe(0);
    // a real margin, not an epsilon: the return opens a tenth of the scene
    // above the glass edge
    expect(INK_RETURN[0]).toBeGreaterThan(GLASS_OUT + HYST);
    // …and the reveal window itself plays fully realistic: ink exactly 0
    // until the lens is whole
    expect(flyRevealAt(INK_RETURN[0])).toBe(1);
    expect(flyInkAt(atFrac(rwR, 0.16))).toBe(0);
    // both ramps are real dissolves, not cuts
    const out = flyInkAt(atFrac(flyR, flyR.scene.transit / 2));
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(1);
    const back = flyInkAt(atFrac(rwR, 0.26));
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(1);
  });

  // THE GLASS SUB-SPAN'S STATE MACHINE, through the real frame(): the
  // transmissive swap mounts with the span from the dive side, comes OFF as the
  // scroll crosses GLASS_OUT (under the body cover, so the material cut is on a
  // lens nobody can see), does not come back while scrubbing above the edge,
  // remounts only a hysteresis below it, and NEVER mounts on a downward entry
  // across EXIT_END, where a clone would carry the ink fill and no transmission.
  it("mounts the transmissive glass only inside its own sub-span", () => {
    const calls: boolean[] = [];
    const state: Record<string, number> = {
      zoom: 0,
      explode: 0,
      assemble: 0,
      aperture: 0,
      apertureTarget: 0,
      focus: 0,
      focusTarget: 0,
    };
    const scene = {
      state,
      worldAxialSpans: () => ({}),
      setLensDolly: () => {},
      setStoryFov: () => {},
      setStoryCentre: () => {},
      setBodyFade: () => {},
      setInkMix: () => {},
      setGlassTransmissive: (on: boolean) => calls.push(on),
      setGlassFade: () => {},
      setGlassElementFade: () => {},
      setGlassGlint: () => {},
      setDust: () => {},
      setRoomLight: () => {},
      setSkyDim: () => {},
      enableStarfield: () => Promise.resolve(true),
      enableWormholePost: () => Promise.resolve(true),
      warmFly: () => Promise.resolve(),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly = createStoryFly(scene);
    // in from the dive side: the swap mounts with the span…
    fly.evaluate(atFrac(flyR, 0.5));
    expect(calls).toEqual([true]);
    // …the cover is already down where it will come off…
    expect(flyBodyFadeAt(GLASS_OUT)).toBe(0);
    // …and crossing GLASS_OUT releases it, exactly once
    fly.evaluate(atFrac(rwR, 0.1));
    expect(calls).toEqual([true, false]);
    // scrubbing around ABOVE the edge neither remounts nor re-releases
    fly.evaluate(atFrac(rwR, 0.3));
    fly.evaluate(atFrac(rwR, 0.08));
    expect(calls).toEqual([true, false]);
    // a scrub back below the hysteresis remounts it, under the cover again
    fly.evaluate(GLASS_OUT - 2 * HYST);
    expect(calls).toEqual([true, false, true]);
    // and a DOWNWARD entry across EXIT_END must not mount at all
    const calls2: boolean[] = [];
    const scene2 = {
      ...(scene as unknown as Record<string, unknown>),
      setGlassTransmissive: (on: boolean) => calls2.push(on),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly2 = createStoryFly(scene2);
    fly2.evaluate(atFrac(rwR, 0.45)); // inside the span, above GLASS_OUT
    expect(calls2).toEqual([]);
    fly2.evaluate(atFrac(rwR, 0.3)); // still above — stays unmounted
    expect(calls2).toEqual([]);
  });

  // LEAVE FIRST, THEN THE LOOK, THEN ARRIVE (fly.ts frame): the elements are
  // the one thing that still swaps a material, so exit() hands them back before
  // any ink returns and enter() clones them after the last of it is gone.
  it("frame() leaves, then writes the look, then arrives", () => {
    const log: string[] = [];
    const state: Record<string, number> = {
      zoom: 0,
      explode: 0,
      assemble: 0,
      aperture: 0,
      apertureTarget: 0,
      focus: 0,
      focusTarget: 0,
    };
    const scene = {
      state,
      worldAxialSpans: () => ({}),
      setLensDolly: () => {},
      setStoryFov: () => {},
      setStoryCentre: () => {},
      setBodyFade: () => {},
      setInkMix: (v: number) => log.push(`ink ${v}`),
      setGlassTransmissive: (on: boolean) => log.push(on ? "enter" : "exit"),
      setGlassFade: () => {},
      setGlassElementFade: () => {},
      setGlassGlint: () => {},
      setDust: () => {},
      setRoomLight: () => {},
      setSkyDim: () => {},
      enableStarfield: () => Promise.resolve(true),
      enableWormholePost: () => Promise.resolve(true),
      warmFly: () => Promise.resolve(),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly = createStoryFly(scene);

    // …arriving: the look is written before the span's side effects mount
    log.length = 0;
    fly.evaluate(atFrac(flyR, flyR.scene.transit + 0.05));
    expect(log).toEqual(["ink 0", "enter"]);
    // …leaving: they are torn down before the look is written. Clear of the
    // hysteresis in ABSOLUTE p — HYST is ~5% of the rewrap scene, so a local
    // fraction just past EXIT_END is still inside the span.
    log.length = 0;
    const out = atFrac(rwR, 0.65);
    expect(out).toBeGreaterThan(EXIT_END + HYST);
    fly.evaluate(out);
    expect(log[0]).toBe("exit");
    expect(log[1]).toBe(`ink ${flyInkAt(out)}`);
  });

  it("the composed sky mix is still 0 before the dive's sky window", () => {
    // what fly.ts writes to uStarMix — read from the function frame()
    // itself calls, rather than transcribed here
    const mixAt = flySkyMixAt;
    expect(mixAt(flyR.p0)).toBe(0);
    expect(mixAt(DIVE_P0)).toBe(0);
    expect(mixAt(DIVE_P0 + (flyR.p1 - DIVE_P0) * FLY.pSkyIn[0] * 0.5)).toBe(0);
    // …and full once the window is open, all the way to the reveal's fade
    expect(mixAt(atFrac(rangeOf("trails"), 0.5))).toBe(1);
    expect(mixAt(atFrac(rangeOf("rewrap"), 0.32))).toBe(0);
  });

  it("the span's ramps are ALREADY what exit() leaves, outside the span", () => {
    // exit() zeroes uStarMix, uWormhole/uStarStreak and hands the room light
    // back, and this module writes nothing outside its span — so a reader of
    // the story could only report those values by copying the teardown, unless
    // the ramps are exactly 0 there. They are: below DIVE_P0 none of the four
    // windows has opened, above EXIT_END every one closed earlier, and
    // `smoothstep` is EXACTLY 0/1 at its edges.
    for (let i = 0; i <= 2000; i++) {
      const p = i / 2000;
      if (p >= DIVE_P0 && p <= EXIT_END) continue;
      expect(flySkyMixAt(p), `skyMix ${p}`).toBe(0);
      expect(flyDarkAt(p), `dark ${p}`).toBe(0);
      expect(flyWarpAt(p), `warp ${p}`).toBe(0);
      expect(flyStreakAt(p), `streak ${p}`).toBe(0);
    }
    // the edges themselves, off the lattice
    for (const p of [0, DIVE_P0 - HYST, EXIT_END + HYST, 1]) {
      expect(flySkyMixAt(p), `skyMix ${p}`).toBe(0);
      expect(flyDarkAt(p), `dark ${p}`).toBe(0);
    }
  });

  it("names the one-line compositions frame() used to write inline", () => {
    // a value composed inside frame() cannot be reported without a second copy
    // of it, so each has a name in its owner and these pin the compositions
    for (let i = 0; i <= 400; i++) {
      const p = i / 400;
      expect(flyCentreAt(p), `centre ${p}`).toBe(1 - flyInkAt(p));
      expect(flyFovMixAt(p), `fovMix ${p}`).toBe(1 - flyFovBackAt(p));
      expect(flySkyMixAt(p), `skyMix ${p}`).toBe(
        flySkyInAt(flyDiveP(p)) * skyOutAt(p),
      );
      expect(flyDarkAt(p), `dark ${p}`).toBe(
        smoothstep(FLY.pDark[0], FLY.pDark[1], flyDiveP(p)) * skyOutAt(p),
      );
      expect(flyFocusAt(flyDiveP(p)), `focus ${p}`).toBe(
        smoothstep(FLY.pFocus[0], FLY.pFocus[1], flyDiveP(p)),
      );
    }
    // the fov the override is HELD at: the pose's own, or the park's where a
    // path segment omits it
    expect(flyFovOf({ azimuth: 0, elevation: 0, distance: 1 })).toBe(
      FLY.fovFar,
    );
    expect(flyFovOf({ azimuth: 0, elevation: 0, distance: 1, fov: 31 })).toBe(
      31,
    );
  });

  // THE WARP LIVES AND DIES WITH THE DIVE'S MOTION, on the dive's own clock: a
  // sustain into the sky scenes parks the frame at meaningful warp strength
  // after the travel has ended, which reads as a pause. The laws, not numbers:
  describe("the wormhole envelope", () => {
    it("is exactly 0 for every frame of the trails scene and after", () => {
      // The star trails are circles concentric with the frame and a radial
      // pinch would draw them as ellipses, so the envelope has to be 0 — not
      // nearly 0 — from the trails scene on.
      for (let i = 0; i <= 400; i++) {
        const p = tR.p0 + (rwR.p1 - tR.p0) * (i / 400);
        expect(flyWarpAt(p)).toBe(0);
        expect(flyStreakAt(p)).toBe(0);
      }
    });

    it("is exactly 0 on every frame the QUOTE is drawn on", () => {
      // The quote is canvas quads in the scene and this pass would bend the
      // glyphs, so the law is a coupling — "no warp wherever the quote is live"
      // — read from the envelope that owns it rather than from numbers.
      let live = 0;
      for (let i = 0; i <= 4000; i++) {
        const p = coR.p0 + (1 - coR.p0) * (i / 4000);
        if (quoteEnvAt(p) <= 0) continue;
        live++;
        expect(flyWarpAt(p)).toBe(0);
        expect(flyStreakAt(p)).toBe(0);
      }
      // …over a real stretch of scroll, so the sweep above cannot pass by
      // finding nothing, and with the warp alive somewhere at all (mid-dive —
      // otherwise "0 under the quote" would be true of a dead ramp).
      expect(live).toBeGreaterThan(1000);
      expect(flyWarpAt(atFrac(flyR, 0.6))).toBeGreaterThan(0);
    });

    it("dies with the dive's motion — no parked full-warp frames", () => {
      // The fall is spent at FLY.pWormhole[2], while the travel still has its
      // slow drift to run, so every frame with meaningful warp strength is one
      // the dive is visibly moving through.
      expect(flyWarpAt(flyR.p1)).toBe(0);
      expect(flyStreakAt(flyR.p1)).toBe(0);
      expect(flyWarpAt(atFrac(coR, 0.2))).toBe(0);
      // still a real feature mid-dive
      expect(flyWarpAt(atFrac(flyR, 0.55))).toBeGreaterThan(0.5);
    });

    it("is 0 before the dive, and never goes back up", () => {
      // exactly 0 at the park (the rise's own first edge is the dive's 0)…
      expect(flyWarpAt(flyR.p0)).toBe(0);
      expect(flyWarpAt(DIVE_P0)).toBe(0);
      expect(flyStreakAt(DIVE_P0)).toBe(0);
      // …one rise, one fall, no second lobe: the sampled envelope climbs to a
      // single peak and comes down, for both ramps.
      for (const f of [flyWarpAt, flyStreakAt]) {
        const xs = Array.from({ length: 601 }, (_, i) => {
          const p = DIVE_P0 + (tR.p0 - DIVE_P0) * (i / 600);
          return f(p);
        });
        const peak = xs.indexOf(Math.max(...xs));
        for (let i = 1; i <= peak; i++)
          expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1e-12);
        for (let i = peak + 1; i < xs.length; i++)
          expect(xs[i]).toBeLessThanOrEqual(xs[i - 1] + 1e-12);
      }
    });

    it("ends both halves of the ring on the same frame", () => {
      // `uStarRing` (the sprites' swing to tangential) is written from the WARP
      // ramp and the streaks are what it swings, so the two may not outlive
      // each other — which is why flyStreakAt's FALL rides FLY.pWormhole's.
      const zeroAt = (f: (p: number) => number) => {
        for (let i = 0; i <= 2000; i++) {
          const p = DIVE_P0 + (tR.p0 - DIVE_P0) * (i / 2000);
          if (i > 1000 && f(p) === 0) return p;
        }
        return Number.NaN;
      };
      expect(zeroAt(flyWarpAt)).toBeCloseTo(zeroAt(flyStreakAt), 12);
    });
  });
});
