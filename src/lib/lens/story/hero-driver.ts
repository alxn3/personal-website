// Scroll driver for the homepage lens hero: writes the story's envelopes onto
// the scene each frame — mechanism channels, per-block --beat-* vars, HUD /
// scene-rail / scroll-cue chrome, background tint, pin projection. The element
// ids and data-* attributes queried below are the contract with
// LensStory.astro's hero markup.
//
// HOMEPAGE-CHUNK LAW: this file is in the initial chunk, so it may NEVER
// statically import optics/ or a lazy story module (fly, trails,
// constellations, state, cost, flow) — those are dynamic-import only.
//
// CAPTIONS ARE NOT HERE: their visibility is layout (story.ts CAPTION_BANDS +
// position: sticky), so they survive a driver that never starts. Everything
// this module does is enhancement over an acceptable CSS default.
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
import { revealRollAt } from "./reveal";
import { band, BAND_FEATHER, clamp01, smoothstep } from "../core/math";
import { isLightTheme } from "../core/theme";
import { createInternalsAmbient } from "./internals";
import { createPeelCards, peelRollAt } from "./peelcards";
// The envelopes (story/envelopes.ts) are pure functions of p — this file only
// WRITES them to the scene; it authors none of them.
import type { Rgb } from "./envelopes";
// TYPE-ONLY, both: these two are dynamic-import-only per the chunk law, and an
// erased import cannot pull them into the homepage's.
import type { StoryConstellations } from "./constellations";
import type { StoryTrails } from "./trails";
import {
  assembleKeepScopeAt,
  bgStopsFor,
  bgTintAt,
  chromeAt,
  driverOwnsIris,
  explodeAt,
  fStopOf,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  preShutAt,
  sceneIndexAt,
  scrollCueAt,
  shellFadeAt,
  wrapBloomWrite,
  zoomAt,
} from "./envelopes";

export interface HeroDriver {
  /** Theme flip: swap the bg stop table and re-tint at the current scroll. */
  onThemeChange: (light: boolean) => void;
}

/** the departure's scope knob, taken once — a guarded uniform box */
const keepScope = recipeKnob("assemble", "keepScope");

