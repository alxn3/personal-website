// Scroll driver for the homepage lens hero: maps the pinned track's scroll
// progress onto the story — mechanism pulse envelopes, per-block --beat-*
// progress vars (content-specific effects like the focus blur-rack and the
// pins' own fade live in CSS with the content, not here), HUD / scene-rail /
// scroll-cue chrome, background tint, and tracked-part pin projection. The
// element ids and data-* attributes queried below are the contract with
// LensStory.astro's hero markup.
//
// CAPTIONS ARE NOT HERE. Their visibility is layout — a band per scene plus
// position: sticky, derived from the same table at build time (story.ts
// CAPTION_BANDS) — so they survive a driver that is slow, broken or never
// started. Everything this module does is pure enhancement with an acceptable
// CSS default when it is absent.
//
// The component (LensStory.astro) keeps everything that must run WITHOUT a
// driver: initScene + fallback handling, the theme watcher (it forwards flips
// here via HeroDriver.onThemeChange), the pause IntersectionObserver, and the
// reduced-motion parked pose — this module only ever runs with a live,
// animated scene.

import type { SceneHandle } from "../core/scene";
import { uInkFill } from "../materials/unified";
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
import { createPeelCards, peelBodyFadeAt, peelRollAt } from "./peelcards";
// The envelopes themselves (story/envelopes.ts) — pure functions of p, so the
// story's shape is readable, testable and reportable without this DOM-bound
// closure. This file writes them to the scene; it no longer AUTHORS any of them.
import {
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
  /** Theme flip: swap the bg stop table and re-tint at the current scroll position. */
  onThemeChange: (light: boolean) => void;
}

