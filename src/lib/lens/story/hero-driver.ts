// Scroll driver for the homepage lens hero. Two media, two clocks: the 3D frame
// is evaluated at the EASED story p (scene.onEvaluate — channels, orientation,
// fades, ink, the fly) and the DOM chrome (per-block --beat-* vars, HUD /
// scene-rail / scroll-cue, background tint) is written at the raw scroll p in
// frame(). The element ids and data-* attributes queried below are the
// contract with LensStory.astro's hero markup.
//
// HOMEPAGE-CHUNK LAW: this file is in the initial chunk, so it may NEVER
// statically import optics/ or a lazy story module (fly, trails,
// constellations, state, cost, flow) — those are dynamic-import only.
//
// CAPTIONS ARE NOT HERE: their visibility is layout (story.ts CAPTION_BANDS +
// position: sticky), so they survive a driver that never starts.
//
// LensStory.astro keeps everything that must run WITHOUT a driver: initScene +
// fallback, the theme watcher (forwarded here via onThemeChange), the pause
// observer and the reduced-motion parked pose.

import type { SceneHandle } from "../core/scene";
import { uInkFill } from "../materials/unified";
import { recipeKnob } from "../ops/host";
import {
  STORY,
  RANGES,
  rangeOf,
  bandOf,
  holdCentreOf,
  DIVE_P0,
} from "./story";
import { band, BAND_FEATHER, clamp01, smoothstep } from "../core/math";
import { isLightTheme } from "../core/theme";
import { createInternalsAmbient } from "./internals";
import { createPeelCards } from "./peelcards";
import type { Rgb } from "./envelopes";
// type-only: these are dynamic-import-only per the chunk law, and an erased
// import cannot pull them into the homepage's
import type { StoryConstellations } from "./constellations";
import type { StoryTrails } from "./trails";
import type { StoryPetals } from "./petals";
import {
  ASSEMBLE_KEEP_SCOPE,
  ENDING_BLOOM,
  ENDING_CURL,
  ENDING_RING_PHASE,
  ENDING_REBEND,
  assembleAt,
  bgStopsFor,
  bgTintAt,
  chromeAt,
  driverOwnsIris,
  dustAt,
  explodeAt,
  fStopOf,
  focalMmAt,
  huddleAt,
  inkFillAt,
  interiorFadeAt,
  orientationAt,
  preShutAt,
  roseAt,
  sceneIndexAt,
  scrollCueAt,
  shellFadeAt,
  zoomAt,
} from "./envelopes";

export interface HeroDriver {
  /** Theme flip: swap the bg stop table and re-tint at the current scroll. */
  onThemeChange: (light: boolean) => void;
}

/** the five knobs the story writes, taken once — guarded uniform boxes */
const keepScope = recipeKnob("assemble", "keepScope");
const bloom = recipeKnob("explode", "bloom");
const curl = recipeKnob("explode", "curl");
const ringPhase = recipeKnob("explode", "ringPhase");
const rebend = recipeKnob("explode", "rebend");

// per-frame scratch: the orientation handed to the scene, so a frame allocates
// nothing
const ORIENT = { x: 0, y: 0, z: 0 };

