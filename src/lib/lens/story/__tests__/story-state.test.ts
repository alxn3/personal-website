import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three/webgpu";
import { DIVE_P0, RANGES, atFrac, rangeOf } from "../story";
import { sampleStory } from "../camera";
import {
  assembleAt,
  bgAt,
  chromeAt,
  driverOwnsIris,
  explodeAt,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  preShutAt,
  rockYAt,
  sceneIndexAt,
  scrollCueAt,
  shellFadeAt,
  zoomAt,
} from "../envelopes";
import { revealRollAt, turnAt } from "../reveal";
import { peelRollAt, peelTurnAt } from "../peelcards";
import { internalsEnvAt } from "../internals";
import {
  EXIT_END,
  flyApertureAt,
  flyBodyFadeAt,
  flyCentreAt,
  flyDarkAt,
  flyDiveP,
  flyDollyAt,
  flyFocusAt,
  flyFovMixAt,
  flyFovOf,
  flyInkAt,
  flyPoseAt,
  flyRevealAt,
  flySkyMixAt,
  flyStreakAt,
  flyWarpAt,
} from "../fly";
import { trailSweepAt } from "../trails";
import { STORY_SAMPLE_PS, STORY_WINDOWS, storyStateAt } from "../state";

// ============================================================================
// WHAT PINS THE REPORT TO THE DRIVERS' TRUTH.
//
// story/state.ts is a composition, not a model: every field must be the value
// of the function whose module OWNS it — the same function the driver calls.
// That is checkable directly, and it is the only guard that matters, because a
// report that re-derives a law is exactly the rot this whole surface exists to
// kill (story/__tests__/reveal.test.ts used to rebuild the explode channel by
// hand; story/internals.ts used to keep a textual twin of the pre-shut ramp).
//
// The other half is the CHUNK LAW: story/state.ts drags optics/ in through
// fly.ts / trails.ts / constellations.ts, so a single static import of it from
// anything on the hero's path would put the whole dive in the homepage's first
// chunk. That is asserted on the SOURCE below and verified on the built output
// in the report; both, because the build check is not in `npm test`.
// ============================================================================

const rwR = rangeOf("rewrap");

/** the sample the laws below walk: every edge, plus a fine grid so a field that
 *  is only wrong mid-ramp cannot hide between two edges */
const PS: number[] = (() => {
  const s = new Set(STORY_SAMPLE_PS);
  for (let i = 0; i <= 400; i++) s.add(i / 400);
  return [...s].sort((a, b) => a - b);
})();

