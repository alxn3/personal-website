// The `constellations` scene: lines drawn star to star on the sky, fading as the
// next one starts, plus star names and a quote.
//
// Lazy module: it imports optics/ (three/tsl), so only hero-driver's dynamic
// import() may reach it, and index.ts must never re-export it.
//
// Animation runs on accumulated frame dt (the hero pauses off-screen), gated on
// story p. The ink rides the starfield group, which fly.ts mounts and unmounts.

import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrix,
  modelViewMatrix,
  positionGeometry,
  texture,
  uniform,
  vec4,
} from "three/tsl";
import type { SceneHandle } from "../core/scene";
import { lcg, smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { LABEL_TYPE } from "./peelcards";
import { isLightTheme, watchTheme } from "../core/theme";
import {
  SKY,
  SKY_INK,
  BRIGHT_COUNT,
  dirOf,
  type SkyPalette,
} from "../optics/sky";
import { STARFIELD_LOOK, starRho } from "../optics/starfield";
import {
  CONST_LINES_LOOK,
  createConstellationLines,
  lineDrawMs,
  type Dir3,
} from "../optics/constellation-lines";

const coR = rangeOf("constellations");
const tR = rangeOf("trails");

/** Story-p span the ink stays attached over: the sky chapter plus a small pad
 *  so scrubbing at an edge doesn't thrash attach/detach. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = coR.p0 - SPAN_PAD;
export const SPAN_P1 = tR.p1 + SPAN_PAD;

/** Opacity of the lines: in early in `constellations`, out early in `trails`. */
export const constellationEnvAt = (p: number): number =>
  smoothstep(atFrac(coR, 0.05), atFrac(coR, 0.2), p) *
  (1 - smoothstep(tR.p0, atFrac(tR, 0.25), p));

/** Opacity of the quote: in later than the lines, out at the end of `trails`. */
export const quoteEnvAt = (p: number): number =>
  smoothstep(atFrac(coR, 0.35), atFrac(coR, 0.55), p) *
  (1 - smoothstep(atFrac(tR, 0.85), tR.p1, p));

/** Opacity of the star names: the same as the lines. */
export const labelEnvAt = constellationEnvAt;

// ── Picking which stars to join ─────────────────────────────────────────────

/** Half-angle of the visible cone around the view axis (world +X), radians. */
const CONE_RAD = (55 * Math.PI) / 180;
/** Allowed angular length of a line, radians. MIN_SEP also guarantees a line
 *  has ink left after its end gaps. */
const MIN_SEP = 0.08;
const MAX_SEP = 0.3;
/** Minimum gap a new line must keep from every line already drawn, radians. */
const CLEAR_RAD = 0.02;
/** How many recent pairs are not repeated. */
const RECENT = 6;
/** Tries per spawn before giving up (a skipped spawn). */
const PICK_ATTEMPTS = 64;
/** Width of the centre bias: weight = exp(−½(γ/σ)²), γ = angle off the axis. */
const CENTRE_SIGMA_RAD = 0.3;
/** Chance a pick starts from a star an existing line already touches. */
const GROW_CHANCE = 0.9;
/** Bias toward the newest lines' stars when growing: index ⌊u^pow × count⌋. */
const GROW_RECENCY_POW = 3;
/** Most visible lines that may end on one star. */
export const MAX_TOUCH = 3;

/** Bright stars inside the view cone, and (same index) each one's unfloored
 *  `starRho`, used as a brightness key. */
export const CANDIDATE_DIRS: Dir3[] = [];
export const CANDIDATE_RHO: number[] = [];
{
  const cos = Math.cos(CONE_RAD);
  for (let i = 0; i < BRIGHT_COUNT; i++) {
    const s = SKY.stars[i];
    const d = dirOf(s.az, s.alt);
    if (d[0] < cos) continue; // dot with +X
    CANDIDATE_DIRS.push(d);
    CANDIDATE_RHO.push(starRho(s.mag));
  }
}

/** Angle between two unit directions, radians. */
export const sepOf = (a: Dir3, b: Dir3): number =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

const cross3 = (a: Dir3, b: Dir3): Dir3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: Dir3, b: Dir3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether two great-circle arcs (each shorter than π) cross. Touching at a
 *  shared endpoint does not count. */
export function arcsCross(a: Dir3, b: Dir3, c: Dir3, d: Dir3): boolean {
  const n1 = cross3(a, b);
  const n2 = cross3(c, d);
  const m = cross3(n1, n2);
  const len = Math.hypot(m[0], m[1], m[2]);
  if (len < 1e-9) return false;
  // the two circles meet at ±m; the arcs cross if either point is inside both
  const inside = (p: Dir3, s: Dir3, e: Dir3, n: Dir3) =>
    dot3(cross3(n, s), p) > 0 && dot3(cross3(e, n), p) > 0;
  const p: Dir3 = [m[0] / len, m[1] / len, m[2] / len];
  const q: Dir3 = [-p[0], -p[1], -p[2]];
  return (
    (inside(p, a, b, n1) && inside(p, c, d, n2)) ||
    (inside(q, a, b, n1) && inside(q, c, d, n2))
  );
}

/** Angle from point `p` to the arc `s`→`e`, radians. */
export function arcDist(p: Dir3, s: Dir3, e: Dir3): number {
  const n = cross3(s, e);
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl > 1e-9) {
    const nu: Dir3 = [n[0] / nl, n[1] / nl, n[2] / nl];
    const h = dot3(p, nu); // sin(distance to the full circle)
    const f: Dir3 = [p[0] - nu[0] * h, p[1] - nu[1] * h, p[2] - nu[2] * h];
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl > 1e-9) {
      const foot: Dir3 = [f[0] / fl, f[1] / fl, f[2] / fl];
      if (dot3(cross3(nu, s), foot) > 0 && dot3(cross3(e, nu), foot) > 0)
        return Math.asin(Math.min(1, Math.abs(h)));
    }
  }
  return Math.min(sepOf(p, s), sepOf(p, e));
}