export function startHeroStory(scene: SceneHandle): HeroDriver {
  const track = document.getElementById("lens-track")!;
  const stage = document.getElementById("lens-stage")!;
  const hud = document.getElementById("hud")!;
  const sceneRail = document.getElementById("scene-rail")!;
  const scrollCue = document.getElementById("scroll-cue")!;
  // Per-block progress: any element with data-beat gets its scene's progress
  // written as custom properties each frame. A typo'd id warns and is skipped.
  const beats = [...track.querySelectorAll<HTMLElement>("[data-beat]")].flatMap(
    (el) => {
      const id = el.dataset.beat!;
      let r, bnd;
      try {
        r = rangeOf(id);
        bnd = bandOf(id);
      } catch {
        console.warn(`lens hero: no story scene named "${id}"`, el);
        return [];
      }
      return [
        {
          el,
          p0: r.p0,
          p1: r.p1,
          // the block's band, off the story table. The FINAL band's far edge is
          // pushed one feather past the track end, where CSS holds the caption
          // lit, so --beat-visibility does not dim under it.
          a: bnd.a,
          b: bnd.final ? bnd.b + BAND_FEATHER : bnd.b,
          // --beat-progress window in scene-local 0..1, authored via
          // LensSceneContent's progressFrom/progressTo, parsed once
          f0: Number(el.dataset.progressFrom ?? 0),
          f1: Number(el.dataset.progressTo ?? 1),
          // last values written, so a block resting at its floor writes nothing
          wLocal: NaN,
          wProgress: NaN,
          wVisibility: NaN,
        },
      ];
    },
  );

  // Tracked-part pins: every [data-track] element follows its model node's
  // projected screen position each frame (LensPin.astro).
  const pins = [...stage.querySelectorAll<HTMLElement>("[data-track]")].map(
    (el) => ({ el, node: el.dataset.track!, wx: NaN, wy: NaN, wVis: "" }),
  );
  if (pins.length) {
    // the projected point, reused across pins and frames
    const at = { x: 0, y: 0 };
    scene.onFrame((project) => {
      for (const pin of pins) {
        // hidden: unknown node or behind the camera
        const vis = project(pin.node, at) ? "" : "hidden";
        if (vis === "") {
          // rounded to the tenth the transform is written at, so a pin that
          // lands on the same tenth writes no string
          const x = Math.round(at.x * 10) / 10;
          const y = Math.round(at.y * 10) / 10;
          if (x !== pin.wx || y !== pin.wy) {
            pin.wx = x;
            pin.wy = y;
            pin.el.style.transform = `translate(${x}px, ${y}px)`;
          }
        }
        if (vis !== pin.wVis) {
          pin.wVis = vis;
          pin.el.style.visibility = vis;
        }
      }
    });
  }
  // scene-rail dots: one per rail-flagged scene, matched to the markup by scene
  // id; `i` is the scene's index in RANGES
  const rails = RANGES.flatMap((r, i) =>
    r.scene.rail
      ? [
          {
            i,
            el: stage.querySelector<HTMLElement>(`[data-rail="${r.scene.id}"]`),
          },
        ]
      : [],
  );

  // the peel's range — the only one still read here, for the fly prefetch below
  const peR = rangeOf("peel");

  // last HUD readings and lit rail, so an unchanged frame writes no DOM. The
  // scene, focal length and explode read the raw scroll p in frame(); the
  // f-stop reads the DRAWN iris after each render, since inside the internals
  // it is a phase clock and inside the dive the eased channel.
  let hudScn = -1;
  let hudFstop = "";
  let hudMm = -1;
  let hudExpl = -1;
  let railScn = -1;
  let hudText = "";
  function spellHud() {
    const text = `SCN ${String(hudScn).padStart(2, "0")} / ${STORY[hudScn].title} · ${hudMm}MM · f/${hudFstop} · EXPL ${hudExpl}%`;
    if (text === hudText) return;
    hudText = text;
    hud.textContent = text;
  }
  scene.onFrame(() => {
    hudFstop = fStopOf(scene.state.aperture);
    spellHud();
  });

  // background tint: the stop table is per THEME, held across frames and
  // rebuilt on a flip, so the per-frame path only interpolates
  let BG_STOPS = bgStopsFor(isLightTheme());
  let lastBgP = 0;
  const bgRgb: Rgb = [0, 0, 0];
  let lastBgCss = "";
  function bgTint(p: number) {
    lastBgP = p;
    const c = bgTintAt(BG_STOPS, p, bgRgb);
    const css = `rgb(${c[0]},${c[1]},${c[2]})`;
    if (css === lastBgCss) return; // the tint holds for runs of frames
    lastBgCss = css;
    stage.style.background = css;
  }

  let lastP = 0; // last p handed to frame() — read by the dev scrub panel
  /** the eased p the 3D frame was last evaluated at */
  let lastPE = NaN;
  /** the dust flag last written, so a parked story writes nothing */
  let lastDust: boolean | undefined;
  /** when the story position last moved — the prewarm waits on it */
  let lastMoveAt = 0;

  // The fly-through span's driver (story/fly.ts): dynamic-import only, per the
  // chunk law. Prefetch starts at the PEEL, several scenes before the dive.
  let fly: { evaluate(pE: number): void; warm(): Promise<void> } | undefined;
  let flyLoad: Promise<unknown> | undefined;
  const flyPrefetchP = peR.p0;
  /** Import + warm the dive. Fired at BOOT idle so the import, the pass compile
   *  and the glass clone build land while the reader is still on the hero; the
   *  scroll trigger in frame() is the fallback for a deep link. */
  function loadFly() {
    if (flyLoad) return flyLoad;
    flyLoad = import("./fly")
      .then((m) => {
        fly = m.createStoryFly(scene);
        // a deep link parked inside the span never moves again: re-evaluate
        lastPE = NaN;
        scene.invalidate();
      })
      .catch((err) => console.warn("lens fly: driver failed to load", err));
    return flyLoad;
  }
  setTimeout(() => void prewarm(), 2500);
  /** Run `cb` when the page has a moment, and no later than the timeout. */
  const atIdle = (cb: () => void) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(cb, { timeout: 2000 });
    else setTimeout(cb, 500);
  };
  /** …the same window, awaited. */
  const idle = () => new Promise<void>((resolve) => atIdle(resolve));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** Stillness a warm waits for: a warm frame landing mid-gesture just moves
   *  the stutter it spares. */
  const WARM_QUIET_MS = 350;
  /** Set once the reader crosses into the peel, after which the warms stop
   *  waiting for a still moment that may never come. */
  let warmNow = false;
  /** An idle window with the story standing still — or none at all, once the
   *  approach has escalated. */
  async function whenStill() {
    for (;;) {
      if (warmNow) return;
      await idle();
      const since = performance.now() - lastMoveAt;
      if (since >= WARM_QUIET_MS || warmNow) return;
      await wait(WARM_QUIET_MS - since);
    }
  }

  // the sky chapter's ink (story/constellations.ts), lazy for the same chunk
  // reason and self-driving once created, so there is only the load here
  let constellations: StoryConstellations | undefined;
  let constLoad: Promise<unknown> | undefined;
  const constPrefetchP = rangeOf("flythrough").p0;
  function loadConstellations() {
    if (constLoad) return constLoad;
    constLoad = import("./constellations")
      .then((m) => {
        constellations = m.createStoryConstellations(scene);
      })
      .catch((err) =>
        console.warn("lens constellations: driver failed to load", err),
      );
    return constLoad;
  }

  // the turning sky (story/trails.ts), lazy and self-driving on the same terms;
  // it needs no re-drive after the import, unlike the fly hook
  let trails: StoryTrails | undefined;
  let trailsLoad: Promise<unknown> | undefined;
  const trailsPrefetchP = rangeOf("constellations").p0;
  function loadTrails() {
    if (trailsLoad) return trailsLoad;
    trailsLoad = import("./trails")
      .then((m) => {
        trails = m.createStoryTrails(scene);
      })
      .catch((err) => console.warn("lens trails: driver failed to load", err));
    return trailsLoad;
  }

  // the bloom's petals (story/petals.ts), lazy and self-driving like the
  // trails; prefetched a scene early, at the rewrap
  let petals: StoryPetals | undefined;
  let petalsLoad: Promise<unknown> | undefined;
  const petalsPrefetchP = rangeOf("rewrap").p0;
  function loadPetals() {
    if (petalsLoad) return petalsLoad;
    petalsLoad = import("./petals")
      .then((m) => {
        petals = m.createStoryPetals(scene);
      })
      .catch((err) => console.warn("lens petals: driver failed to load", err));
    return petalsLoad;
  }

  /** THE BOOT PREWARM, in the order the reader reaches them and one idle window
   *  each. Importing is only half of it: each module's first DRAW uploads its
   *  textures and buffers, which is the boundary's stall. Every step waits for
   *  the story to stand still, and every step is idempotent against the scroll
   *  triggers in frame(). */
  async function prewarm() {
    await whenStill();
    peelCards.warm();
    await whenStill();
    await loadFly();
    await whenStill();
    // the pass's own frame, ahead of the dive's: its render targets are the
    // dive's biggest allocation
    await scene.buildWormholePost();
    await whenStill();
    await fly?.warm();
    await whenStill();
    await loadConstellations();
    constellations?.warm();
    await whenStill();
    await loadTrails();
    trails?.warm();
    await whenStill();
    await loadPetals();
    petals?.warm();
  }

  // The two statically imported story modules (neither pulls in optics/).
  // internals.ts gates itself to the internals span, where it — not the
  // evaluate step below — owns focus and aperture.
  createInternalsAmbient(scene);
  const peelCards = createPeelCards(scene);

  // THE 3D EVALUATE STEP, at the eased story p: every value the frame draws is
  // a pure function of pE, written value-and-target so nothing lags it. Skipped
  // while pE stands still, so a parked story costs nothing.
  scene.onEvaluate((pE) => {
    if (pE === lastPE) return false;
    lastPE = pE;
    const s = scene.state;
    s.zoom = s.zoomTarget = zoomAt(pE);
    // outside the cards+internals span the driver owns focus and the aperture's
    // pre-shut ramp; inside it story/internals.ts does — separated by RANGE
    if (driverOwnsIris(pE)) {
      s.focus = s.focusTarget = 0;
      s.aperture = s.apertureTarget = preShutAt(pE);
    }
    s.explode = s.explodeTarget = explodeAt(pE);
    s.assemble = s.assembleTarget = assembleAt(pE);
    s.rose = s.roseTarget = roseAt(pE);
    // the cards chapter's compact core (ops/mechanism.ts huddleMm)
    s.huddle = s.huddleTarget = huddleAt(pE);
    scene.setModelOrientation(orientationAt(pE, ORIENT));
    // the ink ramps; the uniform box is materials/unified.ts's, so this line is
    // the only coupling
    uInkFill.value = inkFillAt(pE);
    // the body fade is the dive's alone; this half of the tile is a constant 1,
    // written to keep the range-tiled writer map GAPLESS
    if (pE < DIVE_P0) scene.setBodyFade(1);
    // the shell's and the interior's winks and returns — one law each in
    // story/envelopes.ts, both riding story/peelcards.ts's WINK_SPAN
    scene.setShellFade(shellFadeAt(pE));
    scene.setInteriorFade(interiorFadeAt(pE));
    // the dust's one writer (story/envelopes.ts dustAt): the dive and the
    // petals both want it off, and neither may own the flag
    const dust = dustAt(pE);
    if (dust !== lastDust) {
      lastDust = dust;
      scene.setDust(dust);
    }
    // last: the fly owns the iris inside its span, so its writes land after
    // the resets above
    fly?.evaluate(pE);
    return false;
  });

  let wCue = NaN;
  let wChrome = NaN;
  /** The DOM chrome at the raw scroll p, and the story target the 3D eases to. */
  function frame(p: number) {
    if (p !== lastP) lastMoveAt = performance.now();
    lastP = p;
    scene.state.storyTarget = p;

    // per-block progress custom properties, so content-specific effects live in
    // CSS with the content —
    //   --beat-local      raw scene-local progress, 0..1
    //   --beat-progress   local eased over the block's authored window
    //   --beat-visibility the story table's fade band (the pins ride it)
    for (const c of beats) {
      const local = clamp01((p - c.p0) / (c.p1 - c.p0));
      const progress = smoothstep(c.f0, c.f1, local);
      const visibility = band(p, c.a, c.b);
      if (local !== c.wLocal) {
        c.wLocal = local;
        c.el.style.setProperty("--beat-local", String(local));
      }
      if (progress !== c.wProgress) {
        c.wProgress = progress;
        c.el.style.setProperty("--beat-progress", String(progress));
      }
      if (visibility !== c.wVisibility) {
        c.wVisibility = visibility;
        c.el.style.setProperty("--beat-visibility", String(visibility));
      }
    }

    bgTint(p);

    // the lazy scenes' prefetch ladder, off the reader's real position
    if (p > flyPrefetchP) warmNow = true; // the approach escalation
    if (!flyLoad && p > flyPrefetchP) loadFly();
    if (!constLoad && p > constPrefetchP) loadConstellations();
    if (!trailsLoad && p > trailsPrefetchP) loadTrails();
    if (!petalsLoad && p > petalsPrefetchP) loadPetals();

    // HUD + scene rail: the readout reports the story at the reader's p; the
    // f-stop is filled in after the render (see spellHud)
    const scn = sceneIndexAt(p);
    hudScn = scn;
    hudMm = focalMmAt(zoomAt(p));
    hudExpl = Math.round(explodeAt(p) * 100);
    spellHud();
    if (scn !== railScn) {
      railScn = scn;
      for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);
    }

    // scroll cue lives only in the hero; the chrome fades at the very end —
    // both flat for most of the track, so each is written only when it moves
    const cue = scrollCueAt(p);
    if (cue !== wCue) {
      wCue = cue;
      scrollCue.style.opacity = String(cue);
    }
    const chrome = chromeAt(p);
    if (chrome !== wChrome) {
      wChrome = chrome;
      hud.style.opacity = String(chrome);
      sceneRail.style.opacity = String(chrome);
    }
  }

  // The track's document geometry, re-read only when the layout moves: the
  // track's own size, the body's (content above it), the viewport's. A scroll
  // frame then reads scrollY alone, which forces no layout.
  let trackTop = 0;
  let trackTotal = 0;
  const measureTrack = () => {
    trackTop = track.getBoundingClientRect().top + window.scrollY;
    trackTotal = track.offsetHeight - window.innerHeight;
  };
  const scrollP = () =>
    trackTotal > 0 ? clamp01((window.scrollY - trackTop) / trackTotal) : 0;
  // Dev scrub override (?story panel): while set, scrolling stops driving
  // frame() — the panel's scrub owns the story position instead.
  let override = false;
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      if (!override) frame(scrollP());
      ticking = false;
    });
  }
  const onLayout = () => {
    measureTrack();
    onScroll();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onLayout, { passive: true });
  const ro = new ResizeObserver(onLayout);
  ro.observe(track);
  ro.observe(document.body);
  // the story's recipe knobs: constants a scroll never moves, written once
  keepScope.value = ASSEMBLE_KEEP_SCOPE;
  bloom.value = ENDING_BLOOM;
  curl.value = ENDING_CURL;
  ringPhase.value = ENDING_RING_PHASE;
  rebend.value = ENDING_REBEND;
  // the first write is SYNCHRONOUS, before the first rendered frame, so nothing
  // draws a frame the story did not ask for; the boot SNAPS the eased p onto
  // the scroll, so a deep link opens on its pose rather than the path to it
  measureTrack();
  const p0 = scrollP();
  scene.state.story = p0;
  frame(p0);

  // DEV: the story as JSON on `window.__lensStory`. Read-only, and lazy by
  // necessity — story/state.ts drags optics/ in, so it may only be reached
  // through the dynamic import inside this DEV-gated block.
  if (import.meta.env.DEV) {
    const load = () => import("./state");
    /** The live model root, off core/scene.ts's own DEV probe, so no reader
     *  here has to widen the public SceneHandle. */
    const modelRoot = (who: string): never => {
      const perf = (window as unknown as Record<string, { model?: unknown }>)
        .__lensPerf;
      if (!perf?.model)
        throw new Error(`__lensStory.${who}: the scene has not booted yet`);
      return perf.model as never;
    };
    (window as unknown as Record<string, unknown>).__lensStory = {
      /** the full declarative state at ANY p — no scrolling required */
      async stateAt(p: number, opts?: { light?: boolean }) {
        const { storyStateAt } = await load();
        return storyStateAt(p, { light: isLightTheme(), ...opts });
      },
      /** …and at the p the driver last ran: the scroll position (or the ?story
       *  panel's parked override), not the eased channel */
      async dump() {
        const { storyStateAt } = await load();
        return storyStateAt(lastP, { light: isLightTheme() });
      },
      /** The renderer's workload at p — story/cost.ts's law over a census of
       *  the LIVE scene. Lazily imported for story/state.ts's reason. */
      async costAt(p: number = lastP) {
        const { buildPartTableFromScene, storyCostAt } =
          await import("./cost");
        return storyCostAt(p, buildPartTableFromScene(modelRoot("costAt")));
      },
      /** Where one piece is at p, in the bore's cylindrical coordinates —
       *  story/flow.ts's law over the LIVE model's derived frames. */
      async pieceAt(p: number = lastP, key?: string) {
        const { buildPieceTable, pieceStateAt } = await import("./flow");
        const table = buildPieceTable(modelRoot("pieceAt"));
        return key
          ? pieceStateAt(p, key, table)
          : table.pieces.map((r) => pieceStateAt(p, r.key, table));
      },
      /** …and the whole per-scene × per-cast rollup. Slow: every piece through
       *  the real pipeline at every edge of the story. */
      async flowTable() {
        const { buildPieceTable, flowRollups } = await import("./flow");
        return flowRollups(buildPieceTable(modelRoot("flowTable")));
      },
    };
  }

  // Dev-only story scrubber, stripped from production with the block above and
  // built only for `/?story`.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("story")
  ) {
    // every channel the story drives, read back LIVE (post-ease) each frame
    const CH = [
      ["zoom", "zoom"],
      ["focus", "focus"],
      ["aperture", "aper"],
      ["explode", "expl"],
      ["assemble", "asm"],
      ["peel", "peel"],
      ["rose", "rose"],
    ] as const;

    const style = document.createElement("style");
    style.textContent = `
      .lens-scrub{position:fixed;top:4.5rem;left:.75rem;z-index:2147483000;
        width:19rem;padding:.6rem .7rem;background:rgba(12,11,8,.82);color:#e8e4da;
        font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;border-radius:6px;
        pointer-events:auto;user-select:none}
      .lens-scrub-head{display:flex;justify-content:space-between;gap:.5rem}
      .lens-scrub-mode{color:#c9a227}
      .lens-scrub-grid{display:grid;grid-template-columns:repeat(5,1fr);
        gap:0 .5rem;margin:.3rem 0}
      .lens-scrub-grid span{white-space:nowrap}
      .lens-scrub input[type=range]{width:100%;margin:.2rem 0;display:block}
      .lens-scrub button{font:inherit;color:inherit;background:rgba(255,255,255,.12);
        border:1px solid rgba(255,255,255,.25);border-radius:3px;padding:0 .35rem;
        margin:.1rem .15rem .1rem 0;cursor:pointer}
      .lens-scrub button:hover{background:rgba(255,255,255,.25)}`;
    document.head.append(style);

    const panel = document.createElement("div");
    panel.className = "lens-scrub";
    const head = document.createElement("div");
    head.className = "lens-scrub-head";
    const pLine = document.createElement("span");
    const mode = document.createElement("span");
    mode.className = "lens-scrub-mode";
    head.append(pLine, mode);
    const grid = document.createElement("div");
    grid.className = "lens-scrub-grid";
    const cells = CH.map(([id, label]) => {
      const cell = document.createElement("span");
      grid.append(cell);
      return { id, label, cell };
    });
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.0005";
    const follow = document.createElement("button");
    follow.textContent = "follow scroll";
    const jumps = document.createElement("div");
    panel.append(head, grid, slider, follow, jumps);
    document.body.append(panel);

    const park = (p: number) => {
      override = true;
      slider.value = String(p);
      frame(p);
    };
    slider.addEventListener("input", () => park(Number(slider.value)));
    follow.addEventListener("click", () => {
      override = false;
      frame(scrollP()); // re-sync to the real scroll position immediately
    });
    // one jump per scene, parked at the settle region's midpoint
    for (const r of RANGES) {
      const b = document.createElement("button");
      b.textContent = r.scene.title;
      b.addEventListener("click", () => park(holdCentreOf(r)));
      jumps.append(b);
    }

    // cheap per-frame readout: p, scene + local fraction, live EASED channels
    scene.onFrame(() => {
      const r = RANGES[sceneIndexAt(lastP)];
      const local = (lastP - r.p0) / Math.max(1e-9, r.p1 - r.p0);
      pLine.textContent = `p ${lastP.toFixed(4)} · ${r.scene.id} ${local.toFixed(2)}`;
      mode.textContent = override ? "OVERRIDE" : "SCROLL";
      for (const { id, label, cell } of cells)
        cell.textContent = `${label} ${scene.state[id].toFixed(2)}`;
      if (!override) slider.value = String(lastP);
    });
  }

  return {
    // theme flip: swap the stop table and re-tint at the current scroll
    onThemeChange(light) {
      BG_STOPS = bgStopsFor(light);
      bgTint(lastBgP);
    },
  };
}
