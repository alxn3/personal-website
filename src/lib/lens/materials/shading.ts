import * as THREE from "three/webgpu";
import { uniform, float } from "three/tsl";
import {
  hasBloom,
  attachBloom,
  attachBloomLine,
  attachBloomHull,
  bloomEdgeGeometry,
  cardPhotoMix,
  uIsolateHide,
} from "./bloom";
import { cardColorNode } from "./cards";
// Non-bloom materials get the genie minimize warp directly (the bloom graph
// composes it itself for the wedges) — every mode's build sites below pair
// `attachBloom` (bloom) with `attachGenie` (everything else) so the WHOLE
// model funnels, glass and solid rings included.
import { attachGenie } from "./genie";
import { depthFadeFactor } from "./depthfade";
import { isOpticalGlass, isDecal } from "../core/parts";
import {
  color as colorNode,
  dot,
  clamp,
  floor,
  mix,
  normalView,
  normalLocal,
  positionLocal,
  vec3,
} from "three/tsl";

// CEL SHADE: quantized N·L against a fixed key light — three flat bands that
// give the unlit ink fills FORM (pop) without abandoning the blueprint look.
// Uses the transformed normal, so bloom-deformed wedges band correctly as they
// peel and wrap. Fresh node per material.
const CEL_LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
const celShade = () => {
  const ndl = dot(
    normalView as any,
    vec3(CEL_LIGHT.x, CEL_LIGHT.y, CEL_LIGHT.z) as any,
  )
    .mul(0.5)
    .add(0.5) as any;
  const band = clamp(floor(ndl.mul(3.0)), 0.0, 2.0).div(2.0) as any;
  return float(0.78).add(band.mul(0.38)) as any; // 0.78 · 0.97 · 1.16
};

// Ink fill opacity, 0 = pure wireframe (edge lines only) → 1 = solid toon fills.
// The scroll hero drives this so the intro reads as a blueprint that fills in.
export const uInkFill = uniform(1);

// Swappable render styles for the lens viewer, as Node materials (WebGPU). Each
// mode re-materials every mesh; "realistic" restores the originals captured at
// load. Wedge/decal meshes (those carrying the `_bloom` attributes) get the
// bloom position/normal graph attached so they still deform in every mode.
// Textures (toon ramp, matcap) are generated procedurally — nothing external.
export type ShadingMode =
  | "realistic"
  | "ink"
  | "blueprint"
  | "flat"
  | "outline"
  | "ember"
  | "paper"
  | "riso"
  | "bronze"
  | "toon"
  | "clay"
  | "wire";

// isOpticalGlass (core/parts): true optical glass only — the lens elements and
// the UV filter. NOT the iris blades (they're metal; they were previously
// mis-matched by an `Iris_` prefix).

// A technical-drawing palette: flat fill colours keyed by part name (one
// variant per SITE THEME) plus the edge-line colour pairs. "ink", "blueprint"
// and "flat" run ONE shared construction in set() — a palette entry (plus the
// optional flat/threshold knobs) is all that distinguishes them, so another
// technical look is one new entry here, a ShadingMode union member, and a page
// button.
interface TechnicalPalette {
  fill(name: string, light: boolean): number;
  edgeBody: { dark: number; light: number };
  edgeGlass: { dark: number; light: number };
  /** true = skip the cel bands entirely: pure unlit fills (the "flat" look). */
  flat?: boolean;
  /** EdgesGeometry crease angle; higher = fewer lines (default 24). */
  edgeThresholdDeg?: number;
  /** parts whose edge lines are dropped entirely (beyond the decal skip). */
  lineSkip?: (name: string) => boolean;
}