/** Whether two arcs cross or pass within `clearRad` of each other. Shared
 *  endpoints are ignored. */
export function arcsClash(
  a: Dir3,
  b: Dir3,
  c: Dir3,
  d: Dir3,
  clearRad: number,
): boolean {
  if (arcsCross(a, b, c, d)) return true;
  // non-crossing segments are closest at one of their endpoints
  const same = (p: Dir3, q: Dir3) => dot3(p, q) > 1 - 1e-9;
  const near = (p: Dir3, s: Dir3, e: Dir3) =>
    !same(p, s) && !same(p, e) && arcDist(p, s, e) < clearRad;
  return near(a, c, d) || near(b, c, d) || near(c, a, b) || near(d, a, b);
}

/** Order-independent key for a pair of star indices. */
export const pairKey = (i: number, j: number): string =>
  i < j ? `${i}-${j}` : `${j}-${i}`;

/** Cumulative centre-bias weights for a list of directions. */
export function centreCdf(dirs: readonly Dir3[]): number[] {
  const cdf: number[] = [];
  let sum = 0;
  for (const d of dirs) {
    const g = Math.acos(Math.min(1, Math.max(-1, d[0]))); // angle off +X
    sum += Math.exp((-0.5 * g * g) / (CENTRE_SIGMA_RAD * CENTRE_SIGMA_RAD));
    cdf.push(sum);
  }
  return cdf;
}

export const CANDIDATE_CDF: number[] = centreCdf(CANDIDATE_DIRS);

/** Sample an index from cumulative weights, `u` ∈ [0, 1). */
export function sampleCdf(cdf: readonly number[], u: number): number {
  const x = u * cdf[cdf.length - 1];
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Pick the next two stars to join, or null if nothing legal turns up.
 * `live` is the lines on the sky, oldest first. Always consumes three `rng()`
 * draws per attempt.
 */
export function pickPair(
  rng: () => number,
  dirs: readonly Dir3[],
  cdf: readonly number[],
  recent: readonly string[],
  clashes: (i: number, j: number) => boolean = () => false,
  live: readonly (readonly [number, number])[] = [],
): [number, number] | null {
  const n = dirs.length;
  if (n < 2) return null;
  const onSky = new Set(live.map(([a, b]) => pairKey(a, b)));
  const touch = new Map<number, number>();
  for (const s of live)
    for (const k of s) touch.set(k, (touch.get(k) ?? 0) + 1);
  // stars a figure can still grow from, newest first
  const open: number[] = [];
  for (let m = live.length - 1; m >= 0; m--)
    for (const k of live[m])
      if (touch.get(k)! < MAX_TOUCH && !open.includes(k)) open.push(k);
  const full = (k: number) => (touch.get(k) ?? 0) >= MAX_TOUCH;
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
    const grow = rng() < GROW_CHANCE && open.length > 0;
    const u = rng();
    const i = grow
      ? open[Math.floor(Math.pow(u, GROW_RECENCY_POW) * open.length)]
      : sampleCdf(cdf, u);
    const j = sampleCdf(cdf, rng());
    if (i === j || full(i) || full(j)) continue;
    const sep = sepOf(dirs[i], dirs[j]);
    const key = pairKey(i, j);
    if (sep < MIN_SEP || sep > MAX_SEP) continue;
    if (onSky.has(key) || recent.includes(key) || clashes(i, j)) continue;
    return [i, j];
  }
  return null;
}