export function startHeroStory(scene: SceneHandle): HeroDriver {
  const track = document.getElementById("lens-track")!;
  const stage = document.getElementById("lens-stage")!;
  const hud = document.getElementById("hud")!;
  const sceneRail = document.getElementById("scene-rail")!;
  const scrollCue = document.getElementById("scroll-cue")!;
  // Per-block progress: ANY element with data-beat (LensSceneContent's caption
  // wrapper, LensPin) gets its scene's progress written as custom properties
  // every frame, so content-specific CSS can react to the story — the focus
  // blur-rack, a pin's own fade. VISIBILITY is not among them: captions are
  // placed and faded by layout + CSS (see the header), and a pin simply reads
  // --beat-visibility, defaulting to hidden when no driver ever runs. A typo'd
  // id must not take the page down: warn and SKIP (caption bands are validated
  // at BUILD time — bandOf throws in the Astro frontmatter — so this only
  // covers hand-written markup like a pin's scene).
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
          // the block's band, straight off the story table — the same numbers
          // the markup laid out with. One exception: the FINAL band ends AT the
          // track end (b = 1), and CSS holds that caption lit there (its band
          // is the last one, so its fade-out window sits a viewport past maximum
          // scroll and is never reached). Pushing the far edge one feather past
          // the end holds --beat-visibility at 1 there too, rather than dimming
          // over the last 4% of the scroll.
          a: bnd.a,
          b: bnd.final ? bnd.b + BAND_FEATHER : bnd.b,
          // --beat-progress window in scene-local 0..1 (data-progress-from/-to,
          // authored via LensSceneContent's progressFrom/progressTo props) —
          // parsed once here, not per frame
          f0: Number(el.dataset.progressFrom ?? 0),
          f1: Number(el.dataset.progressTo ?? 1),
        },
      ];
    },
  );

  // Tracked-part pins: every [data-track] element follows its model node's
  // projected screen position each frame (see LensPin.astro / SceneHandle.onFrame).
  const pins = [...stage.querySelectorAll<HTMLElement>("[data-track]")];
  if (pins.length) {
    scene.onFrame((project) => {
      for (const el of pins) {
        const pt = project(el.dataset.track!);
        if (pt) {
          el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
          el.style.visibility = "";
        } else {
          el.style.visibility = "hidden"; // unknown node or behind the camera
        }
      }
    });
  }
  // Scene-rail dots: one per rail-flagged story scene, matched to the markup by
  // scene id (LensStory.astro renders the spans from the same STORY filter, so
  // the rail can never drift from the table). `i` is the scene's index in RANGES.
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

  // background tint: the stop table is per THEME (story/envelopes.ts
  // bgStopsFor), held across frames and rebuilt on a flip, so the per-frame path
  // only interpolates. The DOM write is what stays here.
  let BG_STOPS = bgStopsFor(isLightTheme());
  let lastBgP = 0;
  function bgTint(p: number) {
    lastBgP = p;
    const c = bgTintAt(BG_STOPS, p);
    stage.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  let lastP = 0; // last p handed to frame() — read by the dev scrub panel

  // The fly-through span's driver (story/fly.ts), loaded on approach: it
  // statically imports the optics uniform boxes, which must stay out of the
  // homepage's initial chunk, so it is dynamic-import ONLY. Prefetch starts at
  // the PEEL — several scenes of scrolling before the dive needs it, and, unlike
  // the cards edge it used to sit on, a quiet one: the import's first-visit
  // hitch used to land on the peel→cards park flip, which is the story's largest
  // lateral pan and the worst place in the story to drop frames.
  let fly: { frame(p: number): void; warm(): Promise<void> } | undefined;
  let flyLoad: Promise<unknown> | undefined;
  const flyPrefetchP = peR.p0;
  /** Import + warm the dive. Fired at BOOT idle (below), so the import, the
   *  wormhole pass compile and the glass clone build all land while the reader
   *  is still on the hero — a warm-up that fired at the peel landed its stall
   *  in the story's busiest animation (the owner felt it). The scroll trigger
   *  in frame() stays as the fallback for a deep link that outruns the timer. */
  function loadFly() {
    if (flyLoad) return;
    flyLoad = import("./fly")
      .then((m) => {
        fly = m.createStoryFly(scene);
        // A deep link parked inside the fly span schedules this import on
        // its ONE boot frame and then never scrolls — without a re-drive,
        // fly.frame(p) would not run until the user nudges the page and the
        // sky would never mount. frame() is idempotent for a repeated p.
        frame(lastP);
        // …and then, at idle, BUILD the dive's optics (fly.ts warm): the
        // module import is only half the prefetch — the wormhole pass's
        // pipeline compile is the rest, and it is the crossing's whole stall
        // if it is left to the first frame of the span. A no-op if that boot
        // frame already put us inside the dive.
        atIdle(() => void fly?.warm());
      })
      .catch((err) => console.warn("lens fly: driver failed to load", err));
  }
  setTimeout(loadFly, 2500);
  /** Run `cb` when the page has a moment, and no later than the timeout. Used
   *  for the fly's optics warm-up, which is expensive and must not land on the
   *  frame that imported it either. */
  const atIdle = (cb: () => void) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(cb, { timeout: 2000 });
    else setTimeout(cb, 500);
  };

  // The sky chapter's ink (story/constellations.ts), loaded on the same terms
  // and for the same reason: it statically imports optics/ (the line engine and
  // the sky catalog), which must stay out of the homepage's initial chunk. It
  // is SELF-DRIVING once created — its own scene.onFrame ambient, gated on
  // storyTarget — so there is no per-frame call here, only the load. Prefetch
  // starts as the dive does: the sky scenes are two scenes further on, which is
  // several seconds of scrolling for a module of this size.
  let constLoad: Promise<unknown> | undefined;
  const constPrefetchP = rangeOf("flythrough").p0;

  // The turning sky (story/trails.ts), on the same terms again: lazy for the
  // same chunk reason, and SELF-DRIVING off its own scene.onFrame. Prefetch
  // starts one scene ahead of its own span, at the top of the sky chapter.
  //
  // NO frame(lastP) RE-DRIVE, unlike the fly hook. That one exists because
  // fly.frame(p) is called from HERE, so a deep link that imports on its one
  // boot frame and never scrolls again would never mount the sky. This driver
  // takes its p from scene.state.storyTarget inside its own onFrame, which the
  // render loop runs on every frame in story mode — so it catches up
  // by itself.
  let trailsLoad: Promise<unknown> | undefined;
  const trailsPrefetchP = rangeOf("constellations").p0;

  // The two STATICALLY imported story modules, booted here — above frame(),
  // which reaches for peelCards, and together, because they are the same kind of
  // thing: a scene's own choreography, gated on its own span.
  //
  // The internals scene's time-based ambient (story/internals.ts) registers its
  // own onFrame and gates itself to the internals span, where it — not frame()
  // — owns focus and aperture. The peel/cards module (story/peelcards.ts) is
  // driven from frame() below on the scroll side and runs the card field's orbit
  // from its own onFrame. Neither pulls in anything from optics/, unlike the fly.
  createInternalsAmbient(scene);
  const peelCards = createPeelCards(scene);

  // THE MODEL'S ROLL — the one setModelOrientation writer, on the RENDER loop
  // rather than the scroll. Two terms, disjoint in p (the reveal's roll and the
  // peel's spin), added here because the orientation is a snap-per-call
  // absolute. Each rides the clock its own neighbourhood runs on:
  //
  //   · THE REVEAL'S TERM TAKES THE LIVE EASED CHANNELS — scene.state.story
  //     and scene.state.assemble, the values the camera and the deform are
  //     drawn at — so the spin, the wrap and the camera cannot come apart at
  //     any scroll speed. On the raw scroll a fling would spend the roll before
  //     the pieces had moved.
  //
  //   · THE PEEL'S TERM STAYS ON THE RAW p (`lastP`): its whole neighbourhood
  //     is raw — the body fade, the card windows and the wrap channel below
  //     WRAP_EASE_P0 — and the spin's one angular-rate STEP is placed inside
  //     the fade's valley, which only hides it while the two share a clock.
  //     `lastP` is 0 before the first frame(), where peelRollAt(0) is 0.
  //
  //   · WRITTEN FROM scene.onFrame BECAUSE THE EASE OUTLIVES THE SCROLL —
  //     frame() only runs on scroll events, so a write from there would freeze
  //     the angle mid-settle. Unconditional every rendered frame; it is exactly
  //     0 outside both windows. The callbacks run AFTER renderer.render, so the
  //     orientation written on frame N is what N+1 draws.
  //
  // (The SKY stays on the raw target — story/trails.ts reads storyTarget — a
  // scrub-honest long exposure.)
  //
  // The same callback hands the wedge from the wrap to the bloom, on the values
  // the host actually sums: the wrap is written to an exact 0 once it is under
  // WRAP_SPENT, the bloom's target waits for that, and the bloom is held at 0
  // below its own foot so the exclusion is symmetric on the way back up (a snap
  // of up to the rose's own level there, on a jump or a reverse fling — the
  // alternative is a flower decaying over a rising wrap). The law itself is
  // story/envelopes.ts's `wrapBloomWrite`; this is the write.
  scene.onFrame(() => {
    const pE = clamp01(scene.state.story);
    writeWrapBloom(lastP);
    scene.setModelOrientation({
      x: revealRollAt(pE, scene.state.assemble) + peelRollAt(lastP),
    });
  });

  /** Apply story/envelopes.ts's `wrapBloomWrite` at `p`: the two targets always,
   *  the two VALUES only where the law names one (a `null` leaves the channel to
   *  core/scene's ease). Called from both of the driver's clocks. */
  function writeWrapBloom(p: number) {
    const w = wrapBloomWrite(p, scene.state.assemble);
    scene.state.assembleTarget = w.assembleTarget;
    if (w.assemble !== null) scene.state.assemble = w.assemble;
    scene.state.roseTarget = w.roseTarget;
    if (w.rose !== null) scene.state.rose = w.rose;
  }

  function frame(p: number) {
    lastP = p;
    // The mechanism channels — every window authored in story/envelopes.ts,
    // which is where the reasons for their edges are written too.
    const zoom = zoomAt(p);
    // The explode channel is the PIECES' RADIUS and the assemble channel the
    // reassembly; both are story/envelopes.ts's (EXPLODE_PULSE / ASSEMBLE_PULSE
    // + RETURN), which carries the bridge note and the REVEAL_END identity.
    const explode = explodeAt(p);

    scene.state.zoomTarget = zoom;
    // Outside the cards+internals span the driver owns focus (rested at 0) and
    // the aperture's pre-shut ramp; inside it story/internals.ts does, from a
    // different rAF. The predicate and the ramp are both story/envelopes.ts's —
    // `preShutAt` is now literally the same function internals.ts calls, where
    // the two used to be expressions kept textually identical by a comment.
    if (driverOwnsIris(p)) {
      scene.state.focusTarget = 0;
      scene.state.apertureTarget = preShutAt(p);
    }
    scene.state.explodeTarget = explode;
    // THE WRAP AND THE BLOOM on this clock — the same `wrapBloomWrite` the
    // render callback applies, at the raw p. Below WRAP_EASE_P0 it writes the
    // wrap's VALUE too (the cards chapter runs raw, like `peel`), and it shuts
    // the bloom in the same callback that raises the wrap's target.
    writeWrapBloom(p);
    // …THE TURN ITSELF — the model's rigid roll about the optical axis — is
    // NOT written here: it is the scene.onFrame writer above, because its gate
    // is the LIVE eased assemble channel (the fluid fast-scroll hand-over) and
    // the ease outlives the last scroll event. The channel targets this
    // function writes are what that writer's gate chases. (The peel's own spin
    // is added in the same call — one orientation, one writer — but off this
    // function's raw `lastP`, which is the clock its neighbours run on.)
    scene.state.storyTarget = p;

    // the ink's own four ramps (story/envelopes.ts inkFillAt) — the uniform box
    // is materials/unified.ts's, so this line is the only coupling
    uInkFill.value = inkFillAt(p);

    // THE SPREAD LENS LEAVES AND THE CARDS TAKE THE TURN OVER. The envelope is
    // AUTHORED IN story/peelcards.ts (peelBodyFadeAt, BODY_FADE_OUT/BACK,
    // VALLEY) and only WRITTEN here, because everything timed against it is
    // that module's:
    //
    //   cards 0.42 → 0.54   out, under the arriving card shell, once the
    //                        reverse reassembly has spread the lens
    //   cards 0.54 → 0.66   THE VALLEY: exactly 0, so the meshes are out of
    //                        applyVisibility. Everything unseen happens here —
    //                        the wink, the departure channel's fall to 0 and
    //                        the spin's own stop
    //   cards 0.66 → 0.74   back in, on the BARE MECHANISM the internals scene
    //                        opens by taking apart
    //
    // It fades the ink LINES with the fills — materials/unified.ts's edge-line
    // opacityNode reads `materialOpacity` for this; before that fix a body fade
    // anywhere the ink was on left a full-strength wireframe ghost behind. It
    // takes the GLASS with it too (core/scene bodyMaterials), without which the
    // frame kept a column of mint elements where the lens had been.
    //
    // NOT OURS FROM THE DIVE ON. story/fly.ts owns this channel inside its own
    // span (it covers the body while the lens walks home past the camera) and
    // its writes land at the END of this function — but setBodyFade CAPTURES and
    // RESTORES material state on its 1-edge, so an unconditional 1 from here
    // would restore and re-capture ~10 materials on every frame of the reveal.
    //
    // SO IT IS RANGE-TILED, AND THE TILE HAS TO BE GAPLESS. The seam is DIVE_P0
    // (story/story.ts) — the fly's own first frame, not its scene's p0: the fly
    // writes nothing until then (fly.ts's activation edge is the same constant),
    // so a tile ending at the scene boundary left 0.024 of p — the flythrough's
    // whole approach — with NO owner, and applyBodyFade holds its last level on
    // an unchanged write. One frame(p) jumping from inside the valley into that
    // band (the ?story scrubber, a deep link, a wheel flick — this driver runs
    // off the RAW scroll with no easing) would have left the lens hidden with
    // nothing to bring it back. Both sides are exactly 1 where they meet:
    // peelBodyFadeAt saturates at cards 0.82, a scene and a half earlier, and
    // flyBodyFadeAt is 1 until dive-local 0.9. The hysteresis band just below
    // DIVE_P0, where an already-active fly still writes, is therefore a harmless
    // double-write of the same 1.
    if (p < DIVE_P0) scene.setBodyFade(peelBodyFadeAt(p));

    // The shell's and the interior's winks, and their two returns — one law
    // each in story/envelopes.ts, both riding story/peelcards.ts's WINK_SPAN so
    // its containment inside the body fade's valley stays that module's
    // business.
    scene.setShellFade(shellFadeAt(p));
    scene.setInteriorFade(interiorFadeAt(p));

    // THE PEEL AND THE CARD FIELD (story/peelcards.ts). AFTER the channel
    // writes above, because it owns the `peel` channel outright (value AND
    // target) and the shell wedges' part offsets; BEFORE the fly below, which
    // must stay last for the same reason on aperture and focus.
    peelCards.frame(p);

    // per-block progress custom properties, so content-specific effects (the
    // focus blur-rack, a pin's fade) live in CSS with the content instead of
    // being special-cased here —
    //   --beat-local      raw scene-local progress, clamp01 0..1
    //   --beat-progress   smoothstep of local over the block's authored
    //                     progressFrom..progressTo window
    //   --beat-visibility the story table's fade band for the block (what the
    //                     CSS caption fade approximates; the pins ride it)
    for (const c of beats) {
      const local = clamp01((p - c.p0) / (c.p1 - c.p0));
      c.el.style.setProperty("--beat-local", String(local));
      c.el.style.setProperty(
        "--beat-progress",
        String(smoothstep(c.f0, c.f1, local)),
      );
      c.el.style.setProperty("--beat-visibility", String(band(p, c.a, c.b)));
    }

    bgTint(p);

    // LAST, deliberately: the fly owns the aperture and focus channels while it
    // is active, and its writes have to land after the resets above.
    //
    // ALL THREE LAZY HOOKS CATCH AFTER THE .then, not with its second argument: the
    // two-argument form only sees a failed IMPORT, and a factory that threw
    // would go out as an unhandled rejection instead. Neither driver is
    // load-bearing — the story runs without them — so a failure is a warning
    // and nothing more.
    if (!flyLoad && p > flyPrefetchP) loadFly();
    fly?.frame(p);

    if (!constLoad && p > constPrefetchP) {
      constLoad = import("./constellations")
        .then((m) => m.createStoryConstellations(scene))
        .catch((err) =>
          console.warn("lens constellations: driver failed to load", err),
        );
    }

    if (!trailsLoad && p > trailsPrefetchP) {
      trailsLoad = import("./trails")
        .then((m) => m.createStoryTrails(scene))
        .catch((err) =>
          console.warn("lens trails: driver failed to load", err),
        );
    }

    // HUD + scene rail — current scene from the ranges.
    //
    // DEAD LAST, after every span owner above has written its channels: the
    // readout REPORTS the story, so it must be composed from the settled state
    // rather than from the state as it stood at the top of this call. The
    // f-stop is why — the fly owns aperture, so composing the string before
    // fly.frame(p) printed the PRE-fly value, and re-entering the dive from
    // above (a single scroll event from p ≈ 0.97 to ≈ 0.52, then parked) left
    // the HUD claiming f/22 over a wide-open lens until the next scroll.
    // The f-stop reads the LIVE eased channel, not the authored value at p —
    // which is the whole reason this block is last (see above).
    const scn = sceneIndexAt(p);
    const fstop = fStopOf(scene.state.aperture);
    hud.textContent = `SCN ${String(scn).padStart(2, "0")} / ${STORY[scn].title} · ${focalMmAt(zoom)}MM · f/${fstop} · EXPL ${Math.round(explode * 100)}%`;
    for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);

    // scroll cue lives only in the hero; the instrument chrome fades at the very end
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
  onScroll();

  // DEV: the story, programmatically — `window.__lensStory` in the __lensOps /
  // __lensPerf mould (core/scene.ts). One `evaluate` in a headless browser now
  // answers "which scene, where is the camera, which windows are open at p"
  // as JSON, instead of screenshotting the ?story panel and reading strings.
  //
  // READ-ONLY, and LAZY BY NECESSITY: story/state.ts statically imports the
  // dive, the trails and the sky ink, which drag optics/ in — so it may only
  // ever be reached through this import(), which `import.meta.env.DEV` removes
  // from a production build along with the whole block (verified on the built
  // homepage chunk: nothing of state.ts or optics/ enters its static graph).
  if (import.meta.env.DEV) {
    const load = () => import("./state");
    /** The live model root, off core/scene.ts's own DEV probe — present on
     *  exactly the pages this block is, so no reader here has to widen the
     *  public SceneHandle. */
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
      /** …and at the p the driver last ran, which is the scroll position (or
       *  the ?story panel's parked override) rather than the eased channel */
      async dump() {
        const { storyStateAt } = await load();
        return storyStateAt(lastP, { light: isLightTheme() });
      },
      /** THE RENDERER'S WORKLOAD at p — the same law STORY-COST.md is generated
       *  from (story/cost.ts), but censusing the LIVE scene: triangles come off
       *  the DECODED geometry rather than out of the GLB's accessor counts, so
       *  this and the checked-in table are an identity check on each other. Any
       *  drift between the two is one `evaluate` away from being seen.
       *
       *  Lazily imported for story/state.ts's reason (cost.ts pulls it in, and
       *  optics/ behind it) and stripped from production with this whole block.
       *  The model root comes off `__lensPerf` — core/scene.ts's own DEV probe,
       *  present on exactly the pages this block is — rather than widening the
       *  public SceneHandle for a dev reader. */
      async costAt(p: number = lastP) {
        const { buildPartTableFromScene, storyCostAt } =
          await import("./cost");
        return storyCostAt(p, buildPartTableFromScene(modelRoot("costAt")));
      },
      /** WHERE ONE PIECE IS at p, in the bore's own cylindrical coordinates —
       *  the law PIECE-FLOW.md is generated from (story/flow.ts), censusing the
       *  LIVE model's derived frames rather than a node-side decode of the same
       *  GLB. Same lazy treatment and same `__lensPerf` root as costAt above. */
      async pieceAt(p: number = lastP, key?: string) {
        const { buildPieceTable, pieceStateAt } = await import("./flow");
        const table = buildPieceTable(modelRoot("pieceAt"));
        return key
          ? pieceStateAt(p, key, table)
          : table.pieces.map((r) => pieceStateAt(p, r.key, table));
      },
      /** …and the whole per-scene × per-cast rollup, which is what the checked-in
       *  map's first table is. Seconds, not milliseconds: it is the full 207
       *  pieces through the real pipeline at every edge of the story. */
      async flowTable() {
        const { buildPieceTable, flowRollups } = await import("./flow");
        return flowRollups(buildPieceTable(modelRoot("flowTable")));
      },
    };
  }

  // Dev-only story scrubber: DEV builds only — `import.meta.env.DEV` strips
  // the whole block (panel DOM, styles, wiring) from production output, the
  // same treatment as the `__lensStory` rider above — and built ONLY when the
  // URL has a `story` query param (`/?story`), so a dev visit without it gets
  // zero extra DOM and zero extra listeners.
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
    // one jump per scene, parked at the settle region's midpoint (past the
    // camera transit, so the scene reads as held rather than mid-flight)
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
    // theme flip: swap the stop table and re-tint at the current scroll position
    onThemeChange(light) {
      BG_STOPS = bgStopsFor(light);
      bgTint(lastBgP);
    },
  };
}