const TECHNICAL_PALETTES: Partial<Record<ShadingMode, TechnicalPalette>> = {
  // Blueprint/"ink" flat fills — a technical palette keyed by part name, one
  // variant per SITE THEME. Dark theme: the body shells sit near-black so the
  // bright edge lines carry the drawing. Light theme: the relationship INVERTS —
  // paper-light shells, dark sepia line-work (pencil-on-paper), same accent
  // logic. Accents stay on the MECHANISM only: amber focus drivetrain
  // (motor/screw/rods — matches the site accent and the refraction rays), brass
  // contacts, blued-steel iris, slate grips. The GLASS is one uniform green —
  // every element the same (owner: no per-element colour coding; the focusing
  // element reads via its amber drivetrain instead).
  ink: {
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x6fa863; // deeper mint — a 0.45-opacity fill must read on paper
        if (/^Iris_Blade/.test(name)) return 0x5b6478;
        if (isDecal(name)) return 0x3f3a2f; // printed text goes DARK on light shells
        if (/^Mount_Contacts/.test(name)) return 0xb08428;
        if (/^Mount_/.test(name)) return 0x7c766a;
        if (/^Focus_/.test(name)) return 0xa8672e;
        if (/^PCB_/.test(name)) return 0x5d7a48;
        if (/Ring_/.test(name)) return 0x4a4f5e; // rubber grips stay dark — real rubber is
        if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xe3ddcc; // gloss body
        return 0xece6d6; // matte body — paper-light so the dark outlines pop
      }
      if (isOpticalGlass(name)) return 0x9ccb92; // mint-green glass — uniform across elements
      if (/^Iris_Blade/.test(name)) return 0x4b5364; // blued-steel aperture blades
      if (isDecal(name)) return 0xefe8d4; // white printed text
      if (/^Mount_Contacts/.test(name)) return 0xd9a852; // bright brass contacts
      if (/^Mount_/.test(name)) return 0x9a9482; // chrome / metal
      if (/^Focus_/.test(name)) return 0xc5813f; // focus motor/screw/rods — amber metal
      if (/^PCB_/.test(name)) return 0x6d8a55; // circuit-board green
      if (/Ring_/.test(name)) return 0x343846; // rubber grip rings — dark slate
      if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0x2c2720; // gloss body
      return 0x211d16; // matte body — near-black so the outlines pop
    },
    // Ink edge-line colours: glass gets the green accent; the body lines are bright
    // warm white on the dark stage, dark sepia ink on the light one.
    edgeBody: { dark: 0xe4dbc4, light: 0x2f2a20 },
    edgeGlass: { dark: 0xc9e6bb, light: 0x3f6b39 },
  },

  // BLUEPRINT variant of the ink look. Dark theme: classic cyanotype — deep
  // drafting blues, white line-work. Light theme: pencil-drafting — pale blue
  // paper, deep blue line-work. Same construction as ink (window dissolve, depth
  // fade, cel bands), different palette.
  blueprint: {
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x5b8fbd;
        if (isDecal(name)) return 0x24435f;
        if (/^(Mount_Contacts|Focus_)/.test(name)) return 0x35648f; // lifted accents
        if (/Ring_|Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xc4d3e2;
        return 0xd3dfec; // pale drafting-paper ground
      }
      if (isOpticalGlass(name)) return 0x7fb4d8; // pale drafting blue glass
      if (isDecal(name)) return 0xe8f0f8; // white printed text
      if (/^(Mount_Contacts|Focus_)/.test(name)) return 0x4f7ba6; // lifted accents
      if (/Ring_|Band_Mid|Barrel_Base|Chassis/.test(name)) return 0x14263d;
      return 0x0f1e31; // deep blueprint ground
    },
    edgeBody: { dark: 0xdbe9f7, light: 0x1e3a57 },
    edgeGlass: { dark: 0xb7d9ef, light: 0x2c567c },
  },

  // FLAT: the vector-illustration trim of ink — the same fill/line construction
  // with the cel bands OFF (pure unlit fills) and a higher crease threshold so
  // only the silhouette + major structural edges survive. Three flat tones per
  // theme (shell, grip/iris band, muted metal) + the uniform mint glass and the
  // decal print — a printed diagram, not a shaded drawing. Used by the Prism
  // demo's 2D beat; also a bench button.
  flat: {
    flat: true,
    edgeThresholdDeg: 40,
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x6fa863; // ink's mint — uniform
        if (isDecal(name)) return 0x3f3a2f; // printed text goes dark on cream
        if (/^Iris_Blade|Ring_/.test(name)) return 0x4a4f5e; // ink's slate bands
        if (/^(Mount_|Focus_|PCB_)/.test(name)) return 0x7c766a; // muted metal
        return 0xece6d6; // ONE cream shell tone — no gloss/matte split
      }
      if (isOpticalGlass(name)) return 0x9ccb92;
      if (isDecal(name)) return 0xefe8d4;
      if (/^Iris_Blade|Ring_/.test(name)) return 0x343846;
      if (/^(Mount_|Focus_|PCB_)/.test(name)) return 0x9a9482;
      return 0x211d16;
    },
    // the ribbed bands hatch when every rib gets stroked — their form is
    // carried by fill contrast, so flat drops their lines entirely
    lineSkip: (name) => /^(Ring_Zoom|Ring_Focus|Band_Mid)/.test(name),
    // ink's line pairs — the outline language stays the house one
    edgeBody: { dark: 0xe4dbc4, light: 0x2f2a20 },
    edgeGlass: { dark: 0xc9e6bb, light: 0x3f6b39 },
  },

  // EMBER: bold orange ink on near-black paper. The palette IS dark, so both
  // site themes share one family — the light theme only lifts the body ground a
  // hair so the stage still separates from a light page behind it. Accents stay
  // on the mechanism like ink's (focus drivetrain + contacts hottest, iris a
  // deep rust, grips near-black), glass one uniform warm amber.
  ember: {
    fill(name: string, light: boolean): number {
      if (isOpticalGlass(name)) return 0xe08a4f; // warm amber glass — uniform
      if (/^Iris_Blade/.test(name)) return 0x93401d; // deep-rust blades
      if (isDecal(name)) return 0xffb489; // printed text glows pale orange
      if (/^Mount_Contacts/.test(name)) return 0xffa14e;
      if (/^Mount_/.test(name)) return 0x6f4a35;
      if (/^Focus_/.test(name)) return 0xff7a2e; // hottest accent — the drivetrain
      if (/^PCB_/.test(name)) return 0x83492a;
      if (/Ring_/.test(name)) return 0x382216; // rubber grips stay near-black
      if (/Band_Mid|Barrel_Base|Chassis/.test(name))
        return light ? 0x2a1c12 : 0x241811; // gloss body
      return light ? 0x231710 : 0x1c120b; // matte body — the near-black paper
    },
    edgeBody: { dark: 0xff5c1f, light: 0xf25818 }, // the bold orange ink
    edgeGlass: { dark: 0xffa96b, light: 0xf09a5a },
  },

  // PAPER: near-black ink on white paper, with ONE saturated orange accent
  // carried by the glass edge lines + the mechanism fills — everything else is
  // achromatic warm gray so the accent reads as THE color. Dark site theme is
  // the same look dimmed a step (a full-white slab would blast on the stage).
  paper: {
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x8f8879; // warm-gray glass — reads at 0.45 on white
        if (/^Iris_Blade/.test(name)) return 0x3a372f;
        if (isDecal(name)) return 0x1f1b15; // printed text = the ink
        if (/^Mount_Contacts/.test(name)) return 0xe8590f; // the saturated accent
        if (/^Mount_/.test(name)) return 0xbdb6a9;
        if (/^Focus_/.test(name)) return 0xe8590f; // accent — the drivetrain
        if (/^PCB_/.test(name)) return 0x8c8574;
        if (/Ring_/.test(name)) return 0x2e2a24; // rubber grips — near-ink
        if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xefe9dd; // gloss body
        return 0xf8f4ea; // matte body — the white paper
      }
      if (isOpticalGlass(name)) return 0x87806f;
      if (/^Iris_Blade/.test(name)) return 0x35322a;
      if (isDecal(name)) return 0x1c1812;
      if (/^Mount_Contacts/.test(name)) return 0xd8520e;
      if (/^Mount_/.test(name)) return 0xafa89a;
      if (/^Focus_/.test(name)) return 0xd8520e;
      if (/^PCB_/.test(name)) return 0x807966;
      if (/Ring_/.test(name)) return 0x2a2620;
      if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xddd6c8;
      return 0xe9e3d6; // dimmed paper for the dark stage
    },
    edgeBody: { dark: 0x17130d, light: 0x14100b }, // near-black ink lines
    edgeGlass: { dark: 0xff4d0f, light: 0xff4d0f }, // the saturated orange accent
  },
};

