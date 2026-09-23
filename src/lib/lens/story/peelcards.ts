// THE CARD FIELD: eight photo cards on a sphere about the lens's bore. Each
// fades in on the wink (story/envelopes.ts winkLevelAt) against a threshold of
// its own in the shell wedges' band, so the cards arrive as the wedges
// dissolve, staggered like them. The field is a MODEL overlay (core/scene.ts
// addModelOverlay): parented to the lens, so the bore roll, the turn, the dip
// and the tip carry it.
//
// ONE CLOCK, and one exception: the eased story p owns everything but the
// sphere's slow revolution, which TIME owns off the tick's accumulated dt —
// and only while a card is drawn, so an empty field asks for no frame.
//
// THE 2D LAW: a card is a view-space billboard — its centre goes through
// modelViewMatrix and the corners are added in VIEW space, so the quad is
// always parallel to the film plane.
//
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
import { clamp01, deg, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import {
  EXTRA_BAND,
  WINK_WIDTH,
  inBand,
  winkOpacity,
} from "../core/visibility";
import { STORY_R, rangeOf, span, windowEdges } from "./story";
import { UPRIGHT, WINK_SPAN, winkLevelAt, winkPAt } from "./envelopes";

const cdR = rangeOf("cards");

/** Scene-local fraction of `p`, clamped. */
const localOf = (r: { p0: number; p1: number }, p: number) =>
  clamp01((p - r.p0) / (r.p1 - r.p0));

// --- the choreography numbers ----------------------------------------------

export const CARD_COUNT = 8;

/** wedges per segmented shell family in the shipped GLBs */
export const SEG_COUNT = 5;

/** THE ARRIVAL, in absolute story p: the slice of the wink where the shell
 *  wedges dissolve — the first can begin at the wedge band's top, and the band
 *  floors at WINK_WIDTH, so the last is gone exactly where the wink is spent.
 *  Every card opens and is whole inside it. */
export const CARDS_IN_SPAN = span("cards.in", [
  winkPAt(EXTRA_BAND),
  WINK_SPAN[1],
]);

/** THE EXIT, as fractions of UPRIGHT's rise: card windows fanned over
 *  [OUT_F0, OUT_F1], each OUT_W wide, in the order the tip carries them. The
 *  last must be out by the cards scene's end, where the field unmounts. */
const OUT_F0 = 0.02;
const OUT_F1 = 0.36;
const OUT_W = 0.14;
const OUT_STEP = (OUT_F1 - OUT_F0 - OUT_W) / (CARD_COUNT - 1);
const [UP0, UP1] = windowEdges(UPRIGHT.rise);
export const CARDS_OUT_SPAN = span("cards.out", [
  lerp(UP0, UP1, OUT_F0),
  lerp(UP0, UP1, OUT_F1),
]);

/** card size in world units, BEFORE the per-card scale below */
const CARD_SIZE: [number, number] = [1.6, 2.0];
/** per-card size, as a multiple of CARD_SIZE, by k mod 3 */
const CARD_SCALE0 = 0.85;
const CARD_DSCALE = 0.175;

/** THE SPHERE'S RADIUS, world units — every station sits at exactly this
 *  distance, which must clear the model's bounding sphere. */
const SHELL_R = 5.2;
/** the sphere's own revolution about the bore, rad/s — a parked drift; the
 *  scroll (the lens's turn, the gather) is the motion that shows */
const SHELL_RATE = 0.25;
/** how far up and down the axis the eight stations reach, as a fraction of the
 *  radius. Short of 1 so no card parks on a POLE, where a rotation about the
 *  axis would leave it dead still. */
const SHELL_LAT = 0.78;

// --- THE FIT: the sphere sized to the frame ---------------------------------

/** a card's own reach past its centre, world units — the half-diagonal at the
 *  largest per-card scale, what the fit must clear beyond SHELL_R */
const CARD_REACH = 1.2;
/** the cards scene's settle distance, world units — the depth the frame's
 *  width is measured at */
const CARDS_DIST = Math.hypot(...cdR.scene.cam.pos) * STORY_R;
/** the fit's floor: below this the ring sits ON the mechanism, so a narrow
 *  frame crops a little instead */
const FIT_MIN = 0.6;

/** THE PORTRAIT FIT — how much of the authored sphere radius the frame can
 *  hold. `halfW` is the frame's world half-WIDTH at the cards' depth (frameHalf
 *  × aspect × distance); at 16:9 the fit is exactly 1. */
export const cardFitOf = (halfW: number): number =>
  Math.min(1, Math.max(FIT_MIN, halfW / (SHELL_R + CARD_REACH)));

// --- THE GATHER: the middle of the scene ------------------------------------
// On the scroll the eight stations slide off their sphere onto one ring and
// the ring draws in, so the photos flip past the turning mechanism.

/** cards: the gather's window */
const GATHER: [number, number] = [0.4, 0.78];
/** how much of the sphere's radius the ring pulls in — short of the core */
const GATHER_PULL = 0.25;
/** whole turns the gather ADDS on the scroll, on top of the sphere's clock */
const GATHER_TURNS = 0.25;

/** The gltf-frame angle (atan2(z, x) in the radial plane) of `Seg0`'s seated
 *  sector centre. The wedge ring is cut into SEG_COUNT equal sectors and the
 *  index runs the OTHER WAY round the axis, hence the minus below. */
const SEG0_ANGLE = deg(-65.9);

/** The seated sector direction of shell wedge `seg`, as an angle in the gltf
 *  radial plane (x = cos, z = sin). */
export const segSectorAngle = (seg: number): number =>
  SEG0_ANGLE - (seg * 2 * Math.PI) / SEG_COUNT;

// --- the laws ---------------------------------------------------------------

/** Card k's wink threshold: the k-th station of the wedge band's own scatter,
 *  so the cards arrive with the wedges — staggered, never together. */
export const cardThresholdOf = (k: number): number =>
  inBand(k, WINK_WIDTH, EXTRA_BAND);

/** Card k's fade-in at p: the complement of a wedge's opacity at its
 *  threshold, so it rises exactly as that wedge would fall. */
export const cardInAt = (k: number, p: number): number =>
  1 - winkOpacity(cardThresholdOf(k), winkLevelAt(p));

/** Card k's rank along the tip: the +X end of the sphere leaves first. */
const outRankOf = (k: number): number => CARD_COUNT - 1 - k;

/** Card k's fade-OUT at p, 0 → 1 over its own slice of UPRIGHT's rise. */
export const cardOutAt = (k: number, p: number): number => {
  const f = clamp01((p - UP0) / (UP1 - UP0));
  const a = OUT_F0 + outRankOf(k) * OUT_STEP;
  return smoothstep(a, a + OUT_W, f);
};

/** Card k's size, as a multiple of CARD_SIZE. */
export const cardScaleAt = (k: number): number =>
  CARD_SCALE0 + CARD_DSCALE * (k % 3);

/** THE CARD ROLL — screen-plane only: it turns the billboard's corner offsets
 *  about the view axis, the one rotation a billboard may have under the 2D law.
 *  A card comes off tipped over, rights itself over its own fade-in and
 *  settles at a small per-card residual. */
const ROLL_ENTRY = deg(15);
const ROLL_REST = deg(3.2);
export const cardRollAt = (k: number, fade: number): number => {
  const sign = k % 2 === 0 ? 1 : -1;
  const entry = ROLL_ENTRY * sign * (1 + 0.25 * ((k % 3) - 1));
  const rest = ROLL_REST * sign * (1 + 0.3 * ((k % 4) - 1.5));
  return entry + (rest - entry) * fade;
};

/** Card k's LONGITUDE on the sphere, at rest — SEEDED FROM THE SHELL'S SEAMS:
 *  the first five cards start where the five strips left, the last three
 *  halfway between. The frame conversion: a sector's gltf radial direction
 *  (cos θ, ·, sin θ) lands on world (−sin θ, −cos θ) in Y–Z under core/scene's
 *  two model rolls, and the sphere is written y = r·cos φ, z = r·sin φ — so
 *  φ = −(θ + π/2) puts the card on the strip's own meridian. */
const cardPhaseAt = (k: number): number =>
  -(segSectorAngle(k % SEG_COUNT) + Math.PI / 2) +
  (k >= SEG_COUNT ? Math.PI / SEG_COUNT : 0);

/** Card k's LATITUDE on the sphere, as a fraction of the radius: eight stations
 *  evenly spread over [−SHELL_LAT, +SHELL_LAT]. The midpoint form
 *  ((2k+1)/n − 1) keeps both ends off the poles. */
const cardLatAt = (k: number): number =>
  SHELL_LAT * ((2 * k + 1) / CARD_COUNT - 1);

/** Card k's STATION at accumulated time `tMs`, in the model overlay's frame
 *  (world units, bore along +X) — a pure function of (k, t, gather). A sphere
 *  that turns as one about the bore: every card sits at SHELL_R on its own
 *  latitude and longitude and runs that latitude circle. */
export const cardOrbitAt = (
  k: number,
  tMs: number,
  gather = 0,
): { x: number; y: number; z: number } => {
  // the gather flattens the sphere onto one ring and pulls it in; `lat` is what
  // holds a card off the equator, so it is the term that goes
  const lat = cardLatAt(k) * (1 - gather);
  const r = SHELL_R * (1 - GATHER_PULL * gather);
  const ring = r * Math.sqrt(1 - lat * lat);
  const phi =
    cardPhaseAt(k) +
    SHELL_RATE * (tMs / 1000) +
    gather * GATHER_TURNS * 2 * Math.PI;
  return {
    x: r * lat,
    y: ring * Math.cos(phi),
    z: ring * Math.sin(phi),
  };
};

/** How far the field has GATHERED, in cards-local fraction: 0 = the sphere it
 *  arrives as, 1 = the ring it dissolves as. */
export const cardGatherAt = (local: number): number =>
  smoothstep(GATHER[0], GATHER[1], local);

// --- the card faces ---------------------------------------------------------

/** Face palette, from LensStory.astro's stage vars. */
const FACE_PALETTE = {
  light: {
    paper: "#f2eee4",
    ink: "#2c2822",
    faint: "rgba(44, 40, 34, 0.45)",
    rule: "rgba(44, 40, 34, 0.18)",
    accent: "#b06a3c",
  },
  dark: {
    paper: "#1d1a14",
    ink: "#ece7da",
    faint: "rgba(236, 231, 218, 0.4)",
    rule: "rgba(236, 231, 218, 0.15)",
    accent: "#d18a5d",
  },
} as const;

const FACE_W = 512;
const FACE_H = 640;
/** the frame's matte — the even border around the photo, in face pixels */
const FACE_BORDER = 20;
/** the strip under the photo that carries the title */
const FACE_TITLE_STRIP = 86;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** THE LABEL TYPE — shared by the card titles and the star-atlas names
 *  (story/constellations.ts). Weight/tracking here; size per painter. */
export const LABEL_TYPE = { weight: 500, trackingEm: 0.18 } as const;

/** the photo well's box, shared by the painter and the loader */
const WELL_W = FACE_W - FACE_BORDER * 2;
const WELL_H = FACE_H - FACE_BORDER * 2 - FACE_TITLE_STRIP;

/** One placeholder photo per card, seeded so every visit shows the same eight.
 *  Loaded ONCE per page and kept, so a theme repaint reuses the pixels. */
const faceImages: (HTMLImageElement | null | undefined)[] = [];
function loadFaceImage(k: number, onReady: () => void): void {
  if (faceImages[k] !== undefined) return;
  // null = "in flight or failed" — either way the painter hatches the well,
  // and the guard above keeps a re-mount from fetching twice
  faceImages[k] = null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    faceImages[k] = img;
    onReady();
  };
  img.src = `https://picsum.photos/seed/lens-card-${k + 1}/${WELL_W}/${WELL_H}`;
}