const SEED = 20260808;
/** Time between new lines, ms. The lines' slot count × this must outlast a
 *  line, or a spawn overwrites a visible one. */
export const SPAWN_MS = 1200;

// ── Star names and the quote ────────────────────────────────────────────────
// Canvas-painted text on flat, camera-facing quads: corners are offset in view
// space, so the text never tilts into perspective.

/** Names given to the picked stars, in order. */
export const LABELS: readonly string[] = [
  "VEGA",
  "ALTAIR",
  "DENEB",
  "MIRA",
  "LYRA",
  "ATLAS",
];

export const QUOTE_TEXT =
  "“Boredom always precedes a period of great creativity.”";
export const QUOTE_ATTR = "— ROBERT PIRSIG";

/** Colour of the quote's attribution, per theme. */
const QUOTE_ATTR_INK = { dark: 0xdd8a4c, light: 0x8a4a12 };

/** Minimum angle between two named stars, radians. */
export const LABEL_SEP = 0.25;

/** Half-angles (up/down, left/right) of the region where names may appear. */
const LABEL_UP_RAD = (26 * Math.PI) / 180;
const LABEL_RIGHT_RAD = (38 * Math.PI) / 180;

/** Whether a direction is inside the name region. */
export const inLabelFrame = (d: Dir3): boolean =>
  d[0] > 0 &&
  Math.abs(Math.atan2(d[1], d[0])) <= LABEL_UP_RAD &&
  Math.abs(Math.atan2(d[2], d[0])) <= LABEL_RIGHT_RAD;

/**
 * Pick which stars to name: brightest first, skipping any within `LABEL_SEP`
 * of a star already picked or a `reserved` direction. Ties break by index.
 */
export function pickLabelStars(
  dirs: readonly Dir3[],
  bright: readonly number[],
  opts: {
    eligible: (d: Dir3) => boolean;
    reserved: readonly Dir3[];
    max: number;
  },
): number[] {
  const order = dirs
    .map((_, i) => i)
    .filter((i) => opts.eligible(dirs[i]))
    .sort((a, b) => bright[b] - bright[a] || a - b);
  const taken: Dir3[] = [...opts.reserved];
  const out: number[] = [];
  for (const i of order) {
    if (out.length >= opts.max) break;
    if (taken.some((d) => sepOf(dirs[i], d) <= LABEL_SEP)) continue;
    taken.push(dirs[i]);
    out.push(i);
  }
  return out;
}

/** Unit direction of the quote: up and left of centre. Screen right is +Z,
 *  up is +Y. */
const QUOTE_TILT_RAD = (25 * Math.PI) / 180;
const QUOTE_UP = 0.8;
const QUOTE_LEFT = 0.6;
export const QUOTE_DIR: Dir3 = [
  Math.cos(QUOTE_TILT_RAD),
  Math.sin(QUOTE_TILT_RAD) * QUOTE_UP,
  -Math.sin(QUOTE_TILT_RAD) * QUOTE_LEFT,
];

/** Named stars as indices into CANDIDATE_DIRS; may be fewer than LABELS. */
export const LABEL_STARS: number[] = pickLabelStars(
  CANDIDATE_DIRS,
  CANDIDATE_RHO,
  { eligible: inLabelFrame, reserved: [QUOTE_DIR], max: LABELS.length },
);