// Backdrop color pairs matched to the wipe-capable palettes, for the wipe
// split plane (materials/wipe.ts uWipeBgBelow/uWipeBgTo via setWipeBackdrop):
// `below` = the stage behind the already-wiped (seated) region, `to` = above
// the advancing line. Kept here so a palette tweak updates its backdrop in the
// same diff; wave agents pick the pair for whatever palette the wipe lands on.
export const WIPE_BACKDROPS: Partial<
  Record<ShadingMode, { below: number; to: number }>
> = {
  ember: { below: 0x160d07, to: 0xff5c1f },
  paper: { below: 0xf8f4ea, to: 0x17130d },
};

// OUTLINE: thick screen-print contour — a constant-width inverted-hull outline
// (silhouette + every depth step) over pure UNLIT two-tone fills, cream/ink from
// the house palette. Deliberately the anti-x-ray: NOTHING is transparent — the
// glass renders as solid flat discs wearing the same outline. The hull width is
// model-mm, so the line reads bolder as the lens fills the frame (a printed
// object, not a UI stroke). Fill tones sit a step off the line tone so the
// contour still reads where it crosses a same-family fill.
const OUTLINE_WIDTH = 0.8; // model mm
const OUTLINE = {
  light: {
    line: 0x211c14, // near-black ink contour
    body: 0xf0e9d8, // cream shells
    detail: 0x3f3a2f, // grips / iris / mechanism — the ink half of the two-tone
    glass: 0x4a4437, // solid discs, a step off the detail ink
    decal: 0x211c14,
  },
  dark: {
    line: 0xf2ead6, // cream contour on the dark stage
    body: 0x27221a, // ink shells — the cream line carries the silhouette
    detail: 0xcdc4ab, // cream mechanism
    glass: 0xbfb59a,
    decal: 0xf2ead6,
  },
};

