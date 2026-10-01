// The `cards` scene: eight photo cards on a sphere around the lens. Each card
// fades in as a shell wedge fades out (the "wink", story/envelopes.ts), so they
// arrive staggered like the wedges. The field is parented to the lens model, so
// it follows the lens's roll and turn.
//
// Everything follows story p except the sphere's slow spin, which runs on
// accumulated frame time while any card is visible. Cards are flat billboards:
// corners are offset in view space so they always face the camera.

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

// --- Timing ---

export const CARD_COUNT = 8;

/** Wedges per segmented shell part in the shipped model. */
export const SEG_COUNT = 5;

/** Story-p span over which the cards fade in: the part of the wink where the
 *  shell wedges dissolve. */
export const CARDS_IN_SPAN = span("cards.in", [
  winkPAt(EXTRA_BAND),
  WINK_SPAN[1],
]);

/** Fade-out windows, as fractions of UPRIGHT's rise: each card fades over
 *  OUT_W, staggered across [OUT_F0, OUT_F1]. Must finish before the scene ends. */
const OUT_F0 = 0.02;
const OUT_F1 = 0.36;
const OUT_W = 0.14;
const OUT_STEP = (OUT_F1 - OUT_F0 - OUT_W) / (CARD_COUNT - 1);
const [UP0, UP1] = windowEdges(UPRIGHT.rise);
export const CARDS_OUT_SPAN = span("cards.out", [
  lerp(UP0, UP1, OUT_F0),
  lerp(UP0, UP1, OUT_F1),
]);

/** Base card size in world units. */
const CARD_SIZE: [number, number] = [1.6, 2.0];
/** Per-card scale: CARD_SCALE0 + CARD_DSCALE × (k mod 3). */
const CARD_SCALE0 = 0.85;
const CARD_DSCALE = 0.175;

/** Sphere radius, world units; must clear the model's bounding sphere. */
const SHELL_R = 5.2;
/** Sphere spin about the lens axis, rad/s. */
const SHELL_RATE = 0.25;
/** Latitude reach as a fraction of the radius; below 1 keeps cards off the
 *  poles, where the spin wouldn't move them. */
const SHELL_LAT = 0.78;

// --- Fitting the sphere to narrow screens ---

/** A card's half-diagonal at its largest scale, world units. */
const CARD_REACH = 1.2;
/** Camera distance in the cards scene, world units. */
const CARDS_DIST = Math.hypot(...cdR.scene.cam.pos) * STORY_R;
/** Smallest allowed fit; narrower frames crop instead. */
const FIT_MIN = 0.6;

/** Scale for the sphere given the frame's world half-width at the cards'
 *  depth; 1 at 16:9. */
export const cardFitOf = (halfW: number): number =>
  Math.min(1, Math.max(FIT_MIN, halfW / (SHELL_R + CARD_REACH)));

// --- Gather: mid-scene the sphere flattens onto one ring and pulls in ---

/** Gather window, as fractions of the cards scene. */
const GATHER: [number, number] = [0.4, 0.78];
/** Fraction of the radius the ring pulls in. */
const GATHER_PULL = 0.25;
/** Extra turns the ring makes during the gather. */
const GATHER_TURNS = 0.25;

/** Model-frame angle (atan2(z, x)) of wedge `Seg0`'s centre. Wedge indices run
 *  the opposite way round the axis, hence the minus below. */
const SEG0_ANGLE = deg(-65.9);

/** Model-frame angle of wedge `seg`'s centre (x = cos, z = sin). */
export const segSectorAngle = (seg: number): number =>
  SEG0_ANGLE - (seg * 2 * Math.PI) / SEG_COUNT;

// --- Per-card functions ---

/** Card k's wink threshold: the same one wedge k uses, so they fade together. */
export const cardThresholdOf = (k: number): number =>
  inBand(k, WINK_WIDTH, EXTRA_BAND);

/** Card k's fade-in at p: the inverse of its matching wedge's opacity. */
export const cardInAt = (k: number, p: number): number =>
  1 - winkOpacity(cardThresholdOf(k), winkLevelAt(p));

/** Order in which cards fade out: the +X end of the sphere goes first. */
const outRankOf = (k: number): number => CARD_COUNT - 1 - k;

/** Card k's fade-out at p, 0 → 1. */
export const cardOutAt = (k: number, p: number): number => {
  const f = clamp01((p - UP0) / (UP1 - UP0));
  const a = OUT_F0 + outRankOf(k) * OUT_STEP;
  return smoothstep(a, a + OUT_W, f);
};

/** Card k's size, as a multiple of CARD_SIZE. */
export const cardScaleAt = (k: number): number =>
  CARD_SCALE0 + CARD_DSCALE * (k % 3);

