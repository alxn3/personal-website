// Scroll driver for the homepage lens hero. The 3D frame is evaluated at the
// eased story p (scene.onEvaluate); the DOM chrome (--beat-* vars, HUD, scene
// rail, scroll cue, stage tint) is written at the raw scroll p in frame().
// Element ids and data-* attributes below must match LensStory.astro.
// This file is in the homepage's first chunk: optics/ and the lazy story
// modules (fly, trails, constellations, petals, state, cost, flow) may only be
// reached by dynamic import.
// Captions are not driven here: their visibility is CSS layout.

import type { SceneHandle } from "../core/scene";
import { uInkFill } from "../materials/unified";
import { recipeKnob } from "../ops/host";
import type { RecipeName } from "../ops/recipes";
import {
  STORY,
  RANGES,
  rangeOf,
  bandOf,
  holdCentreOf,
  DIVE_P0,
  sceneIndexAt,
} from "./story";
import { band, BAND_FEATHER, clamp01 } from "../core/math";
import { isLightTheme } from "../core/theme";
import { createInternalsAmbient } from "./internals";
import { createPeelCards } from "./peelcards";
import type { Rgb } from "./envelopes";
import {
  STORY_KNOBS,
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
  scrollCueAt,
  shellFadeAt,
  zoomAt,
} from "./envelopes";

export interface HeroDriver {
  /** Theme change: swap the tint table and re-tint at the current scroll. */
  onThemeChange: (light: boolean) => void;
}

// reused every frame for the model orientation
const ORIENT = { x: 0, y: 0, z: 0 };