/** Draw card `k`'s face: a PICTURE FRAME — an even theme-paper matte, square
 *  corners, the photo filling the well, and a left-aligned uppercase mono title
 *  on the strip below. Photo and title are placeholders. */
function paintFace(canvas: HTMLCanvasElement, k: number, light: boolean): void {
  const c = light ? FACE_PALETTE.light : FACE_PALETTE.dark;
  const ctx = canvas.getContext("2d")!;

  // the matte — the whole face, edge to edge, square-cornered
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, FACE_W, FACE_H);

  // the photo well
  const img = faceImages[k];
  if (img) {
    ctx.drawImage(img, FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
  } else {
    // not loaded (yet, or offline): the hatched "image goes here" well
    ctx.save();
    ctx.beginPath();
    ctx.rect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
    ctx.clip();
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 2;
    for (let x = -WELL_H; x < WELL_W; x += 16) {
      ctx.beginPath();
      ctx.moveTo(FACE_BORDER + x, FACE_BORDER + WELL_H);
      ctx.lineTo(FACE_BORDER + x + WELL_H, FACE_BORDER);
      ctx.stroke();
    }
    ctx.restore();
  }
  // a hairline seat between photo and matte, so the well reads set-in
  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);

  // the title: uppercase tracked mono (LABEL_TYPE) on the well's left edge
  const titlePx = 27;
  ctx.fillStyle = c.ink;
  ctx.font = `${LABEL_TYPE.weight} ${titlePx}px ${MONO}`;
  ctx.letterSpacing = `${titlePx * LABEL_TYPE.trackingEm}px`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(
    `PLACEHOLDER ${String(k + 1).padStart(2, "0")}`,
    FACE_BORDER,
    FACE_BORDER + WELL_H + 54,
  );
  ctx.letterSpacing = "0px";

  // the frame's outer edge, faint
  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, FACE_W - 2, FACE_H - 2);
}

