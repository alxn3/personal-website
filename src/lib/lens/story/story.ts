// ============================================================================
// SINGLE SOURCE OF TRUTH for the scroll-jacked lens story.
//
// Every scene is one entry below: its DURATION (in ≈screenfuls of scroll), its
// camera pose, which mechanism it drives, its background tint, and its caption.
// Everything downstream — the track height, each scene's normalized scroll range
// `p`, the camera path, mechanism curves, caption bands, background stops and the
// HUD — is DERIVED from this array. So adding, removing, or reordering a scene is
// a single edit here; pacing stays constant automatically (the track grows with
// the total duration) and nothing can drift out of sync.
//
// SCOPE — this table owns story STRUCTURE: beat order, durations and derived
// ranges, track height, camera poses/waypoints, stage tints, rail flags and
// titles. It deliberately does NOT own mechanism envelope tuning (the `pulse`
// windows in hero-driver.ts), cinematic implementation (cinematics.ts),
// authored overlay content (LensStory.astro), or content-specific visual
// effects (CSS reading the --beat-* vars) — those live with their consumers on
// purpose; don't try to consolidate them into this schema.
// ============================================================================

import { smoothstep } from "../core/math";

/** The subset of a Pose that a `via` waypoint actually contributes: camera.ts
 *  splines only these four along a waypoint chain. `ortho`, `ys` and `target`
 *  are endpoint-only — the flatten and the orbit-centre/lift slides are driven
 *  from the move's first and last poses, so authoring them on a via is silently
 *  dead. Hence the narrower type rather than `Pose[]`. */
export type Waypoint = Pick<Pose, "pos" | "fov" | "up" | "xs">;

export interface Pose {
  pos: [number, number, number]; // camera direction (scaled by the scene radius)
  fov: number;
  up: [number, number, number];
  ortho: number; // 1 = flatten to an orthographic elevation on the HOLD; 0 = perspective
  xs: number; // horizontal lens-park: >0 shoves the lens left (caption sits right)
  ys?: number; // vertical look-shift (along camera-up): reframes on a detail, e.g.
  // the focus scene dollying onto the focusing element instead of the whole lens
  target?: [number, number, number]; // orbit centre / look-at, WORLD units (the
  // recentred lens centre is the origin; optical axis = world X, front at +X).
  // Default [0,0,0]. Shifts the whole orbit sphere, so framing and transit arcs
  // are preserved — use it to aim a scene at a feature (a cap, the mount) instead
  // of the lens centre. Unlike ys (a 2D reframe), this changes the 3D pivot.
}

// NOTE: scene CONTENT does not live here. This table is the ENGINE — durations,
// camera, mechanism, tint. The overlay content is authored as real markup in
// components/LensStory.astro via <LensSceneContent scene="…">…
// </LensSceneContent> (any HTML/components), keyed to a scene id; the scroll
// driver derives each block's fade band from the ranges below. (An earlier
// design kept preset caption strings in this table — replaced so scenes can
// host arbitrary components.)
export interface StoryScene {
  id: string;
  title: string; // display name — the HUD readout ("SCN 05 / LIGHT PATH") and the rail label
  rail?: boolean; // show this scene on the scene rail (bottom-right progress dots)
  hold: number; // duration weight, ≈ screenfuls of scroll
  transit: number; // 0..1 of the scene spent easing the camera IN from the previous pose
  cam: Pose; // settle pose (the parked "hold")
  via?: Waypoint[]; // optional waypoints during the transit (multi-step orbits / up-vector routing)
  bg: [number, number, number]; // stage tint on the hold (dark theme)
  bgLight: [number, number, number]; // stage tint on the hold (light theme — warm paper family)
  linkNext?: boolean; // fuse this scene's camera move with the NEXT scene's into ONE
  // spline + ONE ease (start of this scene → end of the next's transit). Without it
  // every boundary is a dead stop: an eased transit decelerates to zero velocity,
  // parks, and the next re-accelerates from zero — a visible hitch when the story
  // wants one continuous move (rewrap → capsOn). This scene's own `transit` is
  // ignored for the camera when set (mechanism/caption ranges are unaffected).
}