describe("storyStateAt agrees with the modules that own each law", () => {
  it("reports the channels the drivers write", () => {
    for (const p of PS) {
      const s = storyStateAt(p);
      expect(s.channels.zoom, `zoom ${p}`).toBe(zoomAt(p));
      expect(s.channels.explode, `explode ${p}`).toBe(explodeAt(p));
      expect(s.channels.assemble, `assemble ${p}`).toBe(assembleAt(p));
      // the sticker peel is /lens's: the story has no writer for it
      expect(s.channels.peel, `peel ${p}`).toBe(0);
      expect(s.channels.story, `story ${p}`).toBe(p);
      expect(s.hud.focalMm, `focal ${p}`).toBe(focalMmAt(zoomAt(p)));
    }
  });

  it("reports the look and the sky from their owners", () => {
    for (const p of PS) {
      const s = storyStateAt(p);
      expect(s.look.inkFill, `inkFill ${p}`).toBe(inkFillAt(p));
      expect(s.look.inkMix, `inkMix ${p}`).toBe(flyInkAt(p));
      expect(s.look.storyCentre, `storyCentre ${p}`).toBe(flyCentreAt(p));
      expect(s.look.shellFade, `shellFade ${p}`).toBe(shellFadeAt(p));
      expect(s.look.interiorFade, `interiorFade ${p}`).toBe(interiorFadeAt(p));
      expect(s.look.reveal, `reveal ${p}`).toBe(flyRevealAt(p));
      // the fly's span uniforms, read from their owner at EVERY p — the report
      // does not zero them outside the span, because the ramps already are
      // (pinned against exit()'s teardown in __tests__/story-fly.test.ts)
      expect(s.look.skyMix, `skyMix ${p}`).toBe(flySkyMixAt(p));
      expect(s.look.warp, `warp ${p}`).toBe(flyWarpAt(p));
      expect(s.look.streak, `streak ${p}`).toBe(flyStreakAt(p));
      expect(s.look.dark, `dark ${p}`).toBe(flyDarkAt(p));
      // …and the fov override, which the span DOES release: a pair inside it,
      // null outside, where exit() cuts it rather than ramping it
      const inFly = p >= DIVE_P0 && p <= EXIT_END;
      expect(s.look.storyFov, `storyFov ${p}`).toEqual(
        inFly ? { fov: flyFovOf(flyPoseAt(p)), mix: flyFovMixAt(p) } : null,
      );
      expect(s.look.bg, `bg ${p}`).toEqual(bgAt(p, false));
      expect(storyStateAt(p, { light: true }).look.bg).toEqual(bgAt(p, true));
      expect(s.sky.turn, `turn ${p}`).toBe(turnAt(p));
      expect(s.sky.trailSweep, `sweep ${p}`).toBe(trailSweepAt(p));
      expect(s.ambient, `ambient ${p}`).toEqual(internalsEnvAt(p));
      expect(s.hud.chrome, `chrome ${p}`).toBe(chromeAt(p));
      expect(s.hud.scrollCue, `scrollCue ${p}`).toBe(scrollCueAt(p));
    }
  });

  it("reports the model's placement — the ONE orientation the driver writes", () => {
    // hero-driver writes exactly these three axes in its single
    // setModelOrientation call; they are disjoint in p but for the ending's
    // rock, which rides two of them at once, and the report keeps them separate
    // so the map can show which one is live.
    for (const p of PS) {
      const s = storyStateAt(p);
      // the roll's gate is the EXPLODE channel (story/reveal.ts — the spin
      // lives through the whole visible reveal, at a constant radius)
      expect(s.model.revealRoll, `revealRoll ${p}`).toBe(
        revealRollAt(p, explodeAt(p)),
      );
      expect(s.model.peelRoll, `peelRoll ${p}`).toBe(peelRollAt(p));
      expect(s.model.turnY, `turnY ${p}`).toBe(peelTurnAt(p) + rockYAt(p));
      expect(s.model.rollX, `rollX ${p}`).toBe(
        peelRollAt(p) + revealRollAt(p, explodeAt(p)),
      );
      expect(s.model.dollyX, `dolly ${p}`).toBe(flyDollyAt(p));
    }
  });

  it("reports the camera story/camera.ts samples", () => {
    for (const p of PS) {
      const pos = new THREE.Vector3();
      const up = new THREE.Vector3();
      const target = new THREE.Vector3();
      const sample = sampleStory(p, pos, up, target);
      const s = storyStateAt(p);
      expect(s.camera.fov, `fov ${p}`).toBe(sample.fov);
      expect(s.camera.xs, `xs ${p}`).toBe(sample.xs);
      expect(s.camera.ys, `ys ${p}`).toBe(sample.ys);
      expect(s.camera.pos, `pos ${p}`).toEqual(pos.toArray());
      expect(s.camera.up, `up ${p}`).toEqual(up.toArray());
      expect(s.camera.target, `target ${p}`).toEqual(target.toArray());
      expect(s.camera.radius, `radius ${p}`).toBe(pos.length());
    }
  });

  it("reports the scene the driver's HUD names", () => {
    for (const p of PS) {
      const s = storyStateAt(p);
      const i = sceneIndexAt(p);
      expect(s.scene.index, `index ${p}`).toBe(i);
      expect(s.scene.id).toBe(RANGES[i].scene.id);
      expect(s.hud.scn).toBe(String(i).padStart(2, "0"));
      expect(s.hud.title).toBe(RANGES[i].scene.title);
      expect(s.hud.explodePct).toBe(Math.round(explodeAt(p) * 100));
    }
  });
});

describe("the writer maps, as the report sees them", () => {
  it("tiles the iris across p with no gap and no overlap", () => {
    // three writers, separated by RANGE rather than by rAF order. Every p has
    // exactly one, and the fly wins inside its own span because its writes land
    // last in the driver's frame().
    for (const p of PS) {
      const s = storyStateAt(p);
      const inFly = p >= DIVE_P0 && p <= EXIT_END;
      expect(s.irisOwner, `owner ${p}`).toBe(
        inFly ? "fly" : driverOwnsIris(p) ? "driver" : "internals",
      );
      // the value is knowable exactly where a p-only law owns it
      if (s.irisOwner === "driver") {
        expect(s.channels.focus).toBe(0);
        expect(s.channels.aperture).toBe(preShutAt(p));
        expect(s.hud.fStop).not.toBe(null);
      } else if (s.irisOwner === "fly") {
        expect(s.channels.aperture).toBe(flyApertureAt(flyDiveP(p)));
        // both of the fly's iris ramps are its own exported laws — the rack
        // used to be written inline in frame() and reported as null here
        expect(s.channels.focus).toBe(flyFocusAt(flyDiveP(p)));
        expect(s.hud.fStop).not.toBe(null);
      } else {
        // the internals ambient runs on a phase clock — only the envelopes are
        // a function of p, and they are reported in `ambient`
        expect(s.channels.focus).toBe(null);
        expect(s.channels.aperture).toBe(null);
        expect(s.hud.fStop).toBe(null);
      }
    }
  });

  it("tiles the body fade at DIVE_P0, exactly as hero-driver and fly.ts do", () => {
    for (const p of PS) {
      const s = storyStateAt(p);
      const below = p < DIVE_P0;
      expect(s.look.bodyFadeOwner, `owner ${p}`).toBe(below ? "driver" : "fly");
      expect(s.look.bodyFade, `bodyFade ${p}`).toBe(
        below ? 1 : flyBodyFadeAt(p),
      );
    }
    // the seam itself: the driver's half is a constant 1 and the fly opens on
    // 1, which is what makes the tile stepless as well as gapless
    expect(flyBodyFadeAt(DIVE_P0)).toBe(1);
  });

  it("reports a window as open exactly while p is inside it", () => {
    for (const p of PS) {
      const open = new Map(storyStateAt(p).windows.map((w) => [w.name, w]));
      for (const w of STORY_WINDOWS) {
        const inside = p >= w.p0 && p <= w.p1;
        expect(open.has(w.name), `${w.name} at ${p}`).toBe(inside);
        if (inside)
          expect(open.get(w.name)!.f).toBeCloseTo(
            (p - w.p0) / (w.p1 - w.p0),
            12,
          );
      }
    }
  });

  it("every window is a real, forward, in-track span", () => {
    for (const w of STORY_WINDOWS) {
      expect(w.p1, `${w.name}`).toBeGreaterThan(w.p0);
      expect(w.p0, `${w.name}`).toBeGreaterThanOrEqual(0);
      expect(w.p1, `${w.name}`).toBeLessThanOrEqual(1);
    }
    expect(new Set(STORY_WINDOWS.map((w) => w.name)).size).toBe(
      STORY_WINDOWS.length,
    );
  });

  it("is pure — same p, same state, and no hidden clock", () => {
    for (const p of [0, 0.3, DIVE_P0, atFrac(rwR, 0.2), 1])
      expect(storyStateAt(p)).toEqual(storyStateAt(p));
  });
});