/** One card's face texture. The canvas is KEPT so a theme flip can repaint it
 *  in place and re-upload through `needsUpdate`. */
function buildFace(k: number, light: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  paintFace(canvas, k, light);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, tex };
}

interface Card {
  mat: THREE.MeshBasicNodeMaterial;
  /** PARKED until `show()` mounts the field — so `warm()` can draw the quads
   *  one per tick (warmDrawFrame only adds objects that have no parent). */
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  uCentre: { value: THREE.Vector3 };
  uOpacity: { value: number };
  /** (cos roll, sin roll) — the screen-plane roll, written per frame */
  uRollCS: { value: THREE.Vector2 };
}

interface Field {
  group: THREE.Group;
  geo: THREE.PlaneGeometry;
  cards: Card[];
}

/** Build the eight quads: one shared geometry, one material and one canvas per
 *  card, with no GPU work until the first draw. */
function buildField(light: boolean): Field {
  // ±1 corners, so the vertexNode's corner offset IS the half-size
  const geo = new THREE.PlaneGeometry(2, 2);
  const group = new THREE.Group();
  group.name = "Lens_CardField";
  const cards: Card[] = [];
  for (let k = 0; k < CARD_COUNT; k++) {
    const { canvas, tex } = buildFace(k, light);
    // each card carries its own half-size (cardScaleAt) as a uniform constant
    const s = cardScaleAt(k);
    const uHalf = uniform(
      new THREE.Vector2((CARD_SIZE[0] * s) / 2, (CARD_SIZE[1] * s) / 2),
    );
    const uCentre = uniform(new THREE.Vector3());
    const uOpacity = uniform(0);
    const uRollCS = uniform(new THREE.Vector2(1, 0));
    const mat = new THREE.MeshBasicNodeMaterial();
    // the billboard (as optics/starfield.ts starMark): the centre goes to VIEW
    // space, the corner is added there in view-space world units, and only then
    // does the projection run. The roll turns the corners in that same plane.
    const centre = modelViewMatrix.mul(vec4(uCentre, 1));
    const px = positionGeometry.x.mul(uHalf.x);
    const py = positionGeometry.y.mul(uHalf.y);
    mat.vertexNode = cameraProjectionMatrix.mul(
      vec4(
        centre.x.add(px.mul(uRollCS.x).sub(py.mul(uRollCS.y))),
        centre.y.add(px.mul(uRollCS.y).add(py.mul(uRollCS.x))),
        centre.z,
        centre.w,
      ),
    );
    const face = texture(tex);
    // rgb and alpha SEPARATELY: a vec4 colorNode would also land the face's
    // alpha in diffuseColor.a, which three multiplies by the opacity node
    mat.colorNode = face.rgb;
    mat.opacityNode = face.a.mul(uOpacity);
    mat.transparent = true;
    // a card behind the lens must be hidden by it, and alphaTest keeps faded
    // cards and corners out of the depth buffer
    mat.depthWrite = true;
    mat.alphaTest = 0.02;
    // the field is looked at from anywhere in the story, so culling a back face
    // would only ever cost a card
    mat.side = THREE.DoubleSide;
    // flat ink, not a lit surface (the 2D/3D design law)
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    // the geometry sits at the origin and the real position is a uniform, so
    // three's bounding sphere means nothing here
    mesh.frustumCulled = false;
    cards.push({ mat, mesh, canvas, tex, uCentre, uOpacity, uRollCS });
  }
  return { group, geo, cards };
}

