import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as THREE from "three/webgpu";
import { DIVE_P0, RANGES, sceneIndexAt } from "../story";
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

// storyStateAt must report exactly what each owning module's function says,
// and the lazy story modules must stay out of the homepage's first chunk.

/** every edge plus a fine grid, so a field wrong only mid-ramp still shows */
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
      // the sticker peel is only used on /lens
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
      // the dive's uniforms, at every p (each is 0 outside the dive)
      expect(s.look.skyMix, `skyMix ${p}`).toBe(flySkyMixAt(p));
      expect(s.look.warp, `warp ${p}`).toBe(flyWarpAt(p));
      expect(s.look.streak, `streak ${p}`).toBe(flyStreakAt(p));
      expect(s.look.dark, `dark ${p}`).toBe(flyDarkAt(p));
      // the fov override is null outside the dive
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
    for (const p of PS) {
      const s = storyStateAt(p);
      // the reveal roll scales with the explode channel
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
    // three writers split by range; the dive wins inside its span
    for (const p of PS) {
      const s = storyStateAt(p);
      const inFly = p >= DIVE_P0 && p <= EXIT_END;
      expect(s.irisOwner, `owner ${p}`).toBe(
        inFly ? "fly" : driverOwnsIris(p) ? "driver" : "internals",
      );
      if (s.irisOwner === "driver") {
        expect(s.channels.focus).toBe(0);
        expect(s.channels.aperture).toBe(preShutAt(p));
        expect(s.hud.fStop).not.toBe(null);
      } else if (s.irisOwner === "fly") {
        expect(s.channels.aperture).toBe(flySpanApertureAt(p));
        expect(s.channels.focus).toBe(flySpanFocusAt(p));
        expect(s.hud.fStop).not.toBe(null);
      } else {
        // the internals ambient runs on a clock, so there is no value at p
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
    // no step at the hand-over
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
});

describe("the chunk law, on the source", () => {
  // These story modules pull in optics/, so the homepage may only reach them
  // by dynamic import (hero-driver's instrument imports are DEV-only).
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
