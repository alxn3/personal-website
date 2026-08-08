import * as THREE from "three/webgpu";
import {
  Fn,
  Loop,
  float,
  vec3,
  uniform,
  uniformArray,
  texture,
  positionWorldDirection,
  equirectUV,
  normalize,
  clamp,
} from "three/tsl";
import { tslAlgebra, type TslNode } from "../ops/algebra-tsl";
import {
  traceBegin,
  traceFinish,
  traceSurfaceStep,
  sel,
  AXIAL_ORDER,
  AXIAL_ORDER_REVERSED,
  type Vec3,
  type StepEnv,
} from "./trace";
import { OPTICS_KNOBS } from "./prescription";
import { bakeSky, STREAK_LOOK, type BakedSky } from "./sky";

// ============================================================================
// THE WARP — the TSL consumer that puts the trace on screen. It builds the node
// assigned to `scene.backgroundNode` (which the scene has never used): per
// pixel, reconstruct the camera ray, take it into the gltf frame, run
// optics/trace.ts THREE times (R/G/B with the dispersion offsets), sample the
// baked equirect sky once per channel, and multiply by each channel's `alive`.
//
// THE TRACE IS A LOOP, NOT AN UNROLL — one shader loop over a uniform surface
// table, for every backend, with no unrolled variant left to choose between.
// It used to inline all 21 surfaces per channel, and that shipped broken on
// EVERY Apple platform: three's WGSL builder hoists each shader `var` to module
// scope as `var<private>` (WGSLNodeBuilder.js:327 allowGlobalVariables,
// :1940 the `<private>` qualifier, :2256 the call), and 21 copies of the trace
// body's temporaries blow WebKit-on-Metal's hard 8192-byte private-address-space
// budget — "Render pipeline creation failed … the combined byte size of all
// variables in the private address space exceeds 8192 bytes", i.e. NO SKY at
// all. Chromium never complained, which is why it took the owner's Safari to
// find it. Looping declares the body's temporaries ONCE, so the budget stops
// scaling with the surface count and the fix holds for the GLSL fallback too.
//
// WHY THE BACKGROUND SLOT: three r185 renders a backgroundNode as a unit sphere
// centred on the camera, drawn first with depthTest off and z forced to the far
// plane (src/renderers/common/Background.js:91-133). The lens model therefore
// draws on top of its own warp for free — no post-processing stack, and the
// single `setOverlayPass` slot stays free for the ray-ribbons demo.
//
// `positionWorldDirection` on that sphere IS the per-pixel world ray
// (src/nodes/accessors/Position.js:74 — positionLocal through an identity
// modelWorldMatrix, normalized in the fragment stage).
//
// FRAMES: the prescription is authored in the GLTF frame, in millimetres. The
// two mat3 uniforms and the origin vec3 are refreshed every frame from
// `gltfRoot.matrixWorld`, so the recentring offset (core/scene.ts:527), the
// boot roll and any live `setModelOrientation` are all carried exactly. At boot
// that matrix reduces to gltf (x,y,z) → world (y, −z, −x), i.e. gltf +Y (front)
// is world +X. The scale rides along and the normalize cancels it; the ORIGIN
// goes through the full inverse matrix, which is what converts world units to
// millimetres (1/0.05 = 20 mm per world unit).
//
// SKY FRAME = WORLD FRAME for v1, so the traced direction is taken back to
// world before `equirectUV` reads it.
//
// THE SKY READ crossfades between the plain bake and a SECOND bake whose stars
// are drawn as real streaks toward the throat (optics/sky.ts STREAK_LOOK) —
// `uStreak`. THE PINCH USED TO BE HERE TOO and is GONE: it is now a screen-space
// remap of the finished frame (optics/wormhole-post.ts), because a distortion of
// the sky's sample direction leaves every mesh the lens draws on top of it
// undistorted. `uWormhole` still lives in this file — the dispersion accent
// below rides it, and `__lensOptics` is built here — but nothing in this graph
// bends a direction any more.
//
// MOUNTING IS THE ON/OFF SWITCH, not skyMix. A mounted background node is an
// OPAQUE sphere, so skyMix fades the sky toward black, not toward transparent.
// core/scene.ts only assigns the node while the warp is enabled and restores
// `scene.backgroundNode = null` on disable — which is the state the whole site
// ships in, and the reason the story's CSS stage background is untouched.
// ============================================================================