function outlineFill(p: (typeof OUTLINE)["light"], name: string): number {
  if (isDecal(name)) return p.decal;
  if (isOpticalGlass(name)) return p.glass;
  if (/^Iris_Blade|Ring_|^Focus_|^Mount_|^PCB_/.test(name)) return p.detail;
  return p.body;
}

// RISO: duotone risograph print — two ink passes on poster stock, hard 3-step
// N·L posterization, NO outlines (the flat banding carries all the form).
// Light theme = orange + near-black ink on cream stock (orange holds the
// midtone, so it dominates). Dark theme = the same poster run on black stock:
// bright orange ink carries the highlights over a burnt-orange mid, the paper
// itself is the shadow. `decal` is the flat un-banded print color for the
// engraved text; the glass is a translucent orange OVERPRINT (ink over ink).
const RISO = {
  light: { shadow: 0x241d18, mid: 0xe8551a, lit: 0xf2e8cf, decal: 0x241d18 },
  dark: { shadow: 0x1b1512, mid: 0xc23e12, lit: 0xff6a2a, decal: 0xf2e8cf },
};

// Hard 3-band posterize of N·L across the three ink stops — same quantization
// as celShade, but SELECTING flat colors instead of scaling one.
function risoBands(stops: { shadow: number; mid: number; lit: number }) {
  const ndl = dot(
    normalView as any,
    vec3(CEL_LIGHT.x, CEL_LIGHT.y, CEL_LIGHT.z) as any,
  )
    .mul(0.5)
    .add(0.5) as any;
  const b = clamp(floor(ndl.mul(3.0)), 0.0, 2.0) as any;
  return mix(
    mix(
      colorNode(new THREE.Color(stops.shadow)) as any,
      colorNode(new THREE.Color(stops.mid)) as any,
      clamp(b, 0.0, 1.0) as any,
    ) as any,
    colorNode(new THREE.Color(stops.lit)) as any,
    clamp(b.sub(1.0), 0.0, 1.0) as any,
  ) as any;
}

