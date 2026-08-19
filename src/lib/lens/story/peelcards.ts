// THE PEEL AND THE CARD FIELD, and ONE MOTION across them: the shell peels off
// like a sticker (ops/house stickerPeelOps), the curl hands the wedge over
// mid-flight to the departure (story/envelopes.ts CARDS_APART, which owns that
// half), the outer layers unwrap and fly off, and each cast winks away as it
// goes. The mechanism under them never moves and is never hidden — the scene
// ends on exactly what it has been revealing.
//
// This module owns the unroll channel and its release, the lens' own roll, the
// wink's window, and the card field.
//
// TWO CLOCKS: scroll (frame(p)) owns the unroll channel, value AND target, so a
// scrub lands on the same pose either way; TIME (scene.onFrame) owns only the
// card shell's rotation, off an accumulated dt — never performance.now(), which
// would teleport the field across a pause.
//
// The unroll and the departure are two unwrap chains on one wedge and the
// deform host SUMS recipe deltas, so the hand-off is a CROSSFADE whose channel
// sum stays near 1 — no rest frame. That the composed FOLD stays under the
// larger single one is a per-piece bound, measured in
// story/__tests__/piece-flow.test.ts.
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
import { clamp01, deg, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { atFrac, rangeOf } from "./story";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");

/** Scene-local fraction of `p`, clamped — every law below is written in it. */
const localOf = (r: { p0: number; p1: number }, p: number) =>
  clamp01((p - r.p0) / (r.p1 - r.p0));

// --- the choreography numbers ----------------------------------------------
// All windows are in the fraction of the scene named on the line.

/** peel: the unroll. Both edges saturate, so the channel is a hard 0 through
 *  the camera's transit into the scene and a hard 1 well before it leaves. The
 *  scene's remaining fractions belong to SPIN below. */
const PEEL_ROLL: [number, number] = [0.02, 0.45];
/** cards: the unroll's RELEASE, and the FIRST HALF OF ONE MOTION. It opens on
 *  the same frame as the departure (story/envelopes.ts CARDS_APART) and closes
 *  just inside it, so the curl hands the wedge over mid-flight: the two chains
 *  cross, their sum stays near 1, and no frame sits at rest between them.
 *  `RELEASE_SPAN` is the same window in absolute p. */
const PEEL_RELEASE: [number, number] = [0.04, 0.36];
// --- THE SPIN --------------------------------------------------------------
// One normalized shape with one consumer: the lens' rigid roll about the bore
// (peelRollAt → hero-driver's single setModelOrientation writer). Rigid, so it
// turns the seat, the unroll and the departure together and no radius moves.

/** peel: where the spin opens — deliberately NOT at a beat boundary. What
 *  separates the curl from the turn is the RAMP, which leaves here at rate
 *  exactly 0; later, and the wind-up would run under the crossfade. */
const SPIN_START = 0.32;
/** cards: where it is spent — inside the departure, so the lens is still
 *  turning as the layers leave and still by the time the field has it. */
const SPIN_END = 0.55;
/** cards: the roll settles ON SCREEN — nothing hides a rate step in this scene
 *  any more, so the ramp is a smoothstep: 0 rate at both edges. */
/** WHOLE TURNS the lens body makes over the span, SIGNED — negative is the
 *  peel's own winding direction (ops/house WRAP_DIR), so the spin carries on
 *  the way the sides came off. It MUST stay an integer: peelRollAt drops to
 *  exactly 0 past SPIN_END, and a whole number of turns makes that drop an
 *  identity rather than a snap. */
const SPIN_TURNS = -2;
// --- THE WINK ---------------------------------------------------------------
// THE CARDS SCENE NO LONGER FADES THE LENS OUT. The outer layers unwrap, fly
// off and wink away one cast at a time; the mechanism under them is never
// hidden and never moves (the departure is scoped off it — ops/recipes.ts
// `keepScope`), so the internals scene opens on exactly what the cards scene
// has been showing all along. hero-driver holds setBodyFade at 1 for the whole
// span below the dive.

/** THE SHELL'S AND THE INTERIOR'S WINK — hero-driver writes both gates on this
 *  one window, IN PLAIN SIGHT. It trails the departure's own rise so a piece
 *  goes out while it is far from the lens and small, and core/scene's per-mesh
 *  thresholds order the casts outside-in, the same order the departure has. It
 *  must be spent before story/envelopes.ts CARDS_APART's fall, which is what
 *  makes that fall invisible. */
export const WINK_SPAN: [number, number] = [
  atFrac(cdR, 0.42),
  atFrac(cdR, 0.62),
];

/** cards: card k's fade-in window, offset by k·CARD_STAGGER — the field comes
 *  up as the layers leave, around the mechanism rather than over it. */
const CARD_FADE_START = 0.3;
const CARD_FADE_HELD = 0.52;
/** cards: the LAST card is fully out by here — what sets the stagger below */
const CARD_FADE_DONE = 0.6;

/** cards: the field's own fade-out — the mechanism it has been orbiting is
 *  what the scene ends on, and what the internals scene opens by taking apart. */
const CARDS_OUT: [number, number] = [0.7, 0.88];

export const CARD_COUNT = 8;
/** the stagger falls out of the deadline: eight windows fanned between
 *  CARD_FADE_HELD and CARD_FADE_DONE, so card 7 completes exactly at 0.98 */
const CARD_STAGGER = (CARD_FADE_DONE - CARD_FADE_HELD) / (CARD_COUNT - 1);

/** card size in world units, BEFORE the per-card scale below (the lens is ≈ 3
 *  wu across, the story camera ≈ 15 wu out) */
const CARD_SIZE: [number, number] = [1.6, 2.0];
/** per-card size, as a multiple of CARD_SIZE, by k mod 3 — what keeps two cards
 *  passing at the same depth from reading as one card printed twice. */
const CARD_SCALE0 = 0.85;
const CARD_DSCALE = 0.175;

/** THE SHELL'S RADIUS, world units — a SPHERE, not a ladder of hoops: every
 *  card sits at exactly this distance (cardOrbitAt is an identity, not a
 *  bound), so it clears the model, whose bounding sphere is ≈ 2.56 wu. */
const SHELL_R = 5.2;
/** ONE COHERENT RATE, rad/s, ONE direction, shared by all eight — the field is
 *  a rigid shell that turns, not eight orbits; per-card variation of any kind
 *  shears it apart over a long hold. Chosen for the HOLD, since it cannot match
 *  the lens' own spin (which runs on the scroll and stops when the reader
 *  does): slow enough to read the titles by, fast enough to read as motion. */
const SHELL_RATE = 0.9;
/** how far up and down the axis the eight stations reach, as a fraction of the
 *  radius. Short of 1 so no card parks on a POLE, where a rotation about the
 *  axis would leave it dead still. */
const SHELL_LAT = 0.78;

/** wedges per segmented shell family in the shipped GLBs */
export const SEG_COUNT = 5;

/** The gltf-frame angle (atan2(z, x) in the radial plane) of `Seg0`'s seated
 *  sector centre. The wedge ring is cut into SEG_COUNT equal sectors and the
 *  index runs the OTHER WAY round the axis, hence the minus below. Taken off
 *  the shipped GLB's wedge bounding boxes; __tests__/peelcards.test.ts
 *  re-measures the GLB against this law, so a re-export that re-cuts the seams
 *  fails there rather than in a scroll nobody re-checks. */
const SEG0_ANGLE = deg(-65.9);

/** The seated sector direction of shell wedge `seg`, as an angle in the gltf
 *  radial plane (x = cos, z = sin). */
export const segSectorAngle = (seg: number): number =>
  SEG0_ANGLE - (seg * 2 * Math.PI) / SEG_COUNT;

// --- the laws ---------------------------------------------------------------

/** The `peel` channel's UNROLL, in peel-local fraction. */
export const peelChannelAt = (local: number): number =>
  smoothstep(PEEL_ROLL[0], PEEL_ROLL[1], local);

/** The unroll's release, in CARDS-local fraction: 1 = fully released. */
const peelReleaseAt = (local: number): number =>
  smoothstep(PEEL_RELEASE[0], PEEL_RELEASE[1], local);

/** THE WHOLE `peel` CHANNEL at story position `p` — the unroll, released again
 *  over the cards scene. Zero everywhere outside those two scenes, so no other
 *  span on the page ever sees the recipe driven. */
export const peelValueAt = (p: number): number =>
  peelChannelAt(localOf(peR, p)) * (1 - peelReleaseAt(localOf(cdR, p)));

/** THE SPIN'S SPAN in absolute story p, [open, spent]. Exported so the tests
 *  pin the shape's laws against the window itself, leaving SPIN_START/SPIN_END
 *  free to be retuned. */
export const SPIN_SPAN: [number, number] = [
  atFrac(peR, SPIN_START),
  atFrac(cdR, SPIN_END),
];
/** The unroll's RELEASE in absolute story p, for the same reason. */
export const RELEASE_SPAN: [number, number] = [
  atFrac(cdR, PEEL_RELEASE[0]),
  atFrac(cdR, PEEL_RELEASE[1]),
];
/** THE SPIN'S SHAPE at story position `p`, normalized 0 → 1 over SPIN_SPAN. A smoothstep, so the rate is 0
 *  at BOTH edges: the roll spins up and settles in plain sight. */
export const peelSpinAt = (p: number): number =>
  smoothstep(SPIN_SPAN[0], SPIN_SPAN[1], p);

/** THE LENS' OWN ROLL over the peel, radians about the OPTICAL AXIS — added to
 *  story/reveal.ts's `revealRollAt` in hero-driver's ONE setModelOrientation
 *  call, and disjoint from it in p. Exactly 0 at both edges: below the window
 *  literally, past it because SPIN_TURNS makes the drop an identity. */
export const peelRollAt = (p: number): number =>
  p >= SPIN_SPAN[1] ? 0 : SPIN_TURNS * 2 * Math.PI * peelSpinAt(p);

/** Card k's opacity from the cross-fade alone, in CARDS-local fraction. */
export const cardFadeAt = (k: number, local: number): number =>
  smoothstep(
    CARD_FADE_START + k * CARD_STAGGER,
    CARD_FADE_HELD + k * CARD_STAGGER,
    local,
  );

/** How far the field has faded OUT, in CARDS-local fraction: 1 = gone. */
export const cardsFadeOutAt = (local: number): number =>
  smoothstep(CARDS_OUT[0], CARDS_OUT[1], local);

/** Card k's size, as a multiple of CARD_SIZE. */
export const cardScaleAt = (k: number): number =>
  CARD_SCALE0 + CARD_DSCALE * (k % 3);

/** THE CARD ROLL — screen-plane only: it turns the billboard's corner offsets
 *  about the view axis, the ONE rotation a billboard may have under the 2D law.
 *  A card comes off tipped over, rights itself over its own fade window (so a
 *  scrub replays it) and settles at a small per-card residual. NO IDLE SWAY: a
 *  pure function of the scroll, since a second time-based wobble over the
 *  shell's own turn reads as aimless. */
const ROLL_ENTRY = deg(15);
const ROLL_REST = deg(3.2);
export const cardRollAt = (k: number, cardsLocal: number): number => {
  const sign = k % 2 === 0 ? 1 : -1;
  const entry = ROLL_ENTRY * sign * (1 + 0.25 * ((k % 3) - 1));
  const rest = ROLL_REST * sign * (1 + 0.3 * ((k % 4) - 1.5));
  return entry + (rest - entry) * cardFadeAt(k, cardsLocal);
};

/** Card k's LONGITUDE on the shell, at rest — SEEDED FROM THE SHELL'S SEAMS:
 *  the first five cards start where the five strips left, the last three
 *  halfway between. The frame conversion: a sector's gltf radial direction
 *  (cos θ, ·, sin θ) lands on world (−sin θ, −cos θ) in Y–Z under core/scene's
 *  two model rolls, and the shell is written y = r·cos φ, z = r·sin φ — so
 *  φ = −(θ + π/2) puts the card on the strip's own meridian. */
const cardPhaseAt = (k: number): number =>
  -(segSectorAngle(k % SEG_COUNT) + Math.PI / 2) +
  (k >= SEG_COUNT ? Math.PI / SEG_COUNT : 0);

/** Card k's LATITUDE on the shell, as a fraction of the radius: eight stations
 *  evenly spread over [−SHELL_LAT, +SHELL_LAT]. The midpoint form
 *  ((2k+1)/n − 1) keeps both ends off the poles, where a card would sit still
 *  under the rotation. */
const cardLatAt = (k: number): number =>
  SHELL_LAT * ((2 * k + 1) / CARD_COUNT - 1);

/** Card k's centre at accumulated time `tMs`, world units — a pure function of
 *  (k, t), so the field is reproducible frame to frame and in tests.
 *
 *  A SPHERICAL SHELL THAT TURNS AS ONE: every card sits at exactly SHELL_R from
 *  the lens centre on its own latitude and longitude, and the whole shell
 *  revolves about the OPTICAL AXIS at one rate in one direction, so each card
 *  runs the latitude circle its station sits on. Occlusion is free — half the
 *  shell is behind the lens and hidden by it (depthWrite, buildField). */
export const cardOrbitAt = (
  k: number,
  tMs: number,
): { x: number; y: number; z: number } => {
  const lat = cardLatAt(k);
  const ring = SHELL_R * Math.sqrt(1 - lat * lat);
  const phi = cardPhaseAt(k) + SHELL_RATE * (tMs / 1000);
  return {
    x: SHELL_R * lat,
    y: ring * Math.cos(phi),
    z: ring * Math.sin(phi),
  };
};

// --- the card faces ---------------------------------------------------------

/** Face palette, from LensStory.astro's stage vars: the cards are paper on the
 *  paper stage and ink on the dark one, so they read as part of the same
 *  drawing rather than as pasted-on photographs. */
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
/** the frame's matte — the even border around the photo, in face pixels. Square
 *  corners, and the matte colour is THEME paper rather than a fixed white. */
const FACE_BORDER = 20;
/** the strip under the photo that carries the title */
const FACE_TITLE_STRIP = 86;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** THE LABEL TYPE — one recipe for every small caption in the scene family: the
 *  card titles here and the star-atlas names (story/constellations.ts) wear the
 *  same uppercase tracked mono. Weight/tracking here; size per painter. */
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

/** One card's face texture — the canvas is KEPT so a theme flip can repaint it
 *  in place (a fresh CanvasTexture would mean re-binding the material's texture
 *  node; `needsUpdate` re-uploads the same one). */
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

/** Build the eight quads. Cheap and synchronous: one shared geometry, one
 *  material and one canvas per card, no GPU work until the first draw. */
function buildField(light: boolean): Field {
  // ±1 corners, so the vertexNode's corner offset IS the half-size
  const geo = new THREE.PlaneGeometry(2, 2);
  const group = new THREE.Group();
  group.name = "Lens_CardField";
  const cards: Card[] = [];
  for (let k = 0; k < CARD_COUNT; k++) {
    const { canvas, tex } = buildFace(k, light);
    // each card carries its own half-size (cardScaleAt) — a constant per graph,
    // so it costs a uniform and nothing per frame
    const s = cardScaleAt(k);
    const uHalf = uniform(
      new THREE.Vector2((CARD_SIZE[0] * s) / 2, (CARD_SIZE[1] * s) / 2),
    );
    const uCentre = uniform(new THREE.Vector3());
    const uOpacity = uniform(0);
    const uRollCS = uniform(new THREE.Vector2(1, 0));
    const mat = new THREE.MeshBasicNodeMaterial();
    // THE BILLBOARD (as optics/starfield.ts starMark): the centre goes to VIEW
    // space through modelViewMatrix, the corner is added there in view-space
    // world units, and only then does the projection run — so the quad has no
    // orientation of its own and stays parallel to the film plane at any camera
    // angle. The roll turns the corner offsets in that same view plane.
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
    // alpha in diffuseColor.a, which three multiplies by the opacity node —
    // squaring the corners for nothing.
    mat.colorNode = face.rgb;
    mat.opacityNode = face.a.mul(uOpacity);
    mat.transparent = true;
    // DEPTH IS THE POINT: a card behind the lens must be hidden by it, and
    // alphaTest keeps faded cards and corners out of the depth buffer.
    mat.depthWrite = true;
    mat.alphaTest = 0.02;
    // the field is looked at from anywhere in the story, so culling a back face
    // would only ever cost a card
    mat.side = THREE.DoubleSide;
    // Flat ink, not a lit surface (the 2D/3D design law).
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    // the geometry sits at the origin and the real position is a uniform, so
    // three's bounding sphere means nothing here
    mesh.frustumCulled = false;
    group.add(mesh);
    cards.push({ mat, canvas, tex, uCentre, uOpacity, uRollCS });
  }
  return { group, geo, cards };
}

// --- the module -------------------------------------------------------------

/** dt clamp, ms — story/internals.ts's number, for its reason */
const DT_CLAMP_MS = 100;

/** Run `cb` when the page has a moment, and no later than the timeout. */
const atIdle = (cb: () => void) => {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(cb, { timeout: 1000 });
  else setTimeout(cb, 200);
};
/** THE SHOW WINDOW, in absolute story p. It opens a whole scene EARLY (the
 *  quads draw at opacity 0 and alphaTest discards every pixel until the fades
 *  open) and closes at the cards scene's end, so nothing is drawn into the scene
 *  that hands to the fly-through. Exported because story/cost.ts counts the
 *  field's draws at p and may not spell the window twice. */
export const MOUNT_LO = rangeOf("zoom").p0;
export const MOUNT_HI = cdR.p1;
/** scroll-p slack past each mount edge, so a scrub parked exactly on one cannot
 *  thrash build/dispose */
export const MOUNT_HYST = 0.02;

export function createPeelCards(scene: SceneHandle): {
  warm(): void;
  frame(p: number): void;
} {
  /** BUILT ONCE AND KEPT FOR THE PAGE: the eight faces are canvases, textures
   *  and materials, and re-uploading them was the whole cost of re-entering the
   *  window. Leaving it takes the group off the overlay and nothing else. */
  let field: Field | null = null;
  let shown = false;
  let light = isLightTheme();
  let tAcc = 0;
  let last = performance.now();

  // The photos load AT BOOT, not at mount: a decode + texture upload landing
  // mid-peel is a visible hitch in the story's busiest animation.
  //
  // A STRAGGLER REPAINTS AT IDLE, AND THEY BATCH: arrivals are a third party's
  // schedule, so eight of them repainting as they land is eight uploads on
  // eight unpredictable frames. One idle pass takes whatever has arrived.
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
    // the retained opacities are the ones it left on; the frame callback
    // rewrites them only after this frame's render
    for (const c of f.cards) c.uOpacity.value = 0;
    scene.addOverlay(f.group);
    shown = true;
  }

  function hide() {
    if (!shown || !field) return;
    scene.removeOverlay(field.group);
    shown = false;
  }

  // Theme flips repaint the faces IN PLACE (same canvas, same texture object),
  // shown or not — the field outlives its window.
  watchTheme((l) => {
    light = l;
    if (!field) return; // not built yet — it builds at the live theme
    for (let k = 0; k < CARD_COUNT; k++) {
      paintFace(field.cards[k].canvas, k, light);
      field.cards[k].tex.needsUpdate = true;
    }
    scene.invalidate();
  });

  // THE ORBIT AND THE OPACITIES, on time. Registered for the life of the page;
  // until the field mounts it costs one clamp and one compare.
  scene.onFrame(() => {
    const now = performance.now();
    tAcc += Math.min(DT_CLAMP_MS, now - last);
    last = now;
    if (!shown || !field) return; // resident but off the overlay: nothing draws
    // THE SCROLL p, NOT THE EASED CHANNEL — see story/internals.ts: this
    // callback and the scroll side of the module must gate on ONE p.
    const p = scene.state.storyTarget;
    const cardsLocal = localOf(cdR, p);
    const alive = 1 - cardsFadeOutAt(cardsLocal);
    for (let k = 0; k < CARD_COUNT; k++) {
      const c = field.cards[k];
      const o = cardOrbitAt(k, tAcc);
      c.uCentre.value.set(o.x, o.y, o.z);
      c.uOpacity.value = cardFadeAt(k, cardsLocal) * alive;
      const roll = cardRollAt(k, cardsLocal);
      c.uRollCS.value.set(Math.cos(roll), Math.sin(roll));
    }
  });

  return {
    /** Build the eight faces and pay their upload off the gesture. A photo that
     *  lands later repaints its own face, as it does at any other time. */
    warm() {
      scene.warmDraw([ensureField().group]);
    },
    frame(p) {
      // THE UNROLL CHANNEL, value AND target: a pure function of the scroll, so
      // a scrub either way lands on the same pose and the ease can never chase
      // a stale target.
      const peel = peelValueAt(p);
      scene.state.peel = peel;
      scene.state.peelTarget = peel;

      if (p >= MOUNT_LO && p <= MOUNT_HI) show();
      else if (p < MOUNT_LO - MOUNT_HYST || p > MOUNT_HI + MOUNT_HYST) hide();
    },
  };
}