describe("the chunk law, on the source", () => {
  // story/state.ts drags optics/ in. A single STATIC import of it from anything
  // the homepage reaches would put the whole dive in the first chunk — the same
  // law story/fly.ts states for itself. `import.meta.env.DEV` removes
  // hero-driver's `import("./state")` from a production build entirely, so
  // the built homepage chunk contains no trace of it (verified with a build);
  // this is the cheap tripwire that runs on every `npm test`.
  const root = new URL("../../", import.meta.url).pathname;
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (f.endsWith(".ts")) files.push(f);
    }
  })(root);

  /** every non-test source file with a STATIC import of `<name>.js` */
  const staticImportersOf = (name: string) =>
    files
      .filter(
        (f) =>
          !f.includes("__tests__") &&
          new RegExp(
            `(^|\\n)\\s*import[^;]*from\\s*["'][^"']*/${name}\\.js["']`,
          ).test(readFileSync(f, "utf8")),
      )
      .map((f) => f.slice(root.length));

  it("is imported statically by nothing but its two instrument siblings", () => {
    // story/cost.ts and story/flow.ts are state.ts's only static consumers, and
    // both live under this very law themselves (below) — the cost map is the
    // state map's arithmetic and the flow map is its geometry, so each must be
    // as unreachable from the hero's path as its input is.
    expect(
      staticImportersOf("state"),
      "story/state.ts must be reached by import() or by a test only",
    ).toEqual(["story/cost.ts", "story/flow.ts"]);
  });

  it("carries story/cost.ts under the same law", () => {
    // story/flow.ts takes the hero's pinned deform set and the sample grid off
    // cost.ts rather than rebuilding either, which is the only static reach
    // into it that exists.
    expect(
      staticImportersOf("cost"),
      "story/cost.ts must be reached by import() or by a test only",
    ).toEqual(["story/flow.ts"]);
  });

  it("carries story/flow.ts under the same law", () => {
    expect(
      staticImportersOf("flow"),
      "story/flow.ts must be reached by import() or by a test only",
    ).toEqual([]);
  });

  it("is not re-exported from the barrel", () => {
    const barrel = readFileSync(join(root, "index.ts"), "utf8");
    expect(barrel).not.toContain("state.js");
    expect(barrel).not.toContain("storyStateAt");
    expect(barrel).not.toContain("cost.js");
    expect(barrel).not.toContain("storyCostAt");
    expect(barrel).not.toContain("flow.js");
    expect(barrel).not.toContain("pieceStateAt");
  });

  it("is reached from hero-driver only behind a DEV gate", () => {
    const driver = readFileSync(join(root, "story/hero-driver.ts"), "utf8");
    const dev = driver.indexOf("import.meta.env.DEV");
    expect(dev, "hero-driver needs a DEV gate").toBeGreaterThan(-1);
    // all three lazy riders sit behind it — state.ts and its two siblings
    for (const mod of [
      'import("./state")',
      'import("./cost")',
      'import("./flow")',
    ]) {
      const use = driver.indexOf(mod);
      expect(use, `hero-driver must ${mod}`).toBeGreaterThan(-1);
      expect(dev, `${mod} behind import.meta.env.DEV`).toBeLessThan(use);
    }
  });
});