// --- the story --------------------------------------------------------------
export const STORY: StoryScene[] = [
  {
    id: "hero",
    title: "HERO",
    hold: 0.9,
    transit: 0,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [1.3, 0, 0], fov: 30, up: [0, 1, 0], ortho: 1, xs: -0.34 }, // dead-front elevation, lens right
  },
  {
    id: "zoom",
    title: "ZOOM",
    rail: true,
    hold: 1.35,
    transit: 0.5,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [0, 0, 1.3], fov: 32, up: [0, 1, 0], ortho: 1, xs: -0.24 }, // side profile (horizontal)
  },
  {
    id: "focus",
    title: "FOCUS",
    rail: true,
    hold: 1.15,
    transit: 0.5,
    bg: [30, 35, 24],
    bgLight: [238, 242, 229],
    // Side elevation, lens VERTICAL (rolls up in place) — dollied IN (0.95 < 1.3)
    // and the look-target dropped toward the mount (ys) so the hold frames the
    // focusing element / lead screw region, not the whole lens.
    // xs is smaller than the other parked scenes because the dolly-in magnifies
    // the park shift in screen terms — 0.34 here would shove the lens half off-frame.
    cam: {
      pos: [0, 0, 0.95],
      fov: 32,
      up: [1, 0, 0],
      ortho: 1,
      xs: 0.2,
      ys: -0.09,
    },
  },
  {
    id: "aperture",
    title: "APERTURE",
    rail: true,
    hold: 1.15,
    transit: 0.5,
    bg: [36, 31, 21],
    bgLight: [245, 239, 225],
    cam: { pos: [-1.3, 0, 0], fov: 30, up: [0, 1, 0], ortho: 1, xs: 0 }, // rear elevation
  },
  {
    id: "explode",
    title: "EXPLODE",
    rail: true,
    hold: 1.5,
    transit: 0.6,
    bg: [18, 16, 11],
    bgLight: [231, 227, 215],
    // rolls DOWN out of the rear, structure fans radially off-frame; the up-vector
    // routes through +Y (never antipodal to the rear's up) via the waypoints.
    cam: { pos: [0, 0, -1.25], fov: 25, up: [-1, 0, 0], ortho: 0, xs: 0 }, // pure-side, pointing down, zoomed on the glass
    via: [
      {
        pos: [-1.2, 0.35, -0.7],
        fov: 34,
        up: [-0.3, 0.95, 0],
        xs: 0,
      },
      {
        pos: [-0.7, 0.18, -1.15],
        fov: 30,
        up: [-0.9, 0.2, 0],
        xs: 0,
      },
    ],
  },
  {
    id: "lightPath",
    title: "LIGHT PATH",
    hold: 0.9,
    transit: 0,
    bg: [18, 16, 11],
    bgLight: [231, 227, 215],
    cam: { pos: [0, 0, -1.25], fov: 25, up: [-1, 0, 0], ortho: 0, xs: 0 }, // holds the explode pose
  },
  {
    id: "rewrap",
    title: "REWRAP",
    hold: 1.4,
    transit: 0.95, // camera-ignored while linkNext (one chain with capsOn) — kept for caption pacing
    linkNext: true, // ONE continuous camera move across the 06→07 boundary (no boundary stop)
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // The camera sweeps half-around the lens and ROLLS IT UPRIGHT as the layers
    // wrap on. Because of linkNext this pose is just an interior waypoint of the
    // fused rewrap→capsOn spline — the lens is mid-SPIN here (the chain keeps
    // orbiting around the lens' long axis into capsOn without pausing). The
    // up-vector routes through +Y (down → up is antipodal; a direct lerp would
    // collapse to zero).
    cam: {
      pos: [0.1, -0.2, 1.26],
      fov: 30,
      up: [0.9, -0.32, 0],
      ortho: 0,
      xs: 0,
    },
    via: [
      {
        pos: [-1.1, 0.35, -0.7],
        fov: 30,
        up: [-0.55, 0.8, 0],
        xs: 0,
      },
      { pos: [-1.3, 0.5, 0.35], fov: 30, up: [0.4, 0.9, 0], xs: 0 },
      { pos: [-0.6, 0.3, 1.1], fov: 30, up: [1, 0.15, 0], xs: 0 },
    ],
  },
  {
    id: "capsOn",
    title: "CAPS ON",
    hold: 1.5,
    transit: 0.7, // still perceptibly rotating while the cap seats — fluid, not parked
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // SPINNING-CYLINDER SETTLE (tail of the fused rewrap→capsOn chain): the lens
    // stands vertical and the camera orbits ~one full revolution around its long
    // axis. On screen that reads as the cylinder SPINNING in place; the up-vector
    // wobble decays like a spun top righting itself (±0.32 → ±0.22 → ±0.12 →
    // ±0.06 → 0) until it settles on its base. The fast first half of the spin
    // orbits WIDE (r ≈ 1.5): unwrapped shells are sheets up to ~11 world units
    // long and the last outer ones are still reeling home — an equatorial pass at
    // the parked radius flies straight through them (giant panels filling the
    // frame). The BACK half climbs to x 0.45 → 0.28 → 0: the lens TILTS toward
    // the camera (~20° elevation, never face-on) so the FRONT ELEMENT is visible
    // exactly while the cap flies in to meet it, then straightens for the settle.
    // The dolly-in swell is the last waypoint (r ≈ 1.11), once every layer has
    // seated; the cap seats during that final slow quarter-turn. fov is FLAT (30)
    // across the spin — the spline follows per-via fov, so alternating values
    // read as a zoom pump. The settle pose is CENTRED (xs 0, and 0 on every via —
    // any via xs would slide the lens out and back) and FLATTENS to the ortho
    // elevation on the hold: the capped, upright, dead-centre lens is the
    // hand-off frame the rest of the page scrolls up over.
    cam: { pos: [0, 0, 2.0], fov: 30, up: [1, 0, 0], ortho: 1, xs: 0 }, // final: centred ortho elevation — page hand-off
    via: [
      {
        pos: [0.11, -1.3, -0.75],
        fov: 30,
        up: [0.94, 0.22, 0],
        xs: 0,
      }, // wide, fast spin
      {
        pos: [0.45, 1.1, -0.62],
        fov: 30,
        up: [0.97, -0.12, 0],
        xs: 0,
      }, // tilts to camera — front element
      {
        pos: [0.28, 0.76, 0.76],
        fov: 30,
        up: [0.99, 0.06, 0],
        xs: 0,
      }, // swell — cap meets the front
    ],
  },
];