export function startHeroStory(scene: SceneHandle): HeroDriver {
  const track = document.getElementById("lens-track")!;
  const stage = document.getElementById("lens-stage")!;
  const hud = document.getElementById("hud")!;
  const sceneRail = document.getElementById("scene-rail")!;
  const scrollCue = document.getElementById("scroll-cue")!;
  // Per-block progress: any element with data-beat gets its scene's progress
  // written as custom properties each frame, so content-specific CSS can react
  // to the story. A typo'd id must not take the page down — warn and SKIP.
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
          // the block's band, straight off the story table. The FINAL band ends
          // at the track end and CSS holds that caption lit there, so its far
          // edge is pushed one feather past — otherwise --beat-visibility dims
          // over the last of the scroll while the caption stays up.
          a: bnd.a,
          b: bnd.final ? bnd.b + BAND_FEATHER : bnd.b,
          // --beat-progress window in scene-local 0..1, authored via
          // LensSceneContent's progressFrom/progressTo — parsed once, not per
          // frame
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
    (el) => ({ el, node: el.dataset.track!, wx: NaN, wy: NaN }),
  );
  if (pins.length) {
    // the projected point, reused across pins and frames
    const at = { x: 0, y: 0 };
    scene.onFrame((project) => {
      for (const pin of pins) {
        if (project(pin.node, at)) {
          // rounded to the tenth the transform is written at, so a pin that
          // lands on the same tenth writes no string
          const x = Math.round(at.x * 10) / 10;
          const y = Math.round(at.y * 10) / 10;
          if (x !== pin.wx || y !== pin.wy) {
            pin.wx = x;
            pin.wy = y;
            pin.el.style.transform = `translate(${x}px, ${y}px)`;
          }
          pin.el.style.visibility = "";
        } else {
          pin.el.style.visibility = "hidden"; // unknown node or behind the camera
        }
      }
    });
  }
  // Scene-rail dots: one per rail-flagged scene, matched to the markup by scene
  // id (LensStory.astro renders the spans off the same STORY filter). `i` is
  // the scene's index in RANGES.
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

  // last HUD readings and lit rail, so an unchanged frame writes no DOM
  let hudScn = -1;
  let hudFstop = "";
  let hudMm = -1;
  let hudExpl = -1;
  let railScn = -1;

  // background tint: the stop table is per THEME, held across frames and
  // rebuilt on a flip, so the per-frame path only interpolates.
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
  /** when the story position last moved — the prewarm waits on it */
  let lastMoveAt = 0;

  // The fly-through span's driver (story/fly.ts): dynamic-import only, per the
  // chunk law. Prefetch starts at the PEEL — several scenes of scrolling before
  // the dive, and a quiet stretch for the import's first-visit hitch to land.
  let fly: { frame(p: number): void; warm(): Promise<void> } | undefined;
  let flyLoad: Promise<unknown> | undefined;
  const flyPrefetchP = peR.p0;
  /** Import + warm the dive. Fired at BOOT idle (below) so the import, the
   *  wormhole pass compile and the glass clone build land while the reader is
   *  still on the hero; the scroll trigger in frame() is the fallback for a
   *  deep link that outruns the timer. */
  function loadFly() {
    if (flyLoad) return flyLoad;
    flyLoad = import("./fly")
      .then((m) => {
        fly = m.createStoryFly(scene);
        // A deep link parked inside the fly span imports on its ONE boot frame
        // and never scrolls again, so without this re-drive the dive would not
        // run. frame() is idempotent for a repeated p.
        frame(lastP);
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
  /** Stillness a warm waits for. A warm frame costs what the boundary it
   *  spares would have; landing it mid-gesture just moves the stutter. */
  const WARM_QUIET_MS = 350;
  /** Set once the reader crosses into the peel: scrolling that far IS proof
   *  they are heading for the dive, so the warms stop waiting for a still
   *  moment that may never come. The peel and cards are several quiet scenes
   *  of runway, and a warm frame there is far cheaper than the mount at the
   *  dive's own edge. */
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

  // The sky chapter's ink (story/constellations.ts), lazy for the same chunk
  // reason and SELF-DRIVING once created (its own onFrame, gated on
  // storyTarget), so there is no per-frame call here — only the load.
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

  // The turning sky (story/trails.ts), lazy and self-driving on the same terms.
  // It needs NO re-drive after the import (unlike the fly hook) because it
  // reads storyTarget from its own onFrame and catches up by itself.
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

  /** THE BOOT PREWARM, in the order the reader REACHES them and one idle window
   *  each: the card field's window opens first (a scene in), then the dive, then
   *  the sky chapter's ink and its trails. Importing is only half of it — each
   *  module's first DRAW is what uploads its textures and buffers, and that
   *  upload IS the boundary's stall. Every step waits for the story to STAND
   *  STILL, because a warm frame landing under the reader's thumb is the same
   *  stutter in a new place. The scroll triggers in frame() remain the fallback
   *  for a deep link — or a reader — that outruns this, and every step is
   *  idempotent against one. */
  async function prewarm() {
    await whenStill();
    peelCards.warm();
    await whenStill();
    await loadFly();
    await whenStill();
    // the pass's own frame, ahead of the dive's: its render targets are the
    // dive's biggest allocation and warmFly's dry frame is heavy enough alone
    await scene.buildWormholePost();
    await whenStill();
    await fly?.warm();
    await whenStill();
    await loadConstellations();
    constellations?.warm();
    await whenStill();
    await loadTrails();
    trails?.warm();
  }

  // The two STATICALLY imported story modules (neither pulls in optics/),
  // booted above frame(), which reaches for peelCards. internals.ts gates
  // itself to the internals span, where IT — not frame() — owns focus and
  // aperture; peelcards.ts is driven from frame() below plus its own onFrame.
  createInternalsAmbient(scene);
  const peelCards = createPeelCards(scene);

  // THE MODEL'S ROLL — the one setModelOrientation writer, on the RENDER loop,
  // because the ease outlives the scroll (a write from frame() would freeze the
  // angle mid-settle). Two terms, disjoint in p, summed because the orientation
  // is a snap-per-call absolute — and THE TWO-CLOCK LAW is that each rides the
  // clock its own neighbourhood runs on:
  //
  //   · the reveal's term takes the LIVE EASED channels (scene.state.story /
  //     .assemble), so spin, wrap and camera cannot come apart on a fling;
  //   · the peel's term stays on the RAW p, because its whole neighbourhood is
  //     raw — the card windows, the wink and the wrap below WRAP_EASE_P0 —
  //     and it settles on screen, so its own ramp has to die into its edge.
  //
  // The same callback applies story/envelopes.ts's wrap→bloom hand-over on the
  // values the deform host actually sums.
  scene.onFrame(() => {
    const pE = clamp01(scene.state.story);
    writeWrapBloom(lastP);
    scene.setModelOrientation({
      x: revealRollAt(pE, scene.state.assemble) + peelRollAt(lastP),
    });
  });

  /** Apply story/envelopes.ts's `wrapBloomWrite` at `p`: both targets always,
   *  the two VALUES only where the law names one (a `null` leaves the channel
   *  to core/scene's ease). */
  function writeWrapBloom(p: number) {
    const w = wrapBloomWrite(p, scene.state.assemble);
    scene.state.assembleTarget = w.assembleTarget;
    if (w.assemble !== null) scene.state.assemble = w.assemble;
    scene.state.roseTarget = w.roseTarget;
    if (w.rose !== null) scene.state.rose = w.rose;
  }

  function frame(p: number) {
    if (p !== lastP) lastMoveAt = performance.now();
    lastP = p;
    // The mechanism channels — every window is authored in story/envelopes.ts.
    const zoom = zoomAt(p);
    const explode = explodeAt(p);

    scene.state.zoomTarget = zoom;
    // Outside the cards+internals span the driver owns focus and the aperture's
    // pre-shut ramp; inside it story/internals.ts does, from a different rAF.
    // The two writers are separated by RANGE, not order.
    if (driverOwnsIris(p)) {
      scene.state.focusTarget = 0;
      scene.state.apertureTarget = preShutAt(p);
    }
    scene.state.explodeTarget = explode;
    // the wrap and the bloom on this clock, at the raw p
    writeWrapBloom(p);
    // …and the departure's SCOPE, which is a knob rather than a channel: the
    // cards chapter takes the outer layers off the mechanism it reveals, the
    // sky chapter reassembles the whole model (story/envelopes.ts).
    keepScope.value = assembleKeepScopeAt(p);
    // The model's roll is NOT written here — see the scene.onFrame writer above
    // and its two-clock law. The channel targets this function writes are what
    // that writer's gate chases.
    scene.state.storyTarget = p;

    // the ink ramps; the uniform box is materials/unified.ts's, so this line is
    // the only coupling
    uInkFill.value = inkFillAt(p);

    // THE BODY FADE IS THE DIVE'S ALONE. Nothing below DIVE_P0 hides the lens
    // any more — the cards scene takes the outer layers off in plain sight —
    // so this half of the tile is a constant 1, written to keep the tile
    // GAPLESS (applyBodyFade holds its last level on an unchanged write, and
    // early-outs on one, so the repeat costs a compare).
    if (p < DIVE_P0) scene.setBodyFade(1);

    // The shell's and the interior's winks and returns — one law each in
    // story/envelopes.ts, both riding story/peelcards.ts's WINK_SPAN.
    scene.setShellFade(shellFadeAt(p));
    scene.setInteriorFade(interiorFadeAt(p));

    // THE PEEL AND THE CARD FIELD. Must run AFTER the channel writes above,
    // because it owns the `peel` channel outright and the shell wedges' part
    // offsets; BEFORE the fly below, which is last for the same reason.
    peelCards.frame(p);

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

    // LAST: the fly owns aperture and focus while active, so its writes must
    // land after the resets above. All three lazy hooks catch AFTER the .then
    // rather than with its second argument, which would only see a failed
    // import and let a throwing factory out as an unhandled rejection.
    if (p > flyPrefetchP) warmNow = true; // the approach escalation
    if (!flyLoad && p > flyPrefetchP) loadFly();
    fly?.frame(p);

    if (!constLoad && p > constPrefetchP) loadConstellations();
    if (!trailsLoad && p > trailsPrefetchP) loadTrails();

    // HUD + scene rail, DEAD LAST: the readout REPORTS the story, so it has to
    // be composed after every span owner above has written its channels. The
    // f-stop reads the LIVE eased aperture, which the fly owns.
    const scn = sceneIndexAt(p);
    const fstop = fStopOf(scene.state.aperture);
    const mm = focalMmAt(zoom);
    const expl = Math.round(explode * 100);
    // the readout is only SPELLED when one of its four readings moves
    if (
      scn !== hudScn ||
      fstop !== hudFstop ||
      mm !== hudMm ||
      expl !== hudExpl
    ) {
      hudScn = scn;
      hudFstop = fstop;
      hudMm = mm;
      hudExpl = expl;
      hud.textContent = `SCN ${String(scn).padStart(2, "0")} / ${STORY[scn].title} · ${mm}MM · f/${fstop} · EXPL ${expl}%`;
    }
    if (scn !== railScn) {
      railScn = scn;
      for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);
    }

    // scroll cue lives only in the hero; the chrome fades at the very end
    scrollCue.style.opacity = String(scrollCueAt(p));
    const chrome = chromeAt(p);
    hud.style.opacity = String(chrome);
    sceneRail.style.opacity = String(chrome);
  }

  const scrollP = () => {
    const total = track.offsetHeight - window.innerHeight;
    return total > 0 ? clamp01(-track.getBoundingClientRect().top / total) : 0;
  };
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
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  // the first write is SYNCHRONOUS: boot runs before the first rendered frame,
  // so the fills (uInkFill boots at 1) never draw a frame the story didn't ask
  // for — an rAF here would race the render loop and lose
  frame(scrollP());

  // DEV: the story, programmatically — `window.__lensStory`, in the __lensOps /
  // __lensPerf mould, so one headless `evaluate` reports the story as JSON.
  //
  // READ-ONLY and LAZY BY NECESSITY: story/state.ts statically imports the
  // dive, the trails and the sky ink, which drag optics/ in, so it may only be
  // reached through the dynamic import inside this DEV-gated block.
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
      /** THE RENDERER'S WORKLOAD at p — story/cost.ts's law, but censusing the
       *  LIVE scene (triangles off the decoded geometry rather than the GLB's
       *  accessor counts), so this and STORY-COST.md check each other.
       *  Lazily imported for story/state.ts's reason. */
      async costAt(p: number = lastP) {
        const { buildPartTableFromScene, storyCostAt } =
          await import("./cost");
        return storyCostAt(p, buildPartTableFromScene(modelRoot("costAt")));
      },
      /** WHERE ONE PIECE IS at p, in the bore's cylindrical coordinates —
       *  story/flow.ts's law over the LIVE model's derived frames. Same lazy
       *  treatment as costAt above. */
      async pieceAt(p: number = lastP, key?: string) {
        const { buildPieceTable, pieceStateAt } = await import("./flow");
        const table = buildPieceTable(modelRoot("pieceAt"));
        return key
          ? pieceStateAt(p, key, table)
          : table.pieces.map((r) => pieceStateAt(p, r.key, table));
      },
      /** …and the whole per-scene × per-cast rollup — the checked-in map's
       *  first table. Slow: every piece through the real pipeline at every
       *  edge of the story. */
      async flowTable() {
        const { buildPieceTable, flowRollups } = await import("./flow");
        return flowRollups(buildPieceTable(modelRoot("flowTable")));
      },
    };
  }

  // Dev-only story scrubber, stripped from production with the block above and
  // built only for `/?story`, so a dev visit without the param gets no extra
  // DOM and no extra listeners.
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
    // one jump per scene, parked at the settle region's midpoint so the scene
    // reads as held rather than mid-flight
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