export function startHeroStory(scene: SceneHandle): HeroDriver {
  const track = document.getElementById("lens-track")!;
  const stage = document.getElementById("lens-stage")!;
  const hud = document.getElementById("hud")!;
  const sceneRail = document.getElementById("scene-rail")!;
  const scrollCue = document.getElementById("scroll-cue")!;
  // Every [data-beat] element gets its scene's progress as CSS custom
  // properties. An unknown scene id warns and is skipped.
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
          // the caption band; the final band runs one feather past the track
          // end so --beat-visibility stays at 1 there
          a: bnd.a,
          b: bnd.final ? bnd.b + BAND_FEATHER : bnd.b,
          // last values written, to skip unchanged writes
          wLocal: NaN,
          wVisibility: NaN,
        },
      ];
    },
  );

  // Pins: every [data-track] element follows its model node on screen
  // (LensPin.astro).
  const pins = [...stage.querySelectorAll<HTMLElement>("[data-track]")].map(
    (el) => ({ el, node: el.dataset.track!, wx: NaN, wy: NaN, wVis: "" }),
  );
  if (pins.length) {
    const at = { x: 0, y: 0 };
    scene.onFrame((project) => {
      for (const pin of pins) {
        // hidden when the node is unknown or behind the camera
        const vis = project(pin.node, at) ? "" : "hidden";
        if (vis === "") {
          // rounded to 0.1px; unchanged positions write nothing
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
  // scene-rail dots, one per rail scene; `i` is the scene's index in RANGES
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

  // Last HUD readings and lit rail dot, so an unchanged frame writes no DOM.
  // Scene, focal length and explode come from the scroll p in frame(); the
  // f-stop reads the drawn aperture after each render.
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

  // stage tint: the stop table is rebuilt only on a theme change
  let BG_STOPS = bgStopsFor(isLightTheme());
  let lastBgP = 0;
  const bgRgb: Rgb = [0, 0, 0];
  let lastBgCss = "";
  function bgTint(p: number) {
    lastBgP = p;
    const c = bgTintAt(BG_STOPS, p, bgRgb);
    const css = `rgb(${c[0]},${c[1]},${c[2]})`;
    if (css === lastBgCss) return;
    lastBgCss = css;
    stage.style.background = css;
  }

  let lastP = 0; // last p handed to frame(); read by the dev panel
  let lastPE = NaN; // eased p of the last 3D evaluation
  let lastDust: boolean | undefined;
  let lastMoveAt = 0; // when the scroll position last changed

  // The dive (fly.ts), loaded lazily; the scroll prefetch starts at the peel.
  let fly: { evaluate(pE: number): void; warm(): Promise<void> } | undefined;
  let flyLoad: Promise<unknown> | undefined;
  const flyPrefetchP = rangeOf("peel").p0;
  /** Import the dive. Normally reached by the boot prewarm; frame() triggers it
   *  on scroll as a fallback. */
  function loadFly() {
    return (flyLoad ??= import("./fly")
      .then((m) => {
        fly = m.createStoryFly(scene);
        // re-evaluate, in case the page is parked inside the dive
        lastPE = NaN;
        scene.invalidate();
      })
      .catch((err) => console.warn("lens fly: driver failed to load", err)));
  }
  setTimeout(() => void prewarm(), 2500);
  /** Resolves when the page is idle, or after a timeout. */
  const idle = () =>
    new Promise<void>((resolve) => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(() => resolve(), { timeout: 2000 });
      else setTimeout(resolve, 500);
    });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** How long the scroll must be still before a warm-up step runs, ms. */
  const WARM_QUIET_MS = 350;
  /** Set once the reader reaches the peel: warm-ups stop waiting for stillness. */
  let warmNow = false;
  /** Resolves at an idle moment with the scroll still (at once after warmNow). */
  async function whenStill() {
    for (;;) {
      if (warmNow) return;
      await idle();
      const since = performance.now() - lastMoveAt;
      if (since >= WARM_QUIET_MS || warmNow) return;
      await wait(WARM_QUIET_MS - since);
    }
  }

  // The later riders (the sky's star names, the turning sky, the bloom's
  // petals): lazy, self-driving once created, prefetched once p passes `at`.
  const riders: {
    name: string;
    at: number;
    open: () => Promise<{ warm(): void }>;
    load?: Promise<{ warm(): void } | undefined>;
  }[] = [
    {
      name: "constellations",
      at: rangeOf("flythrough").p0,
      open: async () =>
        (await import("./constellations")).createStoryConstellations(scene),
    },
    {
      name: "trails",
      at: rangeOf("constellations").p0,
      open: async () => (await import("./trails")).createStoryTrails(scene),
    },
    {
      name: "petals",
      at: rangeOf("rewrap").p0,
      open: async () => (await import("./petals")).createStoryPetals(scene),
    },
  ];
  const loadRider = (r: (typeof riders)[number]) =>
    (r.load ??= r.open().catch((err) => {
      console.warn(`lens ${r.name}: driver failed to load`, err);
      return undefined;
    }));

  /** Load and warm each later scene in story order, one still idle moment
   *  each, so its first draw doesn't stall the scroll. Safe to race frame(). */
  async function prewarm() {
    await whenStill();
    peelCards.warm();
    await whenStill();
    await loadFly();
    await whenStill();
    // the wormhole post pass first: its render targets are the dive's biggest
    // allocation
    await scene.buildWormholePost();
    await whenStill();
    await fly?.warm();
    for (const r of riders) {
      await whenStill();
      (await loadRider(r))?.warm();
    }
  }

  // The two riders loaded up front. internals.ts owns focus and aperture
  // inside its own span.
  createInternalsAmbient(scene);
  const peelCards = createPeelCards(scene);

  // The 3D frame at the eased story p. Every value is written as value and
  // target so nothing lags; skipped while pE is unchanged.
  scene.onEvaluate((pE) => {
    if (pE === lastPE) return false;
    lastPE = pE;
    const s = scene.state;
    s.zoom = s.zoomTarget = zoomAt(pE);
    // internals.ts writes focus and aperture inside its span
    if (driverOwnsIris(pE)) {
      s.focus = s.focusTarget = 0;
      s.aperture = s.apertureTarget = preShutAt(pE);
    }
    s.explode = s.explodeTarget = explodeAt(pE);
    s.assemble = s.assembleTarget = assembleAt(pE);
    s.rose = s.roseTarget = roseAt(pE);
    s.huddle = s.huddleTarget = huddleAt(pE);
    scene.setModelOrientation(orientationAt(pE, ORIENT));
    uInkFill.value = inkFillAt(pE);
    // fly.ts owns the body fade from DIVE_P0 on
    if (pE < DIVE_P0) scene.setBodyFade(1);
    scene.setShellFade(shellFadeAt(pE));
    scene.setInteriorFade(interiorFadeAt(pE));
    // the only writer of the dust flag
    const dust = dustAt(pE);
    if (dust !== lastDust) {
      lastDust = dust;
      scene.setDust(dust);
    }
    // last, so the dive's own iris writes win inside its span
    fly?.evaluate(pE);
    return false;
  });

  let wCue = NaN;
  let wChrome = NaN;
  /** Write the DOM chrome at scroll p and set the target the 3D eases toward. */
  function frame(p: number) {
    if (p !== lastP) lastMoveAt = performance.now();
    lastP = p;
    scene.state.storyTarget = p;

    //   --beat-local      scene-local progress, 0..1
    //   --beat-visibility the caption band's fade
    for (const c of beats) {
      const local = clamp01((p - c.p0) / (c.p1 - c.p0));
      const visibility = band(p, c.a, c.b);
      if (local !== c.wLocal) {
        c.wLocal = local;
        c.el.style.setProperty("--beat-local", String(local));
      }
      if (visibility !== c.wVisibility) {
        c.wVisibility = visibility;
        c.el.style.setProperty("--beat-visibility", String(visibility));
      }
    }

    bgTint(p);

    // scroll-triggered loads of the lazy scenes
    if (p > flyPrefetchP) {
      warmNow = true;
      void loadFly();
    }
    for (const r of riders) if (p > r.at) void loadRider(r);

    // HUD and scene rail; the f-stop is filled in after the render
    const scn = sceneIndexAt(p);
    hudScn = scn;
    hudMm = focalMmAt(zoomAt(p));
    hudExpl = Math.round(explodeAt(p) * 100);
    spellHud();
    if (scn !== railScn) {
      railScn = scn;
      for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);
    }

    // scroll cue and chrome opacity, written only when they change
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

  // The track's position, re-measured only on layout changes, so a scroll
  // frame reads only scrollY and forces no layout.
  let trackTop = 0;
  let trackTotal = 0;
  const measureTrack = () => {
    trackTop = track.getBoundingClientRect().top + window.scrollY;
    trackTotal = track.offsetHeight - window.innerHeight;
  };
  const scrollP = () =>
    trackTotal > 0 ? clamp01((window.scrollY - trackTop) / trackTotal) : 0;
  // Set while the dev ?story panel's slider owns the story position.
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
  for (const [name, knobs] of Object.entries(STORY_KNOBS))
    for (const [knob, v] of Object.entries(knobs))
      recipeKnob(name as RecipeName, knob).value = v;
  // First frame synchronously, with the eased p snapped to the scroll, so a
  // deep link opens on its pose instead of animating to it.
  measureTrack();
  const p0 = scrollP();
  scene.state.story = p0;
  frame(p0);

  // Dev only: story inspection on `window.__lensStory`. state/cost/flow pull in
  // optics/, so they must stay dynamic imports inside this block.
  if (import.meta.env.DEV) {
    const load = () => import("./state");
    /** The live model root, from core/scene.ts's dev probe. */
    const modelRoot = (who: string): never => {
      const perf = (window as unknown as Record<string, { model?: unknown }>)
        .__lensPerf;
      if (!perf?.model)
        throw new Error(`__lensStory.${who}: the scene has not booted yet`);
      return perf.model as never;
    };
    (window as unknown as Record<string, unknown>).__lensStory = {
      /** the story state at any p */
      async stateAt(p: number, opts?: { light?: boolean }) {
        const { storyStateAt } = await load();
        return storyStateAt(p, { light: isLightTheme(), ...opts });
      },
      /** the story state at the last scroll p (not the eased p) */
      async dump() {
        const { storyStateAt } = await load();
        return storyStateAt(lastP, { light: isLightTheme() });
      },
      /** the renderer's workload at p, over the live scene */
      async costAt(p: number = lastP) {
        const { buildPartTableFromScene, storyCostAt } =
          await import("./cost");
        return storyCostAt(p, buildPartTableFromScene(modelRoot("costAt")));
      },
      /** where one piece (or every piece) is at p, over the live model */
      async pieceAt(p: number = lastP, key?: string) {
        const { buildPieceTable, pieceStateAt } = await import("./flow");
        const table = buildPieceTable(modelRoot("pieceAt"));
        return key
          ? pieceStateAt(p, key, table)
          : table.pieces.map((r) => pieceStateAt(p, r.key, table));
      },
      /** the per-scene × per-cast motion rollup (slow) */
      async flowTable() {
        const { buildPieceTable, flowRollups } = await import("./flow");
        return flowRollups(buildPieceTable(modelRoot("flowTable")));
      },
    };
  }

  // Dev-only story scrubber panel, for `/?story`.
  if (
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("story")
  ) {
    // channels shown in the panel, read back after easing
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
    panel.innerHTML = `<div class="lens-scrub-head"><span></span><span class="lens-scrub-mode"></span></div>
      <div class="lens-scrub-grid">${CH.map(() => "<span></span>").join("")}</div>
      <input type="range" min="0" max="1" step="0.0005">
      <button>follow scroll</button><div></div>`;
    document.body.append(panel);
    const [pLine, mode, ...cellEls] = panel.querySelectorAll("span");
    const cells = CH.map(([id, label], i) => ({ id, label, cell: cellEls[i] }));
    const slider = panel.querySelector("input")!;
    const follow = panel.querySelector("button")!;
    const jumps = panel.lastElementChild!;

    const park = (p: number) => {
      override = true;
      slider.value = String(p);
      frame(p);
    };
    slider.addEventListener("input", () => park(Number(slider.value)));
    follow.addEventListener("click", () => {
      override = false;
      frame(scrollP());
    });
    // one button per scene, jumping to its hold centre
    for (const r of RANGES) {
      const b = document.createElement("button");
      b.textContent = r.scene.title;
      b.addEventListener("click", () => park(holdCentreOf(r)));
      jumps.append(b);
    }

    // readout: p, scene and local fraction, eased channels
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
    onThemeChange(light) {
      BG_STOPS = bgStopsFor(light);
      bgTint(lastBgP);
    },
  };
}