/** The live physics knobs, as module-level uniform boxes — the same shape
 *  materials/depthfade.ts and ops/host.ts use, so a demo can write them through
 *  the scene-kit's recording `set()` and get auto-restore for free. */
export const uWarpGain = uniform(OPTICS_KNOBS.warpGain);
export const uDispersion = uniform(OPTICS_KNOBS.dispersion);
export const uFocusCouple = uniform(OPTICS_KNOBS.focusCouple);
export const uSkyMix = uniform(OPTICS_KNOBS.skyMix);

/** THE WORMHOLE RAMP, 0..1, BOOTS 0 — how hard the FRAME is pinched toward the
 *  throat. Read by optics/wormhole-post.ts (the screen-space remap that IS the
 *  wormhole) and, here, by the dispersion accent. Lives in this file so the two
 *  readers share one definition and `__lensOptics` keeps driving it. The
 *  fly-through drives it through the scene-kit's recording `set()`, so it
 *  auto-restores to 0 on deselect. */
export const uWormhole = uniform(0);
/** THE STREAK RAMP, 0..1, BOOTS 0 — the CROSSFADE between the plain sky bake
 *  and the STREAKED one (optics/sky.ts `bakeSky({ streaked: true })`), i.e. how
 *  far the stars have drawn themselves out into real lines. */
export const uStreak = uniform(0);

/** The wormhole's SHAPE knobs, as opposed to the two animated ramps above.
 *  Defaults; each is a live uniform below and tunable through `__lensOptics`.
 *  The first two are consumed by optics/wormhole-post.ts — ONE definition, read
 *  from there — and are SCREEN-SPACE quantities now, not sky-direction ones. */
export const WORMHOLE_LOOK = {
  /** how much further out the frame is sampled at the throat when uWormhole = 1:
   *  the screen radius scale there is 1 + this, so the content of a disc 1 + this
   *  times wider is squeezed into the middle of the frame. 0 = no pinch at any
   *  ramp value. TUNED ON THE BENCH at the peak of the dive.
   *
   *  RE-MEASURED FOR SCREEN SPACE, and it went DOWN. In sky space this scaled an
   *  angle off the exit axis through a heavy per-pixel minification, and 3.0 was
   *  what it took to reach the rim of the aperture disc; on the frame itself the
   *  same number folds the barrel walls into a knot. MEASURED AT THREE BEATS,
   *  not one: at 2.6 the mount ring at p = 0.15 goes visibly egg-shaped (a
   *  perfect circle in the old `opt-B-p015.png`), the iris blades at p = 0.30
   *  bow into petals instead of staying straight-edged trapezoids, and the
   *  barrel walls at p = 0.50 draw an hourglass down to the throat. 1.6 does all
   *  three but reads as a lens shot through soft glass rather than as a funnel.
   *  The price of 2.6 is the aperture disc, which the funnel swallows — that is
   *  the effect working, not a defect, but it is the knob to lower if the
   *  starfield beat matters more than the bend.
   *
   *  THE CEILING IS 4.55, not a taste limit but the geometry's: the map
   *  r' = r·(1 + k·(1 − r/R)^p) stays inside the frame only for
   *  k ≤ 1/max_x[x(1−x)^(p−1)], which at profilePow 2.2 is 4.55. Past it the
   *  periphery samples off-frame and clamp-to-edge smears the border. */
  pinchStrength: 2.6,
  /** exponent of the falloff (1 − r/rEdge)^pow: bigger = the pull is confined
   *  harder to the throat and the frame's border stays calmer. Also sets the
   *  stability ceiling on pinchStrength above. */
  profilePow: 2.2,
  /** extra dispersion at the throat: the effective per-channel IOR offset is
   *  `dispersion · (1 + uWormhole · boost)`. 0 = off. NO-OP on the one-channel
   *  path (mobile / WebGL fallback), which never traces R and B at all. */
  wormholeDispersionBoost: 0.5,
};
export const uPinchStrength = uniform(WORMHOLE_LOOK.pinchStrength);
export const uProfilePow = uniform(WORMHOLE_LOOK.profilePow);
export const uWormholeDispersion = uniform(
  WORMHOLE_LOOK.wormholeDispersionBoost,
);

