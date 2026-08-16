import { describe, expect, it } from "vitest";
import { FLY, poseCamX } from "../../optics/fly-core";
import { smoothstep } from "../../core/math";
import {
  STORY_R,
  rangeOf,
  atFrac,
  CAM_RELEASE_F,
  DIVE_P0,
  REVEAL_END,
} from "../story";
import { peelBodyFadeAt } from "../peelcards";
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

// createStoryFly's theme watcher reads the document (core/theme.ts) — the only
// DOM this file's subject touches, and only from inside the factory, so a stub
// here is enough.
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
// DIVE_P0 — the dive's first frame, the end of the flythrough scene's approach
// — is imported from story.ts, which is where fly.ts and hero-driver both read
// it. It used to be re-derived here, which is the copy this file exists to
// prevent.

describe("story fly span", () => {
  // THE EQUIVALENCE THE WHOLE SPAN RESTS ON. The dive is authored as a camera
  // flying to camX; it is PLAYED as a lens at X_PARK − camX in front of a camera
  // parked at X_PARK. That only reproduces the demo's frames if the story rig's
  // own parked pose IS the dive's opening pose — hence the story row is written
  // from FLY.distFar, and this is the tripwire on that.
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
    // THE GATING LAW, RESTATED (the owner moved the ink return under the
    // seat). It used to be "dolly ≠ 0 ⇒ ink exactly 0", and its PURPOSE was
    // the depth fade: the ink's opacity rides ×uInk × depthFade, and the fade
    // planes were placed from the camera's distance to the ORIGIN — ink over a
    // dollied lens dissolved it. The planes now track the SUBJECT — the orbit
    // target plus the lens' own dolly (core/scene.ts fade-plane block) — so
    // the fade is correct at every dolly and the ink needs no dolly gate. What
    // the law still protects, on the WAY OUT, is the look itself: the whole
    // dive plays realistic, so the ink must be gone by the dive's first frame
    // and stay gone until the reveal has fully drawn the lens.
    for (let i = 0; i <= 400; i++) {
      const p = DIVE_P0 + (INK_RETURN[0] - DIVE_P0) * (i / 400);
      expect(flyInkAt(p), `ink at p ${p}`).toBe(0);
    }
    // THE RETURN NOW OVERLAPS THE SEAT BY DESIGN: the ink is live from
    // rewrap-local 0.16 while the overshoot gives itself back over
    // [REVEAL_END, 0.34] — the exact overlap the tracked planes license.
    const seating = atFrac(rwR, 0.3);
    expect(flyDollyAt(seating)).toBeGreaterThan(0);
    expect(flyInkAt(seating)).toBeGreaterThan(0);
    // …and the look is FULLY ink well before caps-on (the owner's far edge)
    expect(flyInkAt(atFrac(rwR, 0.5))).toBe(1);
    expect(flyInkAt(atFrac(rangeOf("capsOn"), 0.1))).toBe(1);
  });

  // THE RETURN IS BLIND, AND THE COVER IS WHAT MAKES IT SO. The lens travels 28
  // units straight through the camera's own position, so the law is not "under
  // the sky" (the sky is still whole for most of it) but "before anything can
  // see it": the return must be FINISHED by the first frame of the reveal, which
  // is where story/fly.ts lifts the body cover.
  //
  // IT DOES NOT RETURN HOME, THOUGH — it returns to REVEAL_X, three and a half
  // units PAST home, and stands there for the whole reveal (owner: "the lens is
  // a bit too close to the camera during the reveal"). The last leg is a beat of
  // its own, after the reveal, with the camera's move.
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

  // THE REVEAL'S OWN ORDER (task 69). The owner's beat is: the exploded, still
  // spinning lens crossfades in UNDER the last of the star trails, and the
  // framing only comes back once the sky it would scale is gone.
  it("uncovers the lens while the trails are still on screen, and hands the fov back after they are gone", () => {
    // covered for every frame of the journey home…
    expect(flyRevealAt(atFrac(tR, 0.95))).toBe(0);
    expect(flyRevealAt(rwR.p0)).toBe(0);
    expect(flyRevealAt(atFrac(rwR, 0.06))).toBe(0);
    // …then up while the field is still fading (story/trails.ts trailEnvAt runs
    // its fall over rewrap-local [0.02, 0.28]) — the crossfade the owner asked
    // for is this overlap, and the fluid-transition correction made it LONG:
    // the shell is fully drawn at 0.16 with the arcs' fall not even half spent,
    // so the two figures share the frame for 0.12 of the scene after the
    // crossfade tops out (the trail side of the law is pinned in trails.test.ts)
    const during = flyRevealAt(atFrac(rwR, 0.11));
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(1);
    expect(flyRevealAt(atFrac(rwR, 0.16))).toBe(1);
    expect(atFrac(rwR, 0.16)).toBeLessThan(atFrac(rwR, 0.28));
    // THE FRAMING WAITS FOR THE SKY IT WOULD SCALE. The fov hand-back is a
    // 1.8× push-in, i.e. a camera move in everything but name; its first edge
    // is the frame the starfield's own fade lands on exactly 0 (the coupling
    // to skyOutAt, pinned here against the function, not the number) — the
    // earliest frame it cannot bend a star or a live trail — and it must be
    // finished BEFORE the span's edge, where exit() cuts the override.
    expect(skyOutAt(FOV_BACK[0])).toBe(0);
    expect(skyOutAt(FOV_BACK[0] - (rwR.p1 - rwR.p0) * 0.01)).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[0])).toBe(0);
    expect(flyFovBackAt(atFrac(rwR, 0.4))).toBeGreaterThan(0);
    expect(flyFovBackAt(FOV_BACK[1])).toBe(1);
    expect(FOV_BACK[1]).toBeLessThan(EXIT_END);
    expect(flyFovBackAt(EXIT_END)).toBe(1);
  });

  // THE STAGGERED ONSETS (owner: the trails→reassemble camera work was "very
  // jarring"). Three movers used to start on the SAME frame out of a bit-still
  // hold — the fused chain, the fov push-in and the dolly's last leg, all on
  // REVEAL_END — a dead stop into a fast move. Each now has its own edge, in
  // a fixed order, so no frame carries more than one onset: the chain creeps
  // first (CAM_RELEASE_F, the reveal crossfade's top — pinned against
  // flyRevealAt below, which story-camera.test.ts cannot import), the seat
  // waits for the exploded radius to be spent (REVEAL_END), and the fov push
  // opens at the sky's far edge. The ORDER of the last two swapped with the
  // fluid-transition correction — the sky's exit moved past REVEAL_END, and
  // the fov must wait for the sky it would scale — but the de-stack's actual
  // law (no frame gains a second onset) holds either way.
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
    // …still ALIVE over the whole reveal and collapse (the fluid hand-over:
    // REVEAL_END sits inside the fade), and gone at SKY_OUT_END — well before
    // the span's own edge (EXIT_END, rewrap-local 0.58), so the fade is
    // finished long before the span tears itself down
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

  // THE BODY-FADE CHANNEL'S HAND-OVER — the other half of the range-tiled
  // writer map. hero-driver writes story/peelcards.ts's peelBodyFadeAt for every
  // p BELOW DIVE_P0 and this module's cover from DIVE_P0 on, off the SAME
  // constant, so the channel has an owner at every p. It did not: the tile used
  // to end at the flythrough scene's p0, 0.024 of p earlier, and applyBodyFade
  // holds its last level when a write does not change it — so a frame(p) that
  // jumped out of the peel/cards valley (level 0) into that band left the whole
  // lens hidden, ink and glass with it, for the dive's entire approach, with
  // nothing to restore it until a frame landed outside the band again.
  it("takes the body-fade channel over from the story with NO unowned p", () => {
    // the seam itself: both owners write exactly 1 where they meet, so the
    // hand-over is not just gapless but stepless
    expect(peelBodyFadeAt(DIVE_P0)).toBe(1);
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
    expect(peelBodyFadeAt(DIVE_P0 - HYST)).toBe(1);
  });

  it("writes NOTHING to the channel below DIVE_P0 — a deep link into the approach", () => {
    // The other side of the same law, driven through the real frame(): a jump
    // straight into the flythrough's approach (the ?story scrubber, a deep link,
    // a wheel flick) leaves this module inactive, so it writes no body fade at
    // all there. Whatever level the channel was last left at is what the frame
    // renders — which is why hero-driver's tile has to reach all the way to
    // DIVE_P0 and not merely to the scene's p0.
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
    // frame — 0.024 of p, the stretch that used to have no owner at all
    const inR = rangeOf("internals");
    for (let i = 0; i <= 40; i++)
      fly.frame(inR.p1 + (DIVE_P0 - inR.p1) * (i / 40) * 0.999);
    expect(writes).toEqual([]);
    // …and the first frame it does own is written at exactly 1, matching the
    // level hero-driver hands over
    fly.frame(DIVE_P0);
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
    // THE RESTATED HYSTERESIS LAW. The ink used to be barred from the whole
    // span; what that actually protected was the transmissive CLONES — any ink
    // at all while they are mounted would swap the elements' material out from
    // under them (materials/unified.ts GLASS_HANDOVER) and poison the clone
    // cache. The clones now have a sub-span of their own ([DIVE_P0, GLASS_OUT],
    // released under the body cover before the reveal), so the bar follows
    // them: the dissolve OUT is finished a slack's width BEFORE the span
    // opens, and the way back does not start until well past the glass edge —
    // the return ramp itself now runs INSIDE the active span, deliberately
    // (the owner moved it to right after the lens appears).
    expect(flyInkAt(DIVE_P0 - HYST)).toBe(0);
    expect(flyInkAt(GLASS_OUT)).toBe(0);
    expect(flyInkAt(GLASS_OUT + HYST)).toBe(0);
    // the remount edge on a scrub back down sits below GLASS_OUT − HYST, and
    // the ink is exactly 0 there too (it is 0 all the way down to the rise)
    expect(flyInkAt(GLASS_OUT - 2 * HYST)).toBe(0);
    // a REAL margin, not an epsilon: the return opens a tenth of the scene
    // above the glass edge
    expect(INK_RETURN[0]).toBeGreaterThan(GLASS_OUT + HYST);
    // …and the reveal window itself plays fully realistic (the owner's
    // "appearance stays realistic"): ink exactly 0 until the lens is whole
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

  // THE GLASS SUB-SPAN'S STATE MACHINE, driven through the real frame(): the
  // transmissive swap mounts with the span from the dive side, comes OFF as
  // the scroll crosses GLASS_OUT (under the body cover — flyBodyFadeAt is 0
  // there — so the material cut is on a lens nobody can see), does NOT come
  // back while scrubbing above the edge, remounts only a hysteresis below it,
  // and NEVER mounts on a downward entry across EXIT_END, where the elements
  // are already wearing their ink fill (a clone of that material would carry
  // no transmission and would poison the clone cache).
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
    fly.frame(atFrac(flyR, 0.5));
    expect(calls).toEqual([true]);
    // …the cover is already down where it will come off…
    expect(flyBodyFadeAt(GLASS_OUT)).toBe(0);
    // …and crossing GLASS_OUT releases it, exactly once
    fly.frame(atFrac(rwR, 0.1));
    expect(calls).toEqual([true, false]);
    // scrubbing around ABOVE the edge neither remounts nor re-releases
    fly.frame(atFrac(rwR, 0.3));
    fly.frame(atFrac(rwR, 0.08));
    expect(calls).toEqual([true, false]);
    // a scrub back below the hysteresis remounts it, under the cover again
    fly.frame(GLASS_OUT - 2 * HYST);
    expect(calls).toEqual([true, false, true]);
    // and a DOWNWARD entry across EXIT_END must not mount at all
    const calls2: boolean[] = [];
    const scene2 = {
      ...(scene as unknown as Record<string, unknown>),
      setGlassTransmissive: (on: boolean) => calls2.push(on),
    } as unknown as Parameters<typeof createStoryFly>[0];
    const fly2 = createStoryFly(scene2);
    fly2.frame(atFrac(rwR, 0.45)); // inside the span, above GLASS_OUT
    expect(calls2).toEqual([]);
    fly2.frame(atFrac(rwR, 0.3)); // still above — stays unmounted
    expect(calls2).toEqual([]);
  });

  // LEAVE FIRST, THEN THE LOOK, THEN ARRIVE (fly.ts frame). The elements are the
  // one thing that still swaps a material, so exit() has to hand them back
  // BEFORE any ink can return to them and enter() has to clone them AFTER the
  // last of it is gone. The ramps keep the two apart in TIME; this pins the
  // order the file is written in, which is what keeps that true if an edge moves.
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
    fly.frame(atFrac(flyR, flyR.scene.transit + 0.05));
    expect(log).toEqual(["ink 0", "enter"]);
    // …leaving: they are torn down before the look is written. Clear of the
    // hysteresis in ABSOLUTE p — HYST is ~5% of the rewrap scene, so a local
    // fraction just past EXIT_END is still inside the span.
    log.length = 0;
    const out = atFrac(rwR, 0.65);
    expect(out).toBeGreaterThan(EXIT_END + HYST);
    fly.frame(out);
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
    // WHY THIS IS A LAW AND NOT A CURIOSITY: exit() zeroes uStarMix,
    // uWormhole/uStarStreak and hands the room light back, and this module writes
    // nothing at all outside its span — so a reader of the story (story/state.ts,
    // the STORY-MAP) can only report those values by copying the teardown…
    // unless the ramps themselves are exactly 0 there, which they are: below
    // DIVE_P0 the dive progress is 0 and none of the four windows has opened,
    // and above EXIT_END every one of them closed earlier (the sky by
    // SKY_OUT_END, rewrap-local 0.32; the pinch and the streaks a whole scene
    // before that).
    // `smoothstep` is EXACTLY 0/1 at its edges, so these are not epsilons.
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
    // the class the review found: a value composed inside frame() cannot be
    // reported without a second copy of it, so each got a name in its owner.
    // These pin the compositions themselves; that frame() CALLS them is
    // structural (it holds no expression of its own for any of the four).
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

  // THE WARP LIVES AND DIES WITH THE DIVE'S MOTION — the demo's own arc, back
  // on the demo's own clock. It was briefly SUSTAINED into the sky scenes
  // (task 62 re-hosted the fall onto scroll), and the owner walked that back:
  // the sustain parked the frame at meaningful warp strength after the dive's
  // travel had ended, and "No pause. I just wanted the ring to look better
  // when you slowly scroll down." The ring's visual-quality work from that
  // task (mask co-location, profile, radius-scaled widths) lives in optics/,
  // untouched; only the envelope came home. The laws, not the numbers:
  describe("the wormhole envelope", () => {
    it("is exactly 0 for every frame of the trails scene and after", () => {
      // THE HARD ONE. The star trails are perfect circles concentric with the
      // frame (optics/starfield.ts SKY_SPIN_ELEV_RAD = 0, on-axis pole) and a
      // radial pinch would draw them as ellipses — so the envelope has to be 0,
      // not nearly 0, from the trails scene on. Dying on the dive's clock, it
      // is out by 0.84 of the dive — two whole scenes of margin.
      for (let i = 0; i <= 400; i++) {
        const p = tR.p0 + (rwR.p1 - tR.p0) * (i / 400);
        expect(flyWarpAt(p)).toBe(0);
        expect(flyStreakAt(p)).toBe(0);
      }
    });

    it("is exactly 0 on every frame the QUOTE is drawn on", () => {
      // THE OTHER EDGE, read from the thing that owns it. The quote is canvas
      // quads in the scene (story/constellations.ts) and this pass would bend
      // the glyphs, so the law is a coupling — "no warp wherever the quote is
      // live" — not a pair of numbers. Trivial now that the fall ends inside
      // the flythrough scene, but kept as the tripwire for any future sustain.
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
      // THE OWNER CORRECTION (supersedes task 62's sustain law, which pinned
      // the opposite: WARP_OUT[1] > flyR.p1). The fall is spent at
      // FLY.pWormhole[2] = 0.84 of the dive, while the travel itself still has
      // its slow drift to run — so every frame with meaningful warp strength
      // is a frame the dive is visibly moving through, and the sky scenes
      // arrive with the bend already gone.
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
      // each other: one feature, one edge — which is why flyStreakAt's FALL
      // rides FLY.pWormhole's rather than FLY.pStreak's (the one deliberate
      // story-side deviation from the demo's ramps that remains).
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