// --- authoring validation ----------------------------------------------------
// Real invariants of the table, checked once at module load so a bad edit fails
// loudly at boot instead of surfacing as subtly wrong motion. (Pulse-window
// fractions are NOT checked here — they don't live in this table; pulse()
// validates its own windows at call time.)

// Scene ids consumers resolve BY NAME: camera.ts's hero-end portrait lift, the
// hero-driver's pulse windows and return window, and cinematics.ts's isolate /
// caps-on constants. The cinematics ones are MODULE-SCOPE behind a static
// import, so a renamed id takes down /lens too — a page with no story at all.
const REQUIRED_IDS = [
  "hero",
  "zoom",
  "focus",
  "aperture",
  "explode",
  "lightPath",
  "rewrap",
  "capsOn",
];

export function validateStory(story: StoryScene[]): void {
  if (story.length === 0) throw new Error("lens story: STORY is empty");
  const ids = new Set<string>();
  for (let i = 0; i < story.length; i++) {
    const sc = story[i];
    if (ids.has(sc.id))
      throw new Error(`lens story: duplicate scene id "${sc.id}"`);
    ids.add(sc.id);
    if (!Number.isFinite(sc.hold) || sc.hold <= 0)
      throw new Error(
        `lens story: scene "${sc.id}" hold must be finite and > 0 (got ${sc.hold})`,
      );
    if (!Number.isFinite(sc.transit) || sc.transit < 0 || sc.transit > 1)
      throw new Error(
        `lens story: scene "${sc.id}" transit must be within [0,1] (got ${sc.transit})`,
      );
    if (sc.linkNext && i === story.length - 1)
      throw new Error(
        `lens story: final scene "${sc.id}" must not set linkNext — there is no next scene to fuse with`,
      );
    // camera.ts resolves a fused chain's head by looking back exactly ONE scene
    // (sampleStory's `head` resolution), so a chain can only span two scenes —
    // a second consecutive linkNext would silently never fuse.
    if (sc.linkNext && story[i + 1]?.linkNext)
      throw new Error(
        `lens story: scenes "${sc.id}" and "${story[i + 1].id}" are consecutive linkNext scenes — camera.ts only looks back one scene, so chains longer than two never fuse`,
      );
  }
  const missing = REQUIRED_IDS.filter((id) => !ids.has(id));
  if (missing.length)
    throw new Error(
      `lens story: missing required scene id(s) ${missing.map((id) => `"${id}"`).join(", ")} — consumers resolve these by name (see REQUIRED_IDS); rename the scene there too, or keep the id`,
    );
  // hero-driver.ts takes RANGES[0] positionally for the intro/scroll-cue fades,
  // so a prepended beat would silently retarget them instead of failing.
  if (story[0].id !== "hero")
    throw new Error(
      `lens story: the first scene must be "hero" (got "${story[0].id}") — hero-driver.ts reads RANGES[0] positionally`,
    );
}
validateStory(STORY);

