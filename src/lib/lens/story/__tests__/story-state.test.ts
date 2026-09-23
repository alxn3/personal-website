import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as THREE from "three/webgpu";
import { DIVE_P0, RANGES, atFrac, rangeOf } from "../story";
import { sampleStory } from "../camera";
import {
  assembleAt,
  bgAt,
  chromeAt,
  driverOwnsIris,
  dustAt,
  explodeAt,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  peelRollAt,
  peelTurnAt,
  preShutAt,
  rockYAt,
  sceneIndexAt,
  scrollCueAt,
  shellFadeAt,
  zoomAt,
} from "../envelopes";
import { revealRollAt, turnAt } from "../reveal";
import { internalsEnvAt } from "../internals";
import {
  EXIT_END,
  flyBodyFadeAt,
  flyCentreAt,
  flyDarkAt,
  flyDollyAt,
  flyFovMixAt,
  flyFovOf,
  flyInkAt,
  flyPoseAt,
  flyRevealAt,
  flySkyMixAt,
  flySpanApertureAt,
  flySpanFocusAt,
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
//
// The other half is the CHUNK LAW: story/state.ts drags optics/ in through
// fly.ts / trails.ts / constellations.ts, so a single static import of it from
// anything on the hero's path would put the whole dive in the homepage's first
// chunk. Asserted on the SOURCE below.
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
      expect(s.look.dust, `dust ${p}`).toBe(dustAt(p));
      expect(s.look.reveal, `reveal ${p}`).toBe(flyRevealAt(p));
      // the fly's span uniforms, read from their owner at EVERY p — the report
      // does not zero them outside the span, because the ramps already are
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
    // hero-driver writes these three axes in one setModelOrientation call; the
    // report keeps them separate so the map can show which is live.
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
    // three writers, separated by RANGE rather than by rAF order; the fly wins
    // inside its own span because its writes land last in frame().
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
        // both of the fly's iris laws in story p — the ramps plus the hand-back
        expect(s.channels.aperture).toBe(flySpanApertureAt(p));
        expect(s.channels.focus).toBe(flySpanFocusAt(p));
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
    // the seam: the driver's half is a constant 1 and the fly opens on 1, so
    // the tile is stepless as well as gapless
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
  // Seven story modules drag optics/ (three/tsl node graphs) in: the four
  // riders fly / trails / petals / constellations and the three instruments
  // state / cost / flow. A single STATIC import of any from something the
  // homepage reaches would put the whole dive in the first chunk, so each may
  // be reached only by import(), by a test, or by another module on this
  // list. hero-driver's `import("./state")` sits behind
  // `import.meta.env.DEV`, so a production build drops it entirely.
  const root = new URL("../../../../", import.meta.url).pathname; // src/
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (e === "node_modules") continue;
      if (statSync(f).isDirectory()) walk(f);
      else if (f.endsWith(".ts") || f.endsWith(".astro")) files.push(f);
    }
  })(root);

  /** every non-test source file under src/ with a STATIC, non-type import of
   *  `<name>.js` — `import … from`, `export … from` and the bare `import "…"` */
  const staticImportersOf = (name: string) =>
    files
      .filter(
        (f) =>
          !f.includes("__tests__") &&
          new RegExp(
            `(^|\\n)\\s*(import|export)(?!\\s+type\\b)(\\s*[^;]*?\\s+from)?\\s*["'][^"']*/${name}\\.js["']`,
          ).test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(root, f))
      .sort();

  const LAW: Record<string, string[]> = {
    // the instruments: state.ts's only static consumers are its two siblings,
    // flow.ts takes the deform set and sample grid off cost.ts
    state: ["lib/lens/story/cost.ts", "lib/lens/story/flow.ts"],
    cost: ["lib/lens/story/flow.ts"],
    flow: [],
    // the riders: read statically by the instruments alone
    fly: ["lib/lens/story/cost.ts", "lib/lens/story/state.ts"],
    trails: ["lib/lens/story/cost.ts", "lib/lens/story/state.ts"],
    petals: ["lib/lens/story/cost.ts"],
    constellations: ["lib/lens/story/cost.ts", "lib/lens/story/state.ts"],
  };

  for (const [name, allowed] of Object.entries(LAW))
    it(`story/${name}.ts is reached statically only from the lazy set`, () => {
      expect(staticImportersOf(name)).toEqual(allowed);
    });

  it("sees the import forms a static reach can take", () => {
    // the checker's own regex, against the forms a mutant could use
    const re = (name: string) =>
      new RegExp(
        `(^|\\n)\\s*(import|export)(?!\\s+type\\b)(\\s*[^;]*?\\s+from)?\\s*["'][^"']*/${name}\\.js["']`,
      );
    for (const src of [
      'import { flyPoseAt } from "./fly";',
      'import * as fly from "../story/fly";',
      'export { flyPoseAt } from "./fly";',
      'export * from "./fly";',
      'import "./fly";',
      '\nimport {\n  a,\n  b,\n} from "./fly";',
    ])
      expect(re("fly").test(src), src).toBe(true);
    for (const src of [
      'import type { StoryFly } from "./fly";',
      'const m = await import("./fly");',
      'import { x } from "./flyer";',
    ])
      expect(re("fly").test(src), src).toBe(false);
  });

  it("is not re-exported from the barrel", () => {
    const barrel = readFileSync(join(root, "lib/lens/index.ts"), "utf8");
    for (const name of Object.keys(LAW))
      expect(barrel, name).not.toContain(`${name}.js`);
    expect(barrel).not.toContain("storyStateAt");
    expect(barrel).not.toContain("storyCostAt");
    expect(barrel).not.toContain("pieceStateAt");
  });

  it("is reached from hero-driver only behind a DEV gate", () => {
    const driver = readFileSync(
      join(root, "lib/lens/story/hero-driver.ts"),
      "utf8",
    );
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