// --- the module -------------------------------------------------------------

/** Run `cb` when the page has a moment, and no later than the timeout. */
const atIdle = (cb: () => void) => {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(cb, { timeout: 1000 });
  else setTimeout(cb, 200);
};
/** story-p slack past each mount edge, so a scrub parked exactly on one cannot
 *  thrash build/dispose */
export const MOUNT_HYST = 0.02;
/** THE SHOW WINDOW, in absolute story p: one hysteresis ahead of the first
 *  card's fade (the uploads are `warm()`'s, not the mount's) to the cards
 *  scene's end. */
export const MOUNT_LO = CARDS_IN_SPAN[0] - MOUNT_HYST;
export const MOUNT_HI = cdR.p1;

export function createPeelCards(scene: SceneHandle): {
  warm(): void;
} {
  /** Built once and kept for the page; leaving the window takes the group off
   *  the overlay and nothing else. */
  let field: Field | null = null;
  let shown = false;
  let light = isLightTheme();
  let tAcc = 0;

  // The photos load at boot, not at mount: a decode + texture upload landing
  // mid-peel is a visible hitch. Stragglers batch into one idle repaint pass
  // rather than uploading on eight unpredictable frames.
  const owed = new Set<number>();
  let repaintQueued = false;
  function repaintOwed() {
    repaintQueued = false;
    if (!field || !owed.size) return;
    for (const k of owed) {
      paintFace(field.cards[k].canvas, k, light);
      field.cards[k].tex.needsUpdate = true;
    }
    owed.clear();
    scene.invalidate();
  }
  for (let k = 0; k < CARD_COUNT; k++) {
    loadFaceImage(k, () => {
      owed.add(k);
      if (repaintQueued || !field) return; // unbuilt: buildFace paints it fresh
      repaintQueued = true;
      atIdle(repaintOwed);
    });
  }

  function ensureField(): Field {
    field ??= buildField(light);
    return field;
  }

  function show() {
    if (shown) return;
    const f = ensureField();
    // the retained opacities are the ones it left on; the evaluate step below
    // rewrites them before this frame's render
    for (const c of f.cards) {
      c.uOpacity.value = 0;
      f.group.add(c.mesh); // parked until the field mounts (see Card.mesh)
    }
    scene.addModelOverlay(f.group);
    shown = true;
  }

  function hide() {
    if (!shown || !field) return;
    scene.removeModelOverlay(field.group);
    shown = false;
  }

  // theme flips repaint the faces in place (same canvas, same texture object),
  // shown or not — the field outlives its window
  watchTheme((l) => {
    light = l;
    if (!field) return; // not built yet — it builds at the live theme
    for (let k = 0; k < CARD_COUNT; k++) {
      paintFace(field.cards[k].canvas, k, light);
      field.cards[k].tex.needsUpdate = true;
    }
    scene.invalidate();
  });

  // the mount window, then the centres and the opacities; registered for the
  // life of the page
  scene.onEvaluate((p, dt) => {
    if (p >= MOUNT_LO && p <= MOUNT_HI) show();
    else if (p < MOUNT_LO - MOUNT_HYST || p > MOUNT_HI + MOUNT_HYST) hide();
    if (!shown || !field) return false; // resident but off the overlay: nothing draws
    const cardsLocal = localOf(cdR, p);
    const gather = cardGatherAt(cardsLocal);
    // the whole sphere rides the fit — centres only, so the cards keep their
    // size and simply orbit closer on a narrow frame
    const fit = cardFitOf(scene.frameHalf() * scene.frameAspect() * CARDS_DIST);
    let lit = false;
    for (let k = 0; k < CARD_COUNT; k++) {
      const c = field.cards[k];
      const fade = cardInAt(k, p);
      const o = cardOrbitAt(k, tAcc, gather);
      c.uCentre.value.set(o.x * fit, o.y * fit, o.z * fit);
      c.uOpacity.value = fade * (1 - cardOutAt(k, p));
      if (c.uOpacity.value > 0) lit = true;
      const roll = cardRollAt(k, fade);
      c.uRollCS.value.set(Math.cos(roll), Math.sin(roll));
    }
    // the sphere runs on time only while a card is drawn: an invisible field
    // neither ages nor asks for a frame
    if (lit) tAcc += dt;
    return lit;
  });

  return {
    /** Build the eight faces and pay their upload off the gesture, one card per
     *  tick — eight uploads on a single frame is a stall. */
    warm() {
      // a card the reader already outran is mounted and its real frames upload
      // it; only the parked ones owe a dry draw
      for (const c of ensureField().cards)
        if (!c.mesh.parent) scene.warmDraw([c.mesh]);
    },
  };
}
