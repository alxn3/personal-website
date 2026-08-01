import * as THREE from "three/webgpu";
import {
  attribute,
  clamp,
  color as colorNode,
  cos,
  floor,
  mix,
  normalLocal,
  positionLocal,
  atan,
  sin,
  smoothstep,
  texture,
  varying,
  vec2,
} from "three/tsl";
import { cardPhotoMix, CARD_ATLAS_GRID } from "./bloom";

// CARDIFY photo faces (materials/bloom.ts owns the geometry morph): as
// uCardify → 1 a card's OUTER face crossfades from the lens surface to a
// picture, UV = the card material coordinates (`_carduv`); the inner face takes
// a flat card-back tone. All cards sample ONE atlas texture (a GRID×GRID tile
// sheet), selected per wedge by the `_cardc` tile index — so the fill materials
// stay SHARED across wedges (shading.ts's program-count discipline) and the
// atlas survives every material rebuild (mode/theme switch) as a module-level
// singleton.
//
// REAL PHOTOS — the swap hook: call setCardPhoto(tile, image) with any
// CanvasImageSource (an <img> that has loaded, a canvas, a bitmap) to replace a
// placeholder tile in place; every card wearing that tile updates on the next
// frame. Tile indices are assigned outer-shell-first by assignCardAttributes
// (bloom.ts) and wrap modulo GRID² — the placeholder numeral on each card IS
// its tile index + 1, so "the card showing 3" swaps with setCardPhoto(2, img).

type Node = any;

const TILE = 512;
const GRID = CARD_ATLAS_GRID;

// warm site-palette tones for the placeholder gradients (global.css family)
const PLACEHOLDER_TONES = [
  ["#d18a5d", "#8a4d2b"], // terracotta
  ["#f1ecde", "#c9b98f"], // cream
  ["#a3a677", "#5f6f52"], // sage
  ["#d99a63", "#93401d"], // amber rust
];
const CARD_BACK = 0xddd2b8; // flat card-back tone (inner face) — a step darker
// than the page cream so backs still read as objects on the poster ground

let atlas: THREE.CanvasTexture | null = null;
let atlasCtx: CanvasRenderingContext2D | null = null;

function drawPlaceholder(ctx: CanvasRenderingContext2D, tile: number): void {
  const col = tile % GRID;
  // flipY texture ⇒ shader row r counts from the canvas BOTTOM
  const row = Math.floor(tile / GRID);
  const x = col * TILE;
  const y = (GRID - 1 - row) * TILE;
  const [a, b] = PLACEHOLDER_TONES[tile % PLACEHOLDER_TONES.length];
  const g = ctx.createLinearGradient(x, y + TILE, x + TILE, y);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, TILE, TILE);
  // big index numeral — makes tile → card mapping legible on sight
  ctx.fillStyle = "rgba(255, 250, 240, 0.85)";
  ctx.font = `700 ${TILE * 0.55}px Bitter, Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(tile + 1), x + TILE / 2, y + TILE * 0.52);
  // thin photo border
  ctx.strokeStyle = "rgba(30, 24, 16, 0.55)";
  ctx.lineWidth = 6;
  ctx.strokeRect(x + 10, y + 10, TILE - 20, TILE - 20);
}

/** The shared photo atlas (built lazily, kept for the page's lifetime). */
export function getCardAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TILE * GRID;
  atlasCtx = canvas.getContext("2d")!;
  for (let i = 0; i < GRID * GRID; i++) drawPlaceholder(atlasCtx, i);
  atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  // no mip chain: minified sampling of a mip-mapped CanvasTexture came back as
  // per-pixel garbage on WebGPU (the whole photo face rendered as two-tone
  // noise); plain linear filtering is clean and the tiles are large enough.
  atlas.generateMipmaps = false;
  atlas.minFilter = THREE.LinearFilter;
  return atlas;
}

/**
 * Swap one card's picture for a real photo: draws `source` into tile `tile`
 * (0-based; the placeholder numeral is tile + 1) and refreshes the atlas.
 * Call any time — before or after the scene builds its materials.
 */
export function setCardPhoto(tile: number, source: CanvasImageSource): void {
  getCardAtlas();
  const col = tile % GRID;
  const row = Math.floor(tile / GRID);
  atlasCtx!.drawImage(source, col * TILE, (GRID - 1 - row) * TILE, TILE, TILE);
  atlas!.needsUpdate = true;
}

/**
 * Wrap a fill material's color node with the cardify photo crossfade: returns
 * mix(base, cardFace, cardPhotoMix()) — the photo on the card's outer face, the
 * flat card-back tone on the inner face, selected by the REST normal's radial
 * sign (a material-coordinate quantity, so it holds in every deformed state).
 * Exact identity while uCardify = 0 (the mix factor is hard-gated to 0).
 * Only meaningful on bloom-carrying meshes (reads the `_card*` attributes).
 */
export function cardColorNode(base: Node): Node {
  const cuv = attribute("_carduv", "vec4") as Node; // (u, v, wEff, hEff)
  const cmeta = attribute("_cardc", "vec4") as Node;
  const tile = cmeta.x;
  const tcol = tile.mod(GRID);
  const trow = floor(tile.div(GRID).add(0.001));
  // photo x = v (axial — horizontal when the lens axis is), photo y = u (arc):
  // the gallery's cards read landscape along the axis (see bloom's CARD dims).
  // varying(): the whole atlas-uv is computed in the VERTEX stage — reading
  // `_cardc` from the fragment stage decoded as per-pixel garbage on WebGPU
  // (tile-channel visualization confirmed it; the same attribute reads clean
  // in the vertex stage) — and interpolating the finished uv is linear anyway.
  // both photo axes flipped (1 − v, 1 − u): tuned against the gallery pose —
  // unflipped, the camera-facing cards showed their pictures rotated 180°
  const uv = varying(
    vec2(
      tcol.add(clamp(cuv.y, 0.0, 1.0).oneMinus()).div(GRID) as Node,
      trow.add(clamp(cuv.x, 0.0, 1.0).oneMinus()).div(GRID) as Node,
    ),
  ) as Node;
  const photo = ((texture(getCardAtlas(), uv) as Node).level(0) as Node).rgb;
  // outer/inner face from the REST radial normal (side walls shade card-edge
  // between the two — they are a fraction of a millimetre anyway)
  const p = positionLocal as Node;
  const n = normalLocal as Node;
  const theta = atan(p.z, p.x) as Node;
  const nRad = n.x.mul(cos(theta)).add(n.z.mul(sin(theta))) as Node;
  // biased toward the photo: only clearly INWARD-facing surfaces (the true
  // inner wall) take the back tone — rib/knurl sides (radial ≈ 0) must show
  // the picture, or the grips' hundreds of micro-facets fleck the card face.
  const face = mix(
    colorNode(new THREE.Color(CARD_BACK)) as Node,
    photo,
    smoothstep(-0.6, -0.25, nRad) as Node,
  );
  return mix(base, face, cardPhotoMix());
}