/** BUILD-TIME CEILING, not a uniform: the most channels the shader may trace. 3
 *  is the honest dispersion; 1 collapses R/G/B to the green trace and cuts the
 *  node count (and the pipeline compile) to a third. Flip it to 1 if the first
 *  frame after mounting the warp is slow to appear ON WEBGPU — the fallback
 *  already takes 1 (see `traceChannelsFor`).
 *
 *  Written `3 as 1 | 3` rather than with a type annotation on purpose: an
 *  annotated `const` still gets assignment-narrowed to `3`, which makes the
 *  `=== 1` read below a TS2367 "no overlap" error and defeats the knob. */
export const TRACE_CHANNELS = 3 as 1 | 3;

/** THE WEBKIT BELT-AND-BRACES, disarmed. Before the trace looped, Safari was
 *  the ONE engine that refused the warp outright (the 8 KB private-address-space
 *  budget in the header), and the interim mitigation was to cap it at a single
 *  channel. The loop removes the limit rather than ducking under it, so this
 *  ships at 3 and WebKit gets the same dispersion everyone else does. It stays
 *  as a ONE-TOKEN re-arm: set it to 1 if a WebKit report ever comes back.
 *  `3 as 1 | 3` for the same TS2367 reason as TRACE_CHANNELS. */
export const WEBKIT_CHANNELS = 3 as 1 | 3;

/**
 * Is this WebKit — Safari on macOS, and EVERY browser on iOS (the platform
 * forces the engine, so a "Chrome" there is WebKit too)? The UA string is the
 * only signal: WebKit ships no UA-CH. Chromium and the old Edge both carry
 * `AppleWebKit` in their UA for legacy compatibility, so the token alone is not
 * enough — the Chromium family has to be subtracted back out.
 *
 * SSR-safe via the `typeof` guard, like `isMobileDevice`.
 */
function isWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/**
 * Is this a PHONE-CLASS device? A phone GPU pays for three channels in ALU, not
 * just in shader size: three loops of 21 refractions per pixel over a
 * full-screen background sphere is the most expensive thing on the page, and
 * the dispersion it buys is a fringe a few pixels wide at the aperture edge.
 * So the cap follows the DEVICE, not just the backend.
 *
 * `navigator.userAgentData.mobile` is the exact answer where it exists
 * (Chromium, i.e. most Android phones) and is not spoof-prone the way a UA
 * string sniff is. Safari and Firefox have no UA-CH, so the fallback is a
 * MEDIA-QUERY pair, both halves required:
 *   - `(pointer: coarse)` — the PRIMARY pointer is a finger. A desktop with a
 *     touchscreen still reports `fine` (its mouse is primary), so this alone
 *     does not demote laptops.
 *   - short screen edge < 820 CSS px — phones and small tablets. `screen`, not
 *     the viewport: it is orientation-stable and does not move when the URL bar
 *     collapses or a desktop window is dragged narrow. 820 sits above a
 *     768-px-wide tablet portrait and below a 1024-px iPad landscape short edge.
 *
 * SSR-safe: this module is only ever imported client-side (core/scene.ts
 * `await import`s it), but the `typeof` guards make a Node import inert rather
 * than a throw.
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;
  if (uaData?.mobile === true) return true;
  return (
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches &&
    typeof screen !== "undefined" &&
    Math.min(screen.width, screen.height) < 820
  );
}

/**
 * How many channels THIS renderer traces. THE POLICY, one line per branch:
 *
 * • WEBGL2 FALLBACK → 1, for OLD-GPU PERF, not for shader size. Size stopped
 *   being the argument the moment the trace looped: three's GLSL builder emits
 *   the same `for` the WGSL one does, so the ~239 KB / 4847-line fragment
 *   shader that three unrolled channels used to produce on `/lens?webgl` is now
 *   a few hundred lines whatever the channel count. What remains is that the
 *   fallback is where the oldest drivers land, and a background sphere costing
 *   3 × 21 refractions per pixel is the wrong thing to hand one. Cheap
 *   insurance; costs a fringe.
 *
 * • MOBILE → 1, for ALU PERF (see `isMobileDevice`). Same reasoning, same cost.
 *
 * • WEBKIT DESKTOP → 3, because THE LIMIT IS GONE. Safari was the only engine
 *   that outright refused the warp, and it refused on the 8 KB private-address-
 *   space budget (header), which was a function of the UNROLL and is no longer
 *   a function of anything. Capping it now would be cargo-culting the interim
 *   mitigation; `WEBKIT_CHANNELS` is the re-arm if that judgement is wrong.
 *   (iOS lands in the mobile branch above and takes 1 regardless.)
 *
 * • EVERYTHING ELSE → 3.
 *
 * `renderer.backend` is three's live backend object; `isWebGLBackend` is the
 * fallback's own flag (WebGLBackend.js:57, mirroring WebGPUBackend.js:88).
 * Reached through a cast because the backend is untyped on the renderer.
 */