/** Look settings for the text. Sizes are in design pixels unless noted. */
export const SKY_TYPE_LOOK = {
  /** Text sphere radius, inside the lines' sphere; nothing depth-tests, so
   *  this sets draw order in the transparent pass. */
  radius: STARFIELD_LOOK.radius * 0.98,
  /** canvas pixels per design pixel */
  ss: 2,
  /** design pixels to radians */
  pxRad: 0.0016,
  label: {
    fontPx: 10,
    /** letterspacing, em — same as the card titles */
    tracking: LABEL_TYPE.trackingEm,
    weight: 400,
    /** sprite height; the text is centred in it */
    boxPx: 14,
    padPx: 3,
    /** offset of a name from its star, radians */
    rightRad: 0.022,
    downRad: 0.022,
    /** alpha per theme (blending is linear, so each theme needs its own) */
    ink: { dark: 0.37, light: 0.62 },
  },
  quote: {
    /** power-of-two canvas; text is centred in it */
    canvasW: 1024,
    canvasH: 512,
    padPx: 14,
    fontPx: 34,
    leadingPx: 46,
    attrPx: 24,
    attrTracking: 0.22,
    attrGapPx: 30,
    /** angular width of the quote sprite, radians */
    widthRad: 0.5,
    /** alpha per theme */
    ink: { dark: 0.92, light: 0.97 },
  },
};

/** Minimum gap a line must keep from the quote's centre, radians. */
export const QUOTE_CLEAR_RAD = SKY_TYPE_LOOK.quote.widthRad / 2 + CLEAR_RAD;

/** Whether a candidate line `i`→`j` would cut through the quote, or cross or
 *  crowd a line already on the sky. */
export function strokeClashes(
  i: number,
  j: number,
  onSky: readonly (readonly [number, number])[],
): boolean {
  const a = CANDIDATE_DIRS[i];
  const b = CANDIDATE_DIRS[j];
  if (arcDist(QUOTE_DIR, a, b) < QUOTE_CLEAR_RAD) return true;
  return onSky.some(([c, d]) =>
    arcsClash(a, b, CANDIDATE_DIRS[c], CANDIDATE_DIRS[d], CLEAR_RAD),
  );
}

/** Pick the dark- or light-theme value. */
export const inkOf = (
  ink: { dark: number; light: number },
  light: boolean,
): number => (light ? ink.light : ink.dark);

/** Each named star with its name. */
export const LABEL_ENTRIES: readonly { text: string; dir: Dir3 }[] =
  LABEL_STARS.map((i, n) => ({
    text: LABELS[n],
    dir: CANDIDATE_DIRS[i],
  }));

/** Same font stacks as global.css (canvas fonts can't use CSS variables). */
const MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SERIF = '"Bitter", Georgia, "Times New Roman", serif';

const paletteOf = (light: boolean): SkyPalette =>
  light ? SKY_INK.light : SKY_INK.dark;

const cssHex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Next power of two ≥ n (keeps textures mipmappable). */
const pow2 = (n: number) => 1 << (32 - Math.clz32(Math.max(1, n - 1)));

function labelFont(ctx: CanvasRenderingContext2D): void {
  const L = SKY_TYPE_LOOK.label;
  ctx.font = `${L.weight} ${L.fontPx * SKY_TYPE_LOOK.ss}px ${MONO}`;
  ctx.letterSpacing = `${L.tracking}em`;
}

/** A blank canvas sized to fit `text`, width rounded up to a power of two
 *  (the spare width is on the right). */
function labelCanvas(text: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  labelFont(ctx);
  const L = SKY_TYPE_LOOK.label;
  const w = ctx.measureText(text).width + 2 * L.padPx * SKY_TYPE_LOOK.ss;
  c.width = pow2(Math.ceil(w));
  c.height = L.boxPx * SKY_TYPE_LOOK.ss;
  return c;
}

function paintLabel(
  canvas: HTMLCanvasElement,
  text: string,
  light: boolean,
): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  labelFont(ctx);
  ctx.fillStyle = cssHex(paletteOf(light).star);
  ctx.textBaseline = "middle";
  ctx.fillText(
    text,
    SKY_TYPE_LOOK.label.padPx * SKY_TYPE_LOOK.ss,
    canvas.height / 2,
  );
}

/** Greedy word wrap to `maxW` canvas pixels in the context's current font. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Paint the quote (italic serif) and its attribution (mono) centred on the
 *  canvas. */
