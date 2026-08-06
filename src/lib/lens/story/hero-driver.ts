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
  const fR = rangeOf("focus");
  const exR = rangeOf("explode");
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

  function frame(p: number) {
    lastP = p;
    // Each mechanism PULSES over its own scene — rises during the hold, resets
    // during the NEXT scene's transit. All breakpoints derive from the ranges.
    const zoom = pulse(p, {
      rise: ["zoom", 0.15, 0.62],
      fall: ["focus", 0, 0.4],
    });
    const focus = pulse(p, {
      rise: ["focus", 0.15, 0.62],
      fall: ["aperture", 0, 0.4],
    });
    const aperture = pulse(p, {
      rise: ["aperture", 0.2, 0.66],
      fall: ["explode", 0, 0.35],
    });
    // EXPLODE (the explode recipe) — the whole model fans off the axis. Completes
    // EARLY in its scene (well fanned apart by the time the caption is prominent,
    // not a half-open cage), HOLDS through the light-path scene, then collapses
    // on its OWN early fall: the solid core comes home behind the light-path
    // isolate's blackout and is seated, waiting, by the time the shells wrap
    // back on — the classic "glass column waits" beat. Assemble keeps the shared
    // RETURN window, so its staggered gate owns the visible layer-by-layer return.
    const explode = pulse(p, {
      rise: ["explode", 0.08, 0.55],
      fall: [
        ["lightPath", 0.9],
        ["rewrap", 0.3],
      ],
    });
    // ASSEMBLE (the assemble recipe) runs BACKWARDS here: 1 is the disassembled
    // state — shells unrolled to flat sheets and flown off the ladder — and 0 is
    // seated. So its RISE is the teardown's peel (it rides the explode, slightly
    // delayed so the early explode still reads as solid wedges pulling apart) and
    // its FALL, over the same return window, IS the reassembly: each layer flies
    // home and wraps back on inner → outer, on the recipe's own per-rank gate,
    // while the glass column sits waiting inside.
    //
    // ONE channel does both halves because no morph is needed: the assemble
    // recipe's channel-1 state IS the flat-sheet one, so the teardown simply
    // ENDS where the reassembly resumes — one continuous story. Curl is not a
    // scrub either: the wrap profile derives each shell's curl from its own
    // stick phase.
    const assemble = pulse(p, { rise: ["explode", 0.2, 0.85], fall: RETURN });

    scene.state.zoomTarget = zoom;
    scene.state.focusTarget = focus;
    scene.state.apertureTarget = aperture;
    scene.state.explodeTarget = explode;
    scene.state.assembleTarget = assemble;
    scene.state.storyTarget = p;

    // ink fill: wireframe → HALF fill through zoom (see the internals extend) →
    // FULL ink once zoom is done → drops toward wireframe for the teardown/light-
    // path (glass pops) → back to full ink for the caps-on product shot.
    uInkFill.value =
      0.5 * smoothstep(atFrac(zR, 0.0), atFrac(zR, 0.5), p) +
      0.5 * smoothstep(fR.p0, atFrac(fR, 0.35), p) -
      0.84 * smoothstep(atFrac(exR, 0.1), atFrac(exR, 0.6), p) +
      0.84 * smoothstep(atFrac(rwR, 0.1), atFrac(rwR, 0.8), p); // fills return as layers wrap on

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

    // HUD + scene rail — current scene from the ranges
    let scn = RANGES.length - 1;
    for (let k = 0; k < RANGES.length; k++) {
      if (p < RANGES[k].p1) {
        scn = k;
        break;
      }
    }
    const focal = Math.round(18 + zoom * 32);
    const fstop = F_STOPS[Math.round(aperture * (F_STOPS.length - 1))];
    hud.textContent = `SCN ${String(scn).padStart(2, "0")} / ${STORY[scn].title} · ${focal}MM · f/${fstop} · EXPL ${Math.round(explode * 100)}%`;
    for (const r of rails) r.el?.classList.toggle("is-on", scn === r.i);

    // scroll cue lives only in the hero; the instrument chrome fades at the very end
    scrollCue.style.opacity = String(
      1 - smoothstep(atFrac(heroR, 0.1), atFrac(heroR, 0.9), p),
    );
    const chrome = 1 - smoothstep(CHROME_FADE_P0, capR.p1, p);
    hud.style.opacity = String(chrome);
    sceneRail.style.opacity = String(chrome);

    bgTint(p);
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