export function traceChannelsFor(renderer: THREE.WebGPURenderer): 1 | 3 {
  const backend = (
    renderer as unknown as { backend?: { isWebGLBackend?: true } }
  ).backend;
  return TRACE_CHANNELS === 1 ||
    backend?.isWebGLBackend === true ||
    isMobileDevice() ||
    (WEBKIT_CHANNELS === 1 && isWebKit())
    ? 1
    : 3;
}

export interface LensWarp {
  /** assign to `scene.backgroundNode` */
  node: unknown;
  /** push this frame's channel values and camera/model frames into the uniforms */
  sync(
    focus: number,
    aperture: number,
    camera: THREE.Camera,
    gltfRoot: THREE.Object3D,
  ): void;
  /** re-bake the sky in the other palette */
  setTheme(light: boolean): void;
  dispose(): void;
}

export interface LensWarpOptions {
  /** Build the graph for a ray running REAR→FRONT (gltf +Y, world −X → +X) —
   *  the fly-through's sensor-to-sky dive — instead of the light path's
   *  front→rear. */
  reverse?: boolean;
}

export function createLensWarp(
  renderer: THREE.WebGPURenderer,
  light: boolean,
  invalidate: () => void,
  { reverse = false }: LensWarpOptions = {},
): LensWarp {
  const A = tslAlgebra();
  // Fixed for the life of this warp: the graph is built once, and the backend
  // cannot change under a live renderer (three picks its fallback before
  // `init()` resolves, and core/scene.ts hands the handle out after that).
  const channels = traceChannelsFor(renderer);
  // Which way the ray runs. Now a TABLE FILL rather than a build-time unroll,
  // but still fixed for the life of the warp: flipping it needs a fresh warp
  // (core/scene.ts enableLensWarp disposes and rebuilds), never a knob write.
  const order = reverse ? AXIAL_ORDER_REVERSED : AXIAL_ORDER;
  // A STATIC INT, and it must be: `Loop` needs a compile-time trip count, and
  // the two orders are the same 21 surfaces either way.
  const N_SURFACES = order.length;

  // CALLER CONTRACT: `bakeSky` renders immediately, so this must run after
  // `await renderer.init()` (sky.ts's header — a pre-init bake is silently
  // blank). core/scene.ts only hands out the handle that reaches
  // `enableLensWarp` after that await, so the ordering holds by construction.
  let sky: BakedSky = bakeSky(renderer, light);
  // THE SECOND SKY: the same starfield with a real line streak drawn behind
  // every star, running toward the throat (optics/sky.ts STREAK_LOOK). uStreak
  // crossfades between the two, which is what makes the smear GEOMETRY instead
  // of a fan of re-reads.
  //
  // THE COST IS TWO 2048×1024 TARGETS, ~8 MB each as RGBA8, for the life of a
  // mounted warp — and the warp is only mounted by the fly-through. It buys
  // back eight of the nine equirect reads per channel per pixel the tap fan
  // used to run (3 × 9 → 3 × 2 desktop, 9 → 2 on the one-channel path), so the
  // trade is bandwidth-for-memory in the direction the GPU prefers.
  let skyStreak: BakedSky = bakeSky(renderer, light, { streaked: true });
  // ONE texture node each, re-sampled per channel through `.sample(uv)`: that
  // reuses the same binding instead of declaring three texture uniforms
  // (three r185 src/nodes/accessors/TextureNode.js:678).
  const skyTex = texture(sky.target.texture);
  const skyStreakTex = texture(skyStreak.target.texture);

  // Per-frame frames. mat3 uniforms are given an explicit type so the builder
  // never has to infer one from a THREE.Matrix3.
  const uOriginMm = uniform(new THREE.Vector3());
  const uWorldToGltf = uniform(new THREE.Matrix3(), "mat3");
  const uGltfToWorld = uniform(new THREE.Matrix3(), "mat3");
  const uFocus = uniform(0);
  const uAperture = uniform(0);

  // THE SURFACE TABLE, as two uniform vec4 arrays — the thing the loop indexes.
  //
  // TWO ARRAYS, NOT A PACKED BITFIELD. Three binary flags would fit in one
  // float as focusRide·4 + enter·2 + stop, but unpacking them costs a
  // floor/mod chain per surface per pixel that has to come out EXACTLY 0 or 1
  // (optics/trace.ts `sel` is only exact for binary flags), and the saving is
  // 336 bytes of uniform buffer — a resource nothing here is short of. Two
  // arrays read as what they are.
  //
  // FILLED ONCE, NEVER UPDATED. Every value is static per mount: curvature,
  // vertex, semi-diameter and index are geometry, and the two LIVE quantities
  // stay the separate uniforms they already were — the focus slide arrives as
  // `StepEnv.rideMm` gated by the per-surface `focusRide`, and the iris clear
  // radius is mixed in per pixel by the `sel` on the stop flag below.
  const uSurfGeom = uniformArray(
    order.map((s) => new THREE.Vector4(s.c, s.yMm, s.apertureMm, s.ior)),
    "vec4",
  );
  const uSurfFlags = uniformArray(
    order.map((s) => new THREE.Vector4(s.focusRide, s.enter, s.stop, 0)),
    "vec4",
  );

  const v3 = (n: TslNode): Vec3<TslNode> => ({ x: n.x, y: n.y, z: n.z });
  const knobs = { warpGain: uWarpGain, focusCouple: uFocusCouple };

  /**
   * READ THE SKY in `dirWorld`, crossfading the plain bake against the streaked
   * one. THE PINCH IS NO LONGER HERE — it moved to optics/wormhole-post.ts, and
   * the reason is the owner's: a distortion applied to the sky's SAMPLE
   * DIRECTION can only ever distort the sky. The lens model draws on top of its
   * own background node, so every mesh stayed geometrically pristine while the
   * stars streamed behind it — "the internals of the lens suffer no
   * distortion". The screen pass warps the finished frame instead, so the
   * barrel, the blades, the glass AND these stars bend into the same funnel,
   * and there is exactly ONE distortion in the picture rather than two fighting
   * each other. `uWormhole` still lives in this file because the dispersion
   * accent below rides it, and because `__lensOptics` is built here.
   *
   * THE STREAK IS A CROSSFADE, AND IT USED TO BE A NINE-TAP FAN. The old form
   * read the sky nine times along the pinch and averaged them, which is
   * motion blur by point sampling — and nine points at any useful length is
   * UNDERSAMPLED, so a trail came out as a row of separate copies of the star.
   * The owner named it exactly: "we're just duplicating the stars to simulate a
   * streak". The streak is now DRAWN, as real line geometry, into a second bake
   * (optics/sky.ts `bakeSky({ streaked: true })`), and this function reads both
   * textures at the ONE traced direction and mixes:
   *
   *     C = C_plain + (C_streaked − C_plain) · uStreak
   *
   * Two reads per channel where there were nine, no tap spacing left to bead,
   * and a real along-length gradient the shader could not have produced. The
   * mix is written as that fold rather than as `mix()` for the file's usual
   * reason — uStreak = 0 makes the added term exactly 0 and `x + 0 = x` is
   * exact, so the plain sky comes back BIT-IDENTICAL when the ramp is at rest.
   * (Here that is consistency rather than necessity: the blend is a look, not
   * an identity anything downstream is pinned to.)
   *
   * THE STREAKS ARE CONTENT, NOT DISTORTION, which is why they stayed sky-side
   * while the pinch left. They are baked geometry running toward the throat
   * (world +X), and the screen pass warps them along with everything else —
   * which is right: they bend INTO the funnel instead of being a flat overlay
   * on top of it.
   */
  const skyLook = (dirWorld: TslNode): TslNode => {
    // ONE uv, both bakes: the two textures are the same sky drawn twice, so a
    // second `equirectUV` would only recompute the same numbers.
    const uv: TslNode = equirectUV(dirWorld).toVar();
    const plain: TslNode = (skyTex as TslNode).sample(uv).toVar();
    const streaked: TslNode = (skyStreakTex as TslNode).sample(uv);
    // The fold, not `mix`: exact at uStreak = 0 (see the header).
    return plain.add(streaked.sub(plain).mul(clamp(uStreak, 0, 1)));
  };

  /** One dispersion channel: trace, then read the sky in the traced direction. */
  const channel = (iorShift: TslNode) => {
    // `normalize`'s overload set resolves an `any` argument to its vec2 form,
    // so both normalized directions are held at the shader-graph escape hatch
    // (ops/algebra-tsl.ts's `TslNode`) rather than at a wrong static type.
    const dirGltf: TslNode = normalize(
      (uWorldToGltf as TslNode).mul(positionWorldDirection),
    );
    const start = traceBegin(
      A,
      v3(uOriginMm),
      v3(dirGltf),
      uFocus,
      uAperture,
      knobs,
    );

    // The ray state, as shader variables the loop body assigns into. These five
    // — plus whatever `traceSurfaceStep` declares once inside the body — are now
    // the WHOLE private-address-space cost of the trace, where the unroll paid
    // for them 21 times over.
    const p = vec3(start.state.p.x, start.state.p.y, start.state.p.z).toVar();
    const d = vec3(start.state.d.x, start.state.d.y, start.state.d.z).toVar();
    const alive = float(start.state.alive).toVar();
    const notYet = float(start.state.notYet).toVar();
    const missFirst = float(start.state.missFirst).toVar();
    // Everything that crosses INTO the loop is a var too: a plain expression
    // node first used inside a loop body gets emitted into that body's scope,
    // and these are read on every iteration.
    const clearMm: TslNode = float(start.clearMm).toVar();
    const env: StepEnv<TslNode> = {
      iorShift: float(iorShift).toVar(),
      rideMm: float(start.rideMm).toVar(),
    };

    Loop(N_SURFACES, ({ i }) => {
      const g: TslNode = (uSurfGeom as TslNode).element(i);
      const f: TslNode = (uSurfFlags as TslNode).element(i);
      const stop: TslNode = f.z;
      const next = traceSurfaceStep(
        A,
        { p: v3(p), d: v3(d), alive, notYet, missFirst },
        {
          c: g.x,
          yMm: g.y,
          // the caller's half of the stop's aperture — see StepSurface
          apMm: sel(A, stop, g.z, clearMm),
          focusRide: f.x,
          enter: f.y,
          stop,
          ior: g.w,
        },
        env,
      );
      // MATERIALIZE ALL FIVE, THEN WRITE BACK. Every output of the step is a
      // function of the INCOMING p/d/notYet, so writing them back one at a time
      // is a read-after-write hazard: TSL inlines an expression at its point of
      // use, so `p.assign(…)` followed by `d.assign(…)` can emit a `d` that
      // re-reads the p it just overwrote — the direction then refracts off a
      // normal computed at the wrong hit point. (Seen, not theorised: it
      // shrank the sky disc through the iris at fly-through p = 0.35.)
      // Forcing each result into its own var first pins the whole step to the
      // old state before any of it lands.
      const np = vec3(next.p.x, next.p.y, next.p.z).toVar();
      const nd = vec3(next.d.x, next.d.y, next.d.z).toVar();
      const nAlive = float(next.alive).toVar();
      const nNotYet = float(next.notYet).toVar();
      const nMissFirst = float(next.missFirst).toVar();
      p.assign(np);
      d.assign(nd);
      alive.assign(nAlive);
      notYet.assign(nNotYet);
      missFirst.assign(nMissFirst);
    });

    const out = traceFinish(
      A,
      start.dirIn,
      { p: v3(p), d: v3(d), alive, notYet, missFirst },
      knobs,
    );
    // A VAR: `equirectUV` reads it component-wise, and an inlined expression
    // would rebuild the mat3 multiply and the normalize each time.
    const dirWorld: TslNode = normalize(
      (uGltfToWorld as TslNode).mul(vec3(out.dir.x, out.dir.y, out.dir.z)),
    ).toVar();
    return {
      rgb: skyLook(dirWorld),
      alive: out.alive,
    };
  };

  // Wrapped in Fn() so the whole graph is one shader function rather than the
  // channels inlined at the call site, and so `.toVar()` and `Loop` above have
  // a builder stack to push onto.
  const node = Fn(() => {
    const g = channel(float(0));
    if (channels === 1)
      return vec3(g.rgb.r, g.rgb.g, g.rgb.b).mul(g.alive).mul(uSkyMix);
    // THE THROAT FRINGES. The wormhole ramp widens the R/B IOR split, so the
    // streaming stars pick up chromatic edges as the pinch opens and lose them
    // again as it closes. `1 + 0·boost` is exactly 1, so a boost of 0 — and
    // every frame outside the dive — leaves the shipped dispersion untouched.
    const disp: TslNode = uDispersion.mul(
      float(1).add(uWormhole.mul(uWormholeDispersion)),
    );
    const r = channel(disp.negate());
    const b = channel(disp);
    // Per-channel `alive`: a ray clipped by the iris in red but not in blue is
    // exactly the coloured fringe at the aperture edge the dispersion knob is for.
    return vec3(
      r.rgb.r.mul(r.alive),
      g.rgb.g.mul(g.alive),
      b.rgb.b.mul(b.alive),
    ).mul(uSkyMix);
  })();

  const m4 = new THREE.Matrix4();

  function sync(
    focus: number,
    aperture: number,
    camera: THREE.Camera,
    gltfRoot: THREE.Object3D,
  ) {
    uFocus.value = focus;
    uAperture.value = aperture;
    gltfRoot.updateWorldMatrix(true, false);
    m4.copy(gltfRoot.matrixWorld).invert();
    // camera position → gltf-frame MILLIMETRES (the full inverse carries the
    // recentre offset and the 1/MODEL_SCALE = 20 mm-per-unit factor)
    uOriginMm.value.copy(camera.position).applyMatrix4(m4);
    // directions: rotation (× uniform scale, which the normalize cancels)
    uWorldToGltf.value.setFromMatrix4(m4);
    uGltfToWorld.value.setFromMatrix4(gltfRoot.matrixWorld);
  }

  /** Re-point a texture node at a fresh bake and free the old target. Every
   *  `.sample()` clone reads through `referenceNode` back to the node itself
   *  (TextureNode.js:682/774), and the binding re-uploads the moment
   *  `textureNode.value` differs (NodeSampledTexture.js:54-66). */
  function reseat(node: unknown, old: BakedSky, next: BakedSky): BakedSky {
    (node as { value: THREE.Texture }).value = next.target.texture;
    old.dispose();
    return next;
  }

  /** which palette the two targets currently hold — the dev re-bake below needs
   *  it to reproduce the streaked target without flipping the theme. */
  let themeLight = light;

  function setTheme(l: boolean) {
    themeLight = l;
    // BOTH bakes, or the crossfade would mix two palettes.
    sky = reseat(skyTex, sky, bakeSky(renderer, l));
    skyStreak = reseat(
      skyStreakTex,
      skyStreak,
      bakeSky(renderer, l, { streaked: true }),
    );
    invalidate();
  }

  // DEV console handle, in the `window.__lensPaths` / `window.__lensOps` mould:
  // every physics knob live-tunable without a reload.
  if (import.meta.env.DEV) {
    // ONE ROW PER KNOB — the uniform box and the value it boots at. The whole
    // handle is generated from this table, so a new knob is a new row.
    const KNOBS: Record<string, { u: { value: number }; boot: number }> = {
      warpGain: { u: uWarpGain, boot: OPTICS_KNOBS.warpGain },
      dispersion: { u: uDispersion, boot: OPTICS_KNOBS.dispersion },
      focusCouple: { u: uFocusCouple, boot: OPTICS_KNOBS.focusCouple },
      skyMix: { u: uSkyMix, boot: OPTICS_KNOBS.skyMix },
      // the two ramps the fly-through animates; both boot and restore at 0
      wormhole: { u: uWormhole, boot: 0 },
      streak: { u: uStreak, boot: 0 },
      // the wormhole's shape
      pinchStrength: { u: uPinchStrength, boot: WORMHOLE_LOOK.pinchStrength },
      profilePow: { u: uProfilePow, boot: WORMHOLE_LOOK.profilePow },
      wormholeDispersionBoost: {
        u: uWormholeDispersion,
        boot: WORMHOLE_LOOK.wormholeDispersionBoost,
      },
    };
    const read = () =>
      Object.fromEntries(Object.entries(KNOBS).map(([k, v]) => [k, v.u.value]));
    const handle = {
      /** e.g. `__lensOptics.set({ wormhole: 1, pinchStrength: 1.2 })` */
      set(k: Record<string, number>) {
        for (const [name, v] of Object.entries(k))
          if (KNOBS[name] !== undefined) KNOBS[name].u.value = v;
        invalidate();
        return read();
      },
      /** back to the shipped defaults — including both ramps to 0 */
      reset() {
        for (const { u, boot } of Object.values(KNOBS)) u.value = boot;
        invalidate();
      },
      /** THE STREAK'S SHAPE IS BAKED, not a uniform — the streaks are drawn
       *  geometry (optics/sky.ts STREAK_LOOK), so tuning them means re-drawing
       *  the texture. Mutate `__lensOptics.streakLook` and call this:
       *      `__lensOptics.streakLook.lenRad = 0.8; __lensOptics.restreak()`
       *  Re-bakes ONLY the streaked target; the plain sky is untouched. */
      streakLook: STREAK_LOOK,
      restreak() {
        skyStreak = reseat(
          skyStreakTex,
          skyStreak,
          bakeSky(renderer, themeLight, { streaked: true }),
        );
        invalidate();
        return { ...STREAK_LOOK };
      },
    };
    // `__lensOptics.warpGain` still reads live, as it always did.
    for (const name of Object.keys(KNOBS))
      Object.defineProperty(handle, name, {
        enumerable: true,
        get: () => KNOBS[name].u.value,
      });
    (window as unknown as Record<string, unknown>).__lensOptics = handle;
  }

  return {
    node,
    sync,
    setTheme,
    dispose() {
      sky.dispose();
      skyStreak.dispose();
      if (import.meta.env.DEV)
        delete (window as unknown as Record<string, unknown>).__lensOptics;
    },
  };
}
