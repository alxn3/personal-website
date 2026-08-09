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
import { uInkFill } from "../materials/shading";
import {
  STORY,
  RANGES,
  rangeOf,
  bandOf,
  atFrac,
  pulse,
  type StoryWindow,
} from "./story";
import { band, BAND_FEATHER, clamp01, smoothstep } from "../core/math";
import { isLightTheme } from "../core/theme";
import { createInternalsAmbient } from "./internals";
import { createPeelCards } from "./peelcards";

const F_STOPS = ["2.8", "4", "5.6", "8", "11", "16", "22"];

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

  // scene ranges (all pacing derives from the STORY table durations); the
  // mechanism envelopes below name their scenes inline via pulse()
  const heroR = RANGES[0];
  const zR = rangeOf("zoom");
  const peR = rangeOf("peel");
  const inR = rangeOf("internals");
  const tR = rangeOf("trails");
  const rwR = rangeOf("rewrap");
  const capR = rangeOf("capsOn");
  // Instrument chrome (HUD + scene rail) fades out over the tail of the FINAL
  // scene — derived from the capsOn range rather than absolute p, so a duration
  // change upstream can't leave it fading mid-story: 0.77 through capsOn
  // reproduces the signed-off absolute p ≈ 0.965 under today's holds.
  const CHROME_FADE_P0 = atFrac(capR, 0.77);

  // background tint, sampled from each scene's `bg`/`bgLight` at its hold-centre
  const bgStopsFor = (light: boolean): [number, [number, number, number]][] =>
    RANGES.map((r) => [
      (r.p0 + r.p1) / 2,
      light ? r.scene.bgLight : r.scene.bg,
    ]);
  let BG_STOPS = bgStopsFor(isLightTheme());
  let lastBgP = 0;
  function bgTint(p: number) {
    lastBgP = p;
    let i = 0;
    while (i < BG_STOPS.length - 2 && p > BG_STOPS[i + 1][0]) i++;
    const [pa, a] = BG_STOPS[i];
    const [pb, b] = BG_STOPS[i + 1];
    const t = clamp01((p - pa) / Math.max(1e-3, pb - pa));
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
    stage.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // The teardown and the reassembly are ONE pair of channels run in opposite
  // directions over a shared RETURN window: everything is home by 25% into
  // caps-on — BEFORE the camera's fast equatorial pass gets close (huge
  // un-seated sheets would otherwise fill the frame mid-spin).
  const RETURN: StoryWindow = [
    ["rewrap", 0.05],
    ["capsOn", 0.25],
  ];

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
  // render loop runs every frame in story mode — so it catches up by itself.
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

  function frame(p: number) {
    lastP = p;
    // Each mechanism PULSES over its own scene — rises during the hold, resets
    // during the NEXT scene's transit. All breakpoints derive from the ranges.
    const zoom = pulse(p, {
      rise: ["zoom", 0.15, 0.62],
      fall: ["peel", 0, 0.4],
    });
    // BRIDGE (Phase 0 — Phase F replaces this with the trails→shell entrance):
    // the ring story never fully explodes the lens, but the signed-off rewrap
    // reassembly needs the model torn down before it can wrap back on. Until
    // the trails scene hands real shell pieces to rewrap, tear down over the
    // trails scene so the ending still plays. Assemble keeps the shared RETURN
    // window — its staggered gate owns the visible layer-by-layer return.
    const explode = pulse(p, {
      rise: ["trails", 0.05, 0.5],
      fall: [
        ["trails", 0.85],
        ["rewrap", 0.3],
      ],
    });
    const assemble = pulse(p, { rise: ["trails", 0.15, 0.8], fall: RETURN });

    scene.state.zoomTarget = zoom;
    // THE DOOR CLOSES BEFORE THE DIVE: the aperture ramps to shut over the tail
    // of the internals scene and stays there, so the fly-through's own opening
    // ramp (story/fly.ts, FLY.pAperture) starts from f/22 with no jump. The
    // stop-down is invisible — it happens inside the reassembling lens.
    //
    // PAIRED with story/internals.ts's `preShut` (internalsApertureAt), which
    // runs this identical expression INSIDE the internals span and adds the
    // ambient breath on top. Keep the two textually identical: together they
    // are one continuous law across both edges of the scene.
    const preShut = smoothstep(atFrac(inR, 0.6), atFrac(inR, 0.95), p);
    // THE INTERNALS SPAN IS NOT OURS. story/internals.ts owns focus and
    // aperture (value AND target) for the whole scene, writing from
    // scene.onFrame — a different rAF with no ordering guarantee against this
    // one, so the two writers are separated by RANGE, not by order.
    //
    // Outside the span focus rests at 0. The fly span writes focus (value AND
    // target) too, and it does so from fly.frame() at the END of this function
    // — after these lines, in the same call — so those two never fight either:
    // the reset only reaches the channel on the frames the fly is not driving it.
    if (p < inR.p0 || p > inR.p1) {
      scene.state.focusTarget = 0;
      scene.state.apertureTarget = preShut;
    }
    scene.state.explodeTarget = explode;
    scene.state.assembleTarget = assemble;
    scene.state.storyTarget = p;

    // ink fill: wireframe → HALF fill through zoom → FULL ink once the peel
    // starts → drops toward wireframe for the bridge teardown → back to full
    // ink for the caps-on product shot.
    uInkFill.value =
      0.5 * smoothstep(atFrac(zR, 0.0), atFrac(zR, 0.5), p) +
      0.5 * smoothstep(peR.p0, atFrac(peR, 0.35), p) -
      0.84 * smoothstep(atFrac(tR, 0.1), atFrac(tR, 0.6), p) +
      0.84 * smoothstep(atFrac(rwR, 0.1), atFrac(rwR, 0.8), p);

    // THE SHELL LEAVES WITH THE PEEL, LATE: the strips have to stay visible
    // through the whole unroll and the start of their outward drift, so the
    // wink-out only runs over peel [0.60, 0.95] — inside the card cross-fade
    // (story/peelcards.ts fades the cards in over peel [0.55, 0.98]), which is
    // what covers it: the strips scatter away as the cards arrive over them.
    // ONE envelope for all three casts — the skin, the two inner tubes and the
    // baffles come off inside this same window, ordered outside-in by their own
    // bands of the level (core/scene captureShellThresholds), so the layers
    // uncover one another instead of leaving together.
    // The shell then stays gone while the cards orbit and the internals work,
    // and is restored at rewrap — behind the opaque sky backdrop (the fly span
    // owns scene.background until ~rewrap 0.25), so the pop is unseen and the
    // reassembly flies the shell home as before.
    scene.setShellFade(
      1 -
        smoothstep(atFrac(peR, 0.6), atFrac(peR, 0.95), p) +
        smoothstep(rwR.p0, atFrac(rwR, 0.05), p),
    );

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
    if (!flyLoad && p > flyPrefetchP) {
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
    let scn = RANGES.length - 1;
    for (let k = 0; k < RANGES.length; k++) {
      if (p < RANGES[k].p1) {
        scn = k;
        break;
      }
    }
    const focal = Math.round(18 + zoom * 32);
    const fstop =
      F_STOPS[Math.round(clamp01(scene.state.aperture) * (F_STOPS.length - 1))];
    hud.textContent = `SCN ${String(scn).padStart(2, "0")} / ${STORY[scn].title} · ${focal}MM · f/${fstop} · EXPL ${Math.round(explode * 100)}%`;
    for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);

    // scroll cue lives only in the hero; the instrument chrome fades at the very end
    scrollCue.style.opacity = String(
      1 - smoothstep(atFrac(heroR, 0.1), atFrac(heroR, 0.9), p),
    );
    const chrome = 1 - smoothstep(CHROME_FADE_P0, capR.p1, p);
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

  // Dev-only story scrubber: built ONLY when the URL has a `story` query param
  // (`/?story`) — normal visitors get zero extra DOM and zero extra listeners.
  if (new URLSearchParams(location.search).has("story")) {
    // every channel the story drives, read back LIVE (post-ease) each frame
    const CH = [
      ["zoom", "zoom"],
      ["focus", "focus"],
      ["aperture", "aper"],
      ["explode", "expl"],
      ["assemble", "asm"],
      ["peel", "peel"],
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
      b.addEventListener("click", () =>
        park(atFrac(r, (r.scene.transit + 1) / 2)),
      );
      jumps.append(b);
    }

    // cheap per-frame readout: p, scene + local fraction, live EASED channels
    scene.onFrame(() => {
      let k = RANGES.length - 1;
      for (let i = 0; i < RANGES.length; i++)
        if (lastP < RANGES[i].p1) {
          k = i;
          break;
        }
      const r = RANGES[k];
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