/** Card k's in-plane tilt: starts tipped and settles to a small per-card angle
 *  as it fades in. */
const ROLL_ENTRY = deg(15);
const ROLL_REST = deg(3.2);
export const cardRollAt = (k: number, fade: number): number => {
  const sign = k % 2 === 0 ? 1 : -1;
  const entry = ROLL_ENTRY * sign * (1 + 0.25 * ((k % 3) - 1));
  const rest = ROLL_REST * sign * (1 + 0.3 * ((k % 4) - 1.5));
  return entry + (rest - entry) * fade;
};

/** Card k's starting longitude: the first five at the five wedges' positions,
 *  the rest halfway between. A model-frame angle θ maps to sphere angle
 *  φ = −(θ + π/2) under the scene's model rotations. */
const cardPhaseAt = (k: number): number =>
  -(segSectorAngle(k % SEG_COUNT) + Math.PI / 2) +
  (k >= SEG_COUNT ? Math.PI / SEG_COUNT : 0);

/** Card k's latitude as a fraction of the radius, evenly spaced over
 *  [−SHELL_LAT, SHELL_LAT]. */
const cardLatAt = (k: number): number =>
  SHELL_LAT * ((2 * k + 1) / CARD_COUNT - 1);

/** Card k's position at time `tMs` and gather amount, in the lens model's frame
 *  (world units, lens axis along +X). */
export const cardOrbitAt = (
  k: number,
  tMs: number,
  gather = 0,
): { x: number; y: number; z: number } => {
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

/** Gather amount at a cards-scene fraction: 0 = sphere, 1 = ring. */
export const cardGatherAt = (local: number): number =>
  smoothstep(GATHER[0], GATHER[1], local);

// --- Card faces ---

/** Face colours per theme, matching LensStory.astro. */
const FACE_PALETTE = {
  light: {
    paper: "#f2eee4",
    ink: "#2c2822",
    rule: "rgba(44, 40, 34, 0.18)",
  },
  dark: {
    paper: "#1d1a14",
    ink: "#ece7da",
    rule: "rgba(236, 231, 218, 0.15)",
  },
} as const;

const FACE_W = 512;
const FACE_H = 640;
/** Border around the photo, face pixels. */
const FACE_BORDER = 20;
/** Height of the title strip under the photo, face pixels. */
const FACE_TITLE_STRIP = 86;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** Label type shared by card titles and star names (constellations.ts). */
export const LABEL_TYPE = { weight: 500, trackingEm: 0.18 } as const;

const WELL_W = FACE_W - FACE_BORDER * 2;
const WELL_H = FACE_H - FACE_BORDER * 2 - FACE_TITLE_STRIP;

/** One placeholder photo per card, loaded once per page. undefined = not
 *  requested, null = loading or failed. */
const faceImages: (HTMLImageElement | null | undefined)[] = [];
function loadFaceImage(k: number, onReady: () => void): void {
  if (faceImages[k] !== undefined) return;
  faceImages[k] = null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    faceImages[k] = img;
    onReady();
  };
  img.src = `https://picsum.photos/seed/lens-card-${k + 1}/${WELL_W}/${WELL_H}`;
}

/** Card `k`'s face on a new canvas: paper border, photo (or hatching until it
 *  loads), and a placeholder title underneath. */
function paintFace(k: number, light: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  const c = light ? FACE_PALETTE.light : FACE_PALETTE.dark;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, FACE_W, FACE_H);

  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  const img = faceImages[k];
  if (img) {
    ctx.drawImage(img, FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
    ctx.clip();
    for (let x = -WELL_H; x < WELL_W; x += 16) {
      ctx.beginPath();
      ctx.moveTo(FACE_BORDER + x, FACE_BORDER + WELL_H);
      ctx.lineTo(FACE_BORDER + x + WELL_H, FACE_BORDER);
      ctx.stroke();
    }
    ctx.restore();
  }
  // thin outline around the photo
  ctx.strokeRect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);

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

  // faint outer edge
  ctx.strokeRect(1, 1, FACE_W - 2, FACE_H - 2);
  return canvas;
}

/** What a face texture holds once uploaded: its size, not its canvas. */
const FACE_SIZE = { width: FACE_W, height: FACE_H };

interface Card {
  /** Unparented until the field first mounts, so `warm()` can pre-draw it
   *  (warmDraw only takes parentless objects). */
  mesh: THREE.Mesh;
  tex: THREE.CanvasTexture<HTMLCanvasElement | typeof FACE_SIZE>;
  uCentre: { value: THREE.Vector3 };
  uOpacity: { value: number };
  /** (cos, sin) of the card's in-plane tilt */
  uRollCS: { value: THREE.Vector2 };
}

interface Field {
  group: THREE.Group;
  cards: Card[];
}