// BRONZE: molten-metal dark-studio matcap — hot gold core into copper and
// terracotta-bronze falloff, plus a low warm rim from the lower right so the
// dark side separates from the stage. The light theme lifts the shadow floor a
// step (pure near-black collapses to mud on the cream page).
function makeBronzeMatcap(light: boolean): THREE.Texture {
  const s = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = light ? "#241611" : "#160d09";
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createRadialGradient(
    s * 0.36,
    s * 0.3,
    s * 0.04,
    s * 0.5,
    s * 0.5,
    s * 0.6,
  );
  g.addColorStop(0, "#ffe9c4"); // hot gold core
  g.addColorStop(0.3, "#e8a05c"); // copper
  g.addColorStop(0.62, "#8a4d2b"); // terracotta bronze
  g.addColorStop(1, light ? "#2e1c13" : "#1c100a"); // umber falloff
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const r = ctx.createRadialGradient(
    s * 0.78,
    s * 0.82,
    s * 0.02,
    s * 0.78,
    s * 0.82,
    s * 0.5,
  );
  r.addColorStop(0, "rgba(255,122,46,0.5)"); // warm rim light
  r.addColorStop(1, "rgba(255,122,46,0)");
  ctx.fillStyle = r;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 4-step grayscale ramp -> hard-stepped toon lighting.
function makeToonRamp(): THREE.DataTexture {
  const steps = [60, 120, 190, 245];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Soft studio-sphere matcap (light from the upper-left) for a clay/putty look.
function makeMatcap(): THREE.Texture {
  const s = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2b3038";
  ctx.fillRect(0, 0, s, s);
  const g = ctx.createRadialGradient(
    s * 0.36,
    s * 0.3,
    s * 0.04,
    s * 0.5,
    s * 0.5,
    s * 0.58,
  );
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.35, "#d2dae2");
  g.addColorStop(0.72, "#7c858f");
  g.addColorStop(1, "#2b3038");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface ShadingController {
  set(mode: ShadingMode): void;
  /** Fold meshes that loaded AFTER creation (the background accessories) into the
   *  swapper and style them in the current mode. Idempotent per mesh. */
  integrate(root: THREE.Object3D): void;
  /** Re-palette the current mode for the site theme (light = no `.dark` on <html>).
   *  Rebuilds the current mode's materials; a no-op when the theme is unchanged. */
  setTheme(light: boolean): void;
  /** The edge-line objects created for the current mode (empty unless "ink"). Used
   *  by the scene's sketch-in entrance to stroke them on. */
  getInkLines(): THREE.LineSegments[];
  dispose(): void;
}

export function createShading(root: THREE.Object3D): ShadingController {
  // site theme — the palettes flip between paper-light and stage-dark. Detected
  // here so both pages get the right palette without wiring; toggles arrive via
  // setTheme (the pages own the observer — a controller-owned one would leak).
  let light = !document.documentElement.classList.contains("dark");
  let currentMode: ShadingMode = "realistic";
  const meshes: THREE.Mesh[] = [];
  const original = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const baseColor = new Map<THREE.Mesh, THREE.Color>();

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    meshes.push(o);
    original.set(o, o.material);
    const first = Array.isArray(o.material) ? o.material[0] : o.material;
    const col = (first as THREE.MeshStandardMaterial).color;
    baseColor.set(o, col ? col.clone() : new THREE.Color(0x808080));
  });

  // lazily-built shared resources, disposed with the controller
  let toonRamp: THREE.DataTexture | null = null;
  let matcap: THREE.Texture | null = null;
  // Ink edge lines cached per mesh × crease threshold: they're a pure function
  // of the (immutable) source geometry, and rebuilding ~260 EdgesGeometry + the
  // bloom attribute copy on EVERY re-entry into ink made the toggle visibly
  // janky. Threshold is in the key because "flat" runs the same construction at
  // a coarser crease angle than ink/blueprint.
  const edgeGeoCache = new Map<string, THREE.BufferGeometry>();
  // materials + edge-line/hull objects created for the current mode, replaced each switch
  let created: THREE.Material[] = [];
  let createdLines: THREE.LineSegments[] = [];
  // outline mode's inverted-hull meshes (share the source geometry — only the
  // material offsets them), torn down with the lines on every mode switch
  let createdHulls: THREE.Mesh[] = [];
  // Per-mode SHARED-material caches, persisted for the current mode so integrate()
  // can fold a late-arriving mesh (the background accessories) into the live look
  // without rebuilding everything. A mode switch throws them away (clearCreated).
  const fillCache = new Map<string, THREE.MeshBasicNodeMaterial>();
  const lineCache = new Map<string, THREE.LineBasicNodeMaterial>();
  // shared materials for the self-contained modes (riso/bronze) — keyed by
  // mode × part-class × bloom, same lifecycle as fillCache
  const modeCache = new Map<string, THREE.Material>();
  let uniformPlain: THREE.NodeMaterial | null = null;
  let uniformBloomed: THREE.NodeMaterial | null = null;
  // bronze matcap is theme-dependent (lifted shadow floor on light), so it's
  // cached per theme flag and rebuilt on a flip (unlike the neutral clay matcap)
  let bronzeMatcap: THREE.Texture | null = null;
  let bronzeMatcapLight = false;
  const track = <T extends THREE.Material>(m: T): T => {
    created.push(m);
    return m;
  };
  const clearCreated = () => {
    created.forEach((m) => m.dispose());
    created = [];
    // geometries live in edgeGeoCache (reused on the next ink entry) — only the
    // line OBJECTS are torn down here; the cache is disposed with the controller
    createdLines.forEach((l) => l.removeFromParent());
    createdLines = [];
    // hulls borrow the source mesh's geometry — nothing of their own to dispose
    createdHulls.forEach((h) => h.removeFromParent());
    createdHulls = [];
    // the caches point into `created` (now disposed) — reset for the next mode
    fillCache.clear();
    lineCache.clear();
    modeCache.clear();
    uniformPlain = null;
    uniformBloomed = null;
  };

  // A fresh material for a "uniform" mode (same look for every mesh).
  function makeUniform(mode: ShadingMode): THREE.NodeMaterial {
    switch (mode) {
      case "wire":
        return new THREE.MeshBasicNodeMaterial({
          color: light ? 0x44546a : 0x9db4c8, // dark strands on paper, pale on the stage
          wireframe: true,
        });
      default: // clay
        matcap ??= makeMatcap();
        return new THREE.MeshMatcapNodeMaterial({ color: 0xc4ccd4, matcap });
    }
  }

  // Apply the CURRENT mode's material(s) to ONE mesh, drawing from the shared
  // per-mode caches above. This is the per-mesh half of set(); integrate() calls
  // it for meshes that arrive after the initial build (the background accessories).
  function applyToMesh(mesh: THREE.Mesh) {
    // ink assigns renderOrder to the window pieces (drawn last, no depth write);
    // every other mode uses plain depth-sorted rendering — clear the override.
    mesh.renderOrder = 0;
    const mode = currentMode;

    if (mode === "realistic") {
      // originals already carry the bloom node material on the wedges
      mesh.material = original.get(mesh)!;
      return;
    }

    const palette = TECHNICAL_PALETTES[mode];
    if (palette) {
      // Technical-drawing look: flat fills + edge lines that carry the form, CEL
      // banded (quantized N·L) so the body still reads dimensional. Every
      // technical mode ("ink", "blueprint") is this same construction under its
      // TECHNICAL_PALETTES entry. Shell wedges get attribute-preserving edge
      // geometry so the lines deform with the fill.
      //
      // Materials are SHARED per look (colour × glass × bloom), not per mesh: one
      // material per mesh built ~260 separate node graphs, and compiling all those
      // pipelines was the single largest chunk of time-to-first-frame. The palette
      // collapses to ~a dozen fill materials and 4 line materials (fillCache/lineCache).
      const theme = light ? ("light" as const) : ("dark" as const);
      const edgeBody = palette.edgeBody[theme];
      const edgeGlass = palette.edgeGlass[theme];
      const glass = isOpticalGlass(mesh.name);
      const bloom = hasBloom(mesh);
      const colorHex = palette.fill(mesh.name, light);
      const fillKey = `${colorHex}|${glass}|${bloom}`;
      let m = fillCache.get(fillKey);
      if (!m) {
        m = new THREE.MeshBasicNodeMaterial();
        m.color.setHex(colorHex);
        // cel bands on the body fills only — the translucent glass stays clean,
        // and a `flat` palette skips banding entirely (pure print fills).
        // Bloom-carrying meshes (wedges + their decals/features) additionally
        // crossfade to the CARDIFY photo face as uCardify → 1 (materials/
        // cards.ts) — a hard-gated exact identity at 0, so every technical
        // look (ink/blueprint/flat) renders untouched until cardify runs.
        if (!glass && (!palette.flat || bloom)) {
          let cn = colorNode(new THREE.Color(colorHex)) as any;
          if (!palette.flat) cn = cn.mul(celShade());
          if (bloom) cn = cardColorNode(cn);
          m.colorNode = cn;
        }
        m.transparent = true;
        // Push the fill's depth back a hair so the edge lines (which share the
        // surface's exact vertices) always win the depth test — without this
        // the lines z-fight the fill and FLICKER whenever the model moves.
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        // Depth fade: shell wedges explode in-shader, so feed the fade the bloom-
        // deformed local position (positionView misses it); everything else moves
        // by its object matrix, which positionLocal already captures.
        // Glass elements stay filled ALWAYS (like the example) — they never fade
        // to wireframe; only the body/metal fills fade in/out with uInkFill. All
        // fills also dissolve past the near/far planes as they explode.
        // Attach the bloom deform FIRST and feed its position node straight to the
        // fade (was a second bloomLocalPosition() graph — one deform per material).
        const bloomPos = bloom ? attachBloom(m) : undefined;
        if (!bloom) attachGenie(m);
        const fade = depthFadeFactor(bloomPos);
        let op = (glass ? float(0.45) : float(1).mul(uInkFill)).mul(fade);
        if (!glass) op = op.mul(float(1).sub(uIsolateHide)); // light-path isolate FADE
        m.opacityNode = op;
        // DISCARD fully-faded fragments: a transparent fill at opacity ~0 still
        // writes depth, so a depth-faded wedge would invisibly hard-clip
        // everything behind its silhouette (screw, rods, rings). Discarded
        // fragments write nothing.
        m.alphaTest = 0.02;
        fillCache.set(fillKey, track(m));
      }
      mesh.material = m;

      // edge lines (skip flat printed decals — their outline is just a
      // rectangle — and any palette-declared lineSkip parts)
      if (isDecal(mesh.name) || palette.lineSkip?.(mesh.name)) return;
      const lineKey = `${glass}|${bloom}`;
      let lineMat = lineCache.get(lineKey);
      if (!lineMat) {
        lineMat = new THREE.LineBasicNodeMaterial();
        lineMat.color.setHex(glass ? edgeGlass : edgeBody);
        lineMat.transparent = true;
        // Attach the deform first, then share its position node with the fade.
        const lineBloomPos = bloom ? attachBloomLine(lineMat) : undefined;
        if (!bloom) attachGenie(lineMat);
        let lop = float(glass ? 0.7 : 0.9).mul(depthFadeFactor(lineBloomPos));
        if (!glass) lop = lop.mul(float(1).sub(uIsolateHide)); // isolate fade
        // a finished CARD is a clean photo — the flattened relief's crease
        // lines fade out with the photo crossfade (identity at uCardify 0)
        if (bloom) lop = lop.mul(float(1).sub(cardPhotoMix()));
        lineMat.opacityNode = lop;
        lineMat.alphaTest = 0.02; // faded lines must not depth-clip either
        lineCache.set(lineKey, track(lineMat));
      }
      const thr = palette.edgeThresholdDeg ?? 24;
      const geoKey = `${mesh.id}|${thr}`;
      let geo = edgeGeoCache.get(geoKey);
      if (!geo) {
        geo = bloom
          ? bloomEdgeGeometry(mesh.geometry, thr)
          : new THREE.EdgesGeometry(mesh.geometry, thr);
        edgeGeoCache.set(geoKey, geo);
      }
      const line = new THREE.LineSegments(geo, lineMat);
      line.raycast = () => {}; // never pickable
      mesh.add(line);
      createdLines.push(line);
      return;
    }

    if (mode === "outline") {
      // Thick screen-print contour (OUTLINE above): pure unlit two-tone fills,
      // everything OPAQUE (glass = solid flat discs), plus an inverted-hull
      // second pass per mesh — the same geometry re-drawn BackSide with its
      // vertices pushed OUT along the (bloom-deformed) normal, so a constant
      // model-mm dark/cream rim survives wherever the surface meets anything
      // behind it: the whole silhouette + every depth step.
      const P = light ? OUTLINE.light : OUTLINE.dark;
      const bloom = hasBloom(mesh);
      const fillHex = outlineFill(P, mesh.name);
      const fillKey = `outline|${fillHex}|${bloom}`;
      let m = modeCache.get(fillKey);
      if (!m) {
        const mat = new THREE.MeshBasicNodeMaterial({ color: fillHex });
        if (bloom) attachBloom(mat);
        else attachGenie(mat);
        m = track(mat);
        modeCache.set(fillKey, m);
      }
      mesh.material = m;
      // no hull on the flat printed decals — they'd just outline a rectangle
      if (isDecal(mesh.name)) return;
      const hullKey = `outline|hull|${bloom}`;
      let hullMat = modeCache.get(hullKey);
      if (!hullMat) {
        const mat = new THREE.MeshBasicNodeMaterial({
          color: P.line,
          side: THREE.BackSide,
        });
        if (bloom) attachBloomHull(mat, OUTLINE_WIDTH);
        else {
          mat.positionNode = positionLocal.add(
            normalLocal.mul(OUTLINE_WIDTH) as any,
          );
          attachGenie(mat); // wraps the hull-push position graph just set
        }
        hullMat = track(mat);
        modeCache.set(hullKey, hullMat);
      }
      const hull = new THREE.Mesh(mesh.geometry, hullMat);
      hull.raycast = () => {}; // never pickable
      mesh.add(hull);
      createdHulls.push(hull);
      return;
    }

    if (mode === "riso") {
      // Duotone print (RISO above): flat 3-band posterized fills, no edge
      // lines. Glass is a translucent orange overprint so the mechanism still
      // reads through it; decals print flat in the contrasting ink.
      const stops = light ? RISO.light : RISO.dark;
      const glass = isOpticalGlass(mesh.name);
      const decal = isDecal(mesh.name);
      const bloom = hasBloom(mesh);
      const key = `riso|${glass}|${decal}|${bloom}`;
      let m = modeCache.get(key);
      if (!m) {
        const mat = new THREE.MeshBasicNodeMaterial();
        if (glass) {
          mat.color.setHex(stops.mid);
          mat.transparent = true;
          mat.opacity = 0.35;
        } else if (decal) {
          mat.color.setHex(stops.decal);
        } else {
          mat.colorNode = risoBands(stops);
        }
        if (bloom) attachBloom(mat);
        else attachGenie(mat);
        m = track(mat);
        modeCache.set(key, m);
      }
      mesh.material = m;
      return;
    }

    if (mode === "bronze") {
      // Dark-studio metal (makeBronzeMatcap above): the whole lens cast in
      // copper/bronze, rubber grips kept dark via a matcap tint, glass a deep
      // smoked amber so the internals read as silhouettes inside the metal.
      if (!bronzeMatcap || bronzeMatcapLight !== light) {
        bronzeMatcap?.dispose();
        bronzeMatcap = makeBronzeMatcap(light);
        bronzeMatcapLight = light;
      }
      const glass = isOpticalGlass(mesh.name);
      const grip = /Ring_/.test(mesh.name);
      const bloom = hasBloom(mesh);
      const key = `bronze|${glass}|${grip}|${bloom}`;
      let m = modeCache.get(key);
      if (!m) {
        const mat = glass
          ? new THREE.MeshBasicNodeMaterial({
              color: 0x40220f,
              transparent: true,
              opacity: 0.45,
            })
          : new THREE.MeshMatcapNodeMaterial({
              color: grip ? 0x4c4440 : 0xffffff,
              matcap: bronzeMatcap,
            });
        if (bloom) attachBloom(mat);
        else attachGenie(mat);
        m = track(mat);
        modeCache.set(key, m);
      }
      mesh.material = m;
      return;
    }

    if (mode === "toon") {
      // per-mesh colour-preserving, hard-stepped
      toonRamp ??= makeToonRamp();
      const glass = isOpticalGlass(mesh.name);
      const m = new THREE.MeshToonNodeMaterial();
      m.color.copy(glass ? new THREE.Color(0xbfe3ff) : baseColor.get(mesh)!);
      m.gradientMap = toonRamp;
      m.transparent = glass;
      m.opacity = glass ? 0.5 : 1;
      if (hasBloom(mesh)) attachBloom(m);
      else attachGenie(m);
      mesh.material = track(m);
      return;
    }

    // uniform modes: two shared materials — a plain one for whole parts and a
    // bloom-attached one for the wedges/decals (a single material can't do both,
    // since non-wedges lack the `_bloom` attributes the graph reads). Built lazily
    // on first use so the pair persists across integrate() for the current mode.
    if (!uniformPlain) {
      uniformPlain = track(makeUniform(mode));
      attachGenie(uniformPlain);
    }
    if (!uniformBloomed) {
      uniformBloomed = track(makeUniform(mode));
      attachBloom(uniformBloomed);
    }
    mesh.material = hasBloom(mesh) ? uniformBloomed : uniformPlain;
  }

  function set(mode: ShadingMode) {
    currentMode = mode;
    clearCreated();
    for (const mesh of meshes) applyToMesh(mesh);
  }

  // Fold meshes that appear AFTER the initial capture (the background accessories
  // GLB) into the swapper: capture their originals and apply the current mode
  // using the SAME shared caches, so a later mode switch covers them and the
  // hero's ink caps-on finale styles the caps. Idempotent — already-captured
  // meshes are skipped.
  function integrate(root: THREE.Object3D) {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || original.has(o)) return;
      meshes.push(o);
      original.set(o, o.material);
      const first = Array.isArray(o.material) ? o.material[0] : o.material;
      const col = (first as THREE.MeshStandardMaterial).color;
      baseColor.set(o, col ? col.clone() : new THREE.Color(0x808080));
      applyToMesh(o);
    });
  }

  function dispose() {
    clearCreated();
    edgeGeoCache.forEach((g) => g.dispose());
    edgeGeoCache.clear();
    toonRamp?.dispose();
    matcap?.dispose();
    bronzeMatcap?.dispose();
  }

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    set(currentMode); // rebuild the active mode under the other palette
  }

  return { set, integrate, setTheme, getInkLines: () => createdLines, dispose };
}
