import { describe, expect, it } from "vitest";
import { fakeScene, installHeroDom } from "./fake-scene";
import { uInkFill } from "../../materials/unified";
import { uStarMix, uStarStreak } from "../../optics/starfield";
import { uWormhole } from "../../optics/wormhole-post";
import { STORY_SAMPLE_PS, storyStateAt } from "../state";
import { atFrac, rangeOf, sceneIndexAt } from "../story";
import { STORY_KNOBS, dustAt, fStopOf } from "../envelopes";
import { recipeKnob } from "../../ops/host";
import type { RecipeName } from "../../ops/recipes";

// Boots hero-driver against a recording SceneHandle and stub markup, runs its
// evaluate callbacks like core/scene's tick, and checks every write against
// storyStateAt(p).

const TRACK = 11_000;
const VIEW = 1000;
/** the boot scroll position: inside the dive, so fly.ts loads at once */
const P0 = 0.5;
const dom = installHeroDom({
  scrollY: P0 * (TRACK - VIEW),
  trackHeight: TRACK,
  innerHeight: VIEW,
});
const fake = fakeScene();
const { startHeroStory } = await import("../hero-driver");
startHeroStory(fake.scene);
// let fly.ts's dynamic import land
await new Promise((r) => setTimeout(r, 50));

const PS: number[] = (() => {
  const s = new Set(STORY_SAMPLE_PS);
  for (let i = 0; i <= 200; i++) s.add(i / 200);
  return [...s].sort((a, b) => a - b);
})();

/** the fov override as core/scene reads it: null unless a mix is in force */
const fovOf = (w: unknown) => {
  if (!Array.isArray(w)) return null;
  const [fov, mix] = w as [number | null, number];
  return fov === null || mix <= 0 ? null : { fov, mix };
};

describe("the boot", () => {
  it("SNAPS the eased p onto the scroll, so a deep link opens on its pose", () => {
    expect(fake.state.storyTarget).toBe(P0);
    expect(fake.state.story).toBe(P0);
  });

  it("sets every recipe knob the story names", () => {
    for (const [name, knobs] of Object.entries(STORY_KNOBS))
      for (const [knob, v] of Object.entries(knobs))
        expect(recipeKnob(name as RecipeName, knob).value, knob).toBe(v);
  });

  it("spells the chrome at the raw scroll p on a scroll event", () => {
    const p = atFrac(rangeOf("constellations"), 0.5);
    dom.scroll(p * (TRACK - VIEW));
    expect(fake.state.storyTarget).toBeCloseTo(p, 12);
    expect(dom.hud.textContent).toContain(
      `SCN ${String(sceneIndexAt(p)).padStart(2, "0")}`,
    );
  });

  it("sets the 3D target in the scroll event, before the frame's rAF tick reads it", () => {
    const p = atFrac(rangeOf("trails"), 0.5);
    dom.scrollEvent(p * (TRACK - VIEW));
    expect(fake.state.storyTarget).toBeCloseTo(p, 12);
  });
});

describe("the evaluate step", () => {
  const driverCb = fake.evaluateCbs[fake.evaluateCbs.length - 1];

  it("draws exactly what storyStateAt reports, at every edge and between", () => {
    let flyFrames = 0;
    for (const p of PS) {
      fake.evaluate(p);
      const s = storyStateAt(p);
      const w = fake.writes;
      const at = `p ${p}`;
      for (const c of [
        "zoom",
        "explode",
        "assemble",
        "huddle",
        "peel",
        "rose",
      ] as const)
        expect(fake.state[c], `${c} ${at}`).toBe(s.channels[c]);
      // inside the internals span the iris runs on a clock
      if (s.irisOwner !== "internals") {
        expect(fake.state.aperture, `aperture ${at}`).toBe(s.channels.aperture);
        expect(fake.state.focus, `focus ${at}`).toBe(s.channels.focus);
      }
      expect(w.setModelOrientation, `orientation ${at}`).toEqual({
        x: s.model.rollX,
        y: s.model.turnY,
        z: s.model.tiltZ,
      });
      expect(uInkFill.value, `inkFill ${at}`).toBe(s.look.inkFill);
      expect(w.setShellFade, `shellFade ${at}`).toBe(s.look.shellFade);
      expect(w.setInteriorFade, `interiorFade ${at}`).toBe(s.look.interiorFade);
      expect(w.setBodyFade, `bodyFade ${at}`).toBe(s.look.bodyFade);
      expect(w.setDust, `dust ${at}`).toBe(s.look.dust);
      expect(w.setInkMix, `inkMix ${at}`).toBe(s.look.inkMix);
      expect(w.setStoryCentre, `centre ${at}`).toBe(s.look.storyCentre);
      expect(w.setLensDolly ?? 0, `dolly ${at}`).toBe(s.model.dollyX);
      expect(fovOf(w.setStoryFov), `fov ${at}`).toEqual(
        s.look.storyFov && s.look.storyFov.mix > 0 ? s.look.storyFov : null,
      );
      expect(uStarMix.value, `skyMix ${at}`).toBe(s.look.skyMix);
      expect(uWormhole.value, `warp ${at}`).toBe(s.look.warp);
      expect(uStarStreak.value, `streak ${at}`).toBe(s.look.streak);
      if (s.irisOwner === "fly") flyFrames++;
    }
    // fly.ts really was loaded and driven
    expect(flyFrames).toBeGreaterThan(20);
  });

  it("never asks for a frame of its own, and skips a pE it has drawn", () => {
    const p = atFrac(rangeOf("peel"), 0.5);
    expect(driverCb(p, 16)).toBe(false);
    const n = fake.calls.length;
    expect(driverCb(p, 16)).toBe(false);
    expect(fake.calls.length, "a parked story writes nothing").toBe(n);
  });

  it("writes the dust from ONE law, whatever the resume order", () => {
    // a resume that jumps the eased p from the bloom back into the dive
    fake.evaluate(1);
    expect(fake.writes.setDust).toBe(dustAt(1));
    fake.evaluate(0.62);
    expect(fake.writes.setDust).toBe(dustAt(0.62));
    expect(dustAt(0.62)).toBe(false);
  });

  it("spells the HUD f-stop from the DRAWN iris, after the render", () => {
    for (const p of [
      atFrac(rangeOf("internals"), 0.3),
      atFrac(rangeOf("flythrough"), 0.6),
      1,
    ]) {
      fake.evaluate(p);
      fake.frame();
      expect(dom.hud.textContent, `p ${p}`).toContain(
        `f/${fStopOf(fake.state.aperture)}`,
      );
    }
  });
});