function paintQuote(canvas: HTMLCanvasElement, light: boolean): void {
  const Q = SKY_TYPE_LOOK.quote;
  const ss = SKY_TYPE_LOOK.ss;
  const pal = paletteOf(light);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "0px";
  ctx.font = `italic ${Q.fontPx * ss}px ${SERIF}`;
  const lines = wrapLines(ctx, QUOTE_TEXT, canvas.width - 2 * Q.padPx * ss);
  const blockH = (lines.length * Q.leadingPx + Q.attrGapPx + Q.attrPx) * ss;
  const x = canvas.width / 2;
  let y = (canvas.height - blockH) / 2 + Q.fontPx * ss;
  ctx.fillStyle = cssHex(pal.star);
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += Q.leadingPx * ss;
  }
  const lastBaseline = y - Q.leadingPx * ss;
  ctx.font = `${Q.attrPx * ss}px ${MONO}`;
  ctx.letterSpacing = `${Q.attrTracking}em`;
  ctx.fillStyle = cssHex(light ? QUOTE_ATTR_INK.light : QUOTE_ATTR_INK.dark);
  ctx.fillText(QUOTE_ATTR, x, lastBaseline + (Q.attrGapPx + Q.attrPx) * ss);
}

/** One text quad centred on `centre`. `half` is its half-size and `offset` a
 *  screen-space shift, both in world units. `paint` draws the canvas. */
function buildSprite(
  geo: THREE.PlaneGeometry,
  canvas: HTMLCanvasElement,
  paint: (light: boolean) => void,
  centre: Dir3,
  half: [number, number],
  offset: [number, number],
  name: string,
) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const r = SKY_TYPE_LOOK.radius;
  const uCentre = uniform(
    new THREE.Vector3(centre[0] * r, centre[1] * r, centre[2] * r),
  );
  // xy = half-size, zw = screen shift
  const uBox = uniform(
    new THREE.Vector4(half[0], half[1], offset[0], offset[1]),
  );
  const uOpacity = uniform(0);

  const mat = new THREE.MeshBasicNodeMaterial();
  const view = modelViewMatrix.mul(vec4(uCentre, 1));
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(
      view.x.add(positionGeometry.x.mul(uBox.x)).add(uBox.z),
      view.y.add(positionGeometry.y.mul(uBox.y)).add(uBox.w),
      view.z,
      view.w,
    ),
  );
  const face = texture(tex);
  // colour and alpha set separately so glyph alpha isn't applied twice
  mat.colorNode = face.rgb;
  mat.opacityNode = face.a.mul(uOpacity);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.side = THREE.DoubleSide;
  // a billboard shows one face, so one pass draws what three's two would
  mat.forceSinglePass = true;
  mat.toneMapped = false;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  // placement lives in uniforms, so the geometry's bounds are meaningless
  mesh.frustumCulled = false;
  const repaint = (light: boolean) => {
    paint(light);
    tex.needsUpdate = true;
  };
  return { mesh, uOpacity, repaint };
}

export interface StoryConstellations {
  /** Pre-compile the lines and text off the critical path. Idempotent. */
  warm(): void;
}

/** Start the constellations scene. Registers a per-frame callback for the
 *  life of the page. */