/** Build the eight card meshes: one shared quad, one material and texture each. */
function buildField(light: boolean): Field {
  const geo = new THREE.PlaneGeometry(2, 2); // ±1 corners, scaled by uHalf
  const group = new THREE.Group();
  group.name = "Lens_CardField";
  const cards: Card[] = [];
  for (let k = 0; k < CARD_COUNT; k++) {
    const tex = new THREE.CanvasTexture<HTMLCanvasElement | typeof FACE_SIZE>(
      paintFace(k, light),
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    // the upload copies the canvas, so drop it; a repaint paints a new one
    tex.onUpdate = () => (tex.image = FACE_SIZE);
    const s = cardScaleAt(k);
    const uHalf = uniform(
      new THREE.Vector2((CARD_SIZE[0] * s) / 2, (CARD_SIZE[1] * s) / 2),
    );
    const uCentre = uniform(new THREE.Vector3());
    const uOpacity = uniform(0);
    const uRollCS = uniform(new THREE.Vector2(1, 0));
    const mat = new THREE.MeshBasicNodeMaterial();
    // billboard: move the centre to view space, add the rotated corner there,
    // then project
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
    // colour and alpha set separately so face alpha isn't applied twice
    mat.colorNode = face.rgb;
    mat.opacityNode = face.a.mul(uOpacity);
    mat.transparent = true;
    // write depth so the lens hides cards behind it; alphaTest keeps faded
    // cards out of the depth buffer
    mat.depthWrite = true;
    mat.alphaTest = 0.02;
    mat.side = THREE.DoubleSide;
    // a billboard shows one face, so one pass draws what three's two would
    mat.forceSinglePass = true;
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    // position lives in a uniform, so the geometry's bounds are meaningless
    mesh.frustumCulled = false;
    cards.push({ mesh, tex, uCentre, uOpacity, uRollCS });
  }
  return { group, cards };
}

// --- The scene driver ---

/** Run `cb` when the browser is idle, or after a timeout. */
const atIdle = (cb: () => void) => {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(cb, { timeout: 1000 });
  else setTimeout(cb, 200);
};
/** Story-p slack around the mount window so scrubbing at an edge doesn't
 *  thrash mount/unmount. */
export const MOUNT_HYST = 0.02;
/** Story-p window in which the field is mounted. */
export const MOUNT_LO = CARDS_IN_SPAN[0] - MOUNT_HYST;
export const MOUNT_HI = cdR.p1;

export function createPeelCards(scene: SceneHandle): {
  warm(): void;
} {
  /** Built once and kept; hiding only removes it from the overlay. */
  let field: Field | null = null;
  let shown = false;
  let light = isLightTheme();
  let tAcc = 0;

  function repaint(f: Field, ks: Iterable<number>) {
    for (const k of ks) {
      f.cards[k].tex.image = paintFace(k, light);
      f.cards[k].tex.needsUpdate = true;
    }
    scene.invalidate();
  }

  // Photos load at boot so no decode lands mid-scroll. Late arrivals are
  // repainted together in one idle pass.
  const owed = new Set<number>();
  let repaintQueued = false;
  for (let k = 0; k < CARD_COUNT; k++) {
    loadFaceImage(k, () => {
      owed.add(k);
      if (repaintQueued || !field) return; // not built yet: it paints fresh
      repaintQueued = true;
      atIdle(() => {
        repaintQueued = false;
        repaint(field!, owed);
        owed.clear();
      });
    });
  }

  // repaint faces in place on theme change, whether shown or not
  watchTheme((l) => {
    light = l;
    if (field) repaint(field, field.cards.keys());
  });

  scene.onEvaluate((p, dt) => {
    if (p >= MOUNT_LO && p <= MOUNT_HI && !shown) {
      field ??= buildField(light);
      for (const c of field.cards) {
        c.uOpacity.value = 0;
        field.group.add(c.mesh);
      }
      scene.addModelOverlay(field.group);
      shown = true;
    } else if (
      shown &&
      (p < MOUNT_LO - MOUNT_HYST || p > MOUNT_HI + MOUNT_HYST)
    ) {
      scene.removeModelOverlay(field!.group);
      shown = false;
    }
    if (!shown || !field) return false;
    const gather = cardGatherAt(clamp01((p - cdR.p0) / (cdR.p1 - cdR.p0)));
    // narrow frames shrink the orbit, not the cards
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
    // the spin only advances (and only requests frames) while a card shows
    if (lit) tAcc += dt;
    return lit;
  });

  return {
    /** Pre-upload the card textures, one card per tick. */
    warm() {
      for (const c of (field ??= buildField(light)).cards)
        if (!c.mesh.parent) scene.warmDraw([c.mesh]);
    },
  };
}