// --- derived pacing ---------------------------------------------------------
// Track length is the total duration in screenfuls → dvh, CLAMPED so a short
// viewport isn't rushed and a huge one isn't a marathon (raw scroll input is
// pixel-based, so pure vh drifts across screen sizes). dvh (not vh) matches the
// pinned 100dvh stage, avoiding a jump at the end on mobile.
export const TOTAL_HOLD = STORY.reduce((s, sc) => s + sc.hold, 0);
const PER_SCREENFUL_MIN_PX = 460;
const PER_SCREENFUL_MAX_PX = 1000;
export const TRACK_MIN_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MIN_PX);
export const TRACK_MAX_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MAX_PX);
export const TRACK_DVH = Math.round(TOTAL_HOLD * 100);
export const TRACK_HEIGHT_CSS = `clamp(${TRACK_MIN_PX}px, ${TRACK_DVH}dvh, ${TRACK_MAX_PX}px)`;

export interface SceneRange {
  scene: StoryScene;
  p0: number;
  p1: number;
}

/** Each scene's normalized scroll range [p0, p1), cumulative over the durations. */
export const RANGES: SceneRange[] = (() => {
  const out: SceneRange[] = [];
  let acc = 0;
  for (const scene of STORY) {
    const p0 = acc / TOTAL_HOLD;
    acc += scene.hold;
    out.push({ scene, p0, p1: acc / TOTAL_HOLD });
  }
  return out;
})();

export const rangeOf = (id: string): SceneRange => {
  const r = RANGES.find((r) => r.scene.id === id);
  if (!r) throw new Error(`Unknown lens story scene: "${id}"`);
  return r;
};

/** Absolute p at fraction `f` through a scene's range. */
export const atFrac = (r: SceneRange, f: number): number => {
  if (!Number.isFinite(f) || f < 0 || f > 1)
    throw new Error(
      `lens story: fraction ${f} through scene "${r.scene.id}" is outside [0,1]`,
    );
  return r.p0 + (r.p1 - r.p0) * f;
};

/** A point on the story timeline: fraction `f` through the named scene. */
export type StoryPoint = [id: string, f: number];
/** A smoothstep window: both edges in ONE scene (`[id, f0, f1]`), or each edge
 *  in its OWN scene (`[[idA, f0], [idB, f1]]` — e.g. a scrub that runs from one
 *  scene into the next). */
export type StoryWindow =
  [id: string, f0: number, f1: number] | [StoryPoint, StoryPoint];

const edges = (w: StoryWindow): [number, number] => {
  if (typeof w[0] === "string") {
    const [id, f0, f1] = w as [string, number, number];
    const r = rangeOf(id);
    return [atFrac(r, f0), atFrac(r, f1)];
  }
  const [a, b] = w as [StoryPoint, StoryPoint];
  return [atFrac(rangeOf(a[0]), a[1]), atFrac(rangeOf(b[0]), b[1])];
};

/** Mechanism envelope: smoothstep RISE over one window × optional smoothstep
 *  FALL over another (omit `fall` for a one-way ramp). Windows name their
 *  scenes — see StoryWindow for the two edge forms. */
export const pulse = (
  p: number,
  w: { rise: StoryWindow; fall?: StoryWindow },
): number => {
  const [r0, r1] = edges(w.rise);
  if (r0 >= r1)
    throw new Error(
      `lens story: pulse rise window ${JSON.stringify(w.rise)} resolves reversed or zero-width (p0 ${r0} >= p1 ${r1})`,
    );
  const rise = smoothstep(r0, r1, p);
  if (!w.fall) return rise;
  const [f0, f1] = edges(w.fall);
  if (f0 >= f1)
    throw new Error(
      `lens story: pulse fall window ${JSON.stringify(w.fall)} resolves reversed or zero-width (p0 ${f0} >= p1 ${f1})`,
    );
  return rise * (1 - smoothstep(f0, f1, p));
};