export function createStoryConstellations(
  scene: SceneHandle,
): StoryConstellations {
  const lines = createConstellationLines({ light: isLightTheme() });
  const group = new THREE.Group();
  group.name = "Lens_SkyInk";
  group.add(lines.object);

  // ── text sprites ──
  const geo = new THREE.PlaneGeometry(2, 2); // ±1 corners, scaled by uBox
  const r = SKY_TYPE_LOOK.radius;
  const L = SKY_TYPE_LOOK.label;
  const k = (r * SKY_TYPE_LOOK.pxRad) / SKY_TYPE_LOOK.ss; // canvas px → world
  const labels = LABEL_ENTRIES.map((entry) => {
    const canvas = labelCanvas(entry.text);
    const halfW = (canvas.width * k) / 2;
    return buildSprite(
      geo,
      canvas,
      (l) => paintLabel(canvas, entry.text, l),
      entry.dir,
      [halfW, (canvas.height * k) / 2],
      // anchored by its left edge, right-and-below the star
      [r * L.rightRad + halfW, -r * L.downRad],
      `Lens_SkyLabel_${entry.text.replace(/\s+/g, "_")}`,
    );
  });

  const Q = SKY_TYPE_LOOK.quote;
  const quoteCanvas = document.createElement("canvas");
  quoteCanvas.width = Q.canvasW;
  quoteCanvas.height = Q.canvasH;
  const quoteHalfW = (r * Q.widthRad) / 2;
  const quote = buildSprite(
    geo,
    quoteCanvas,
    (l) => paintQuote(quoteCanvas, l),
    QUOTE_DIR,
    [quoteHalfW, (quoteHalfW * Q.canvasH) / Q.canvasW],
    [0, 0],
    "Lens_SkyQuote",
  );

  const sprites = [...labels, quote];
  for (const s of sprites) group.add(s.mesh);
  /** a theme change repaints the same canvases */
  const repaint = (light: boolean) => {
    for (const s of sprites) s.repaint(light);
  };

  let labelInk = inkOf(L.ink, isLightTheme());
  let quoteInk = inkOf(Q.ink, isLightTheme());

  repaint(isLightTheme());

  // repaint once the webfonts load; earlier paints used fallback fonts
  void document.fonts.ready.then(() => {
    repaint(isLightTheme());
    scene.invalidate();
  });

  watchTheme((l) => {
    lines.setTheme(l);
    labelInk = inkOf(L.ink, l);
    quoteInk = inkOf(Q.ink, l);
    repaint(l);
    scene.invalidate();
  });

  const rng = lcg(SEED);
  const recent: string[] = [];
  /** Lines on the sky, oldest first; each is dropped once fully faded. */
  const live: { pair: [number, number]; deadAt: number }[] = [];
  let tAcc = 0;
  let nextSpawn = 0;

  scene.onEvaluate((p, dt) => {
    const env = constellationEnvAt(p);
    const qEnv = quoteEnvAt(p);

    // always write opacities so a fast scroll never leaves stale values
    lines.setEnvelope(env);
    const labelO = labelEnvAt(p) * labelInk;
    for (const l of labels) l.uOpacity.value = labelO;
    quote.uOpacity.value = qEnv * quoteInk;

    if (env <= 0 && qEnv <= 0) {
      if (group.parent && (p < SPAN_P0 || p > SPAN_P1))
        scene.starfieldDetach(group);
    } else if (!scene.starfieldAttach(group)) {
      // the starfield may be (re)mounted at any time; keep asking for frames
      // until the attach succeeds
      return true;
    }

    // not drawn while attached at zero opacity; unattached they stay visible
    // so the warm draw reaches them
    const unattached = !group.parent;
    lines.object.visible = unattached || env > 0;
    for (const l of labels) l.mesh.visible = unattached || labelO > 0;
    quote.mesh.visible = unattached || qEnv > 0;

    // lines gone, quote static or gone: stop the clock and let the scene sleep
    if (env <= 0) return false;

    tAcc += dt;
    lines.setTime(tAcc);
    if (tAcc < nextSpawn) return true;
    nextSpawn = tAcc + SPAWN_MS;
    for (let k = live.length - 1; k >= 0; k--)
      if (live[k].deadAt <= tAcc) live.splice(k, 1);
    const onSky = live.map((s) => s.pair);
    const pair = pickPair(
      rng,
      CANDIDATE_DIRS,
      CANDIDATE_CDF,
      recent,
      (i, j) => strokeClashes(i, j, onSky),
      onSky,
    );
    if (!pair) return true; // no legal pair this time; skip the spawn
    recent.push(pairKey(pair[0], pair[1]));
    if (recent.length > RECENT) recent.shift();
    const a = CANDIDATE_DIRS[pair[0]];
    const b = CANDIDATE_DIRS[pair[1]];
    live.push({
      pair,
      deadAt:
        tAcc +
        lineDrawMs(sepOf(a, b)) +
        CONST_LINES_LOOK.lifeMs +
        CONST_LINES_LOOK.fadeMs,
    });
    lines.spawn(a, b, tAcc);
    return true;
  });

  let warmed = false;
  return {
    warm() {
      if (warmed || group.parent) return;
      warmed = true;
      // also through the post pass, which is active when the ink first shows
      scene.warmDraw([group], true);
    },
  };
}
