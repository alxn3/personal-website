import * as THREE from "three/webgpu";
import {
  clamp,
  color as colorNode,
  dot,
  float,
  floor,
  mix,
  normalLocal,
  normalView,
  positionLocal,
  vec3,
} from "three/tsl";
// The deform comes from the op pipeline, gated by `hasOpFrames` (the packed
// `_opA` attribute) — the SAME test materials/unified.ts applies, so every
// bench mode deforms exactly the set the story's pair does.
import {
  attachOps,
  attachOpsLine,
  attachOpsHull,
  opsEdgeGeometry,
  hasOpFrames,
  opsVariantKey,
} from "../ops/host";
import { depthFadeFactor } from "./depthfade";
import { CEL_LIGHT, celShade, uInkFill } from "./unified";
import { isOpticalGlass, isDecal } from "../core/parts";
import type { BenchMode } from "./shading";

// The /lens shading bench: the seven swappable technical looks. It is a LAZY
// CHUNK — the homepage hero only ever wears the story's realistic/ink pair.
//
// TYPE-ONLY EDGE: `BenchMode` above is `import type`, erased at build, so
// Rollup sees NO static import in either direction. materials/shading.ts names
// this module only through `installBench`, which core/scene.ts's
// `enableShadingBench()` calls after a dynamic import. Add a value import from
// "./shading" here and this chunk collapses into the homepage's. Pinned by
// __tests__/shading-boundary.test.ts.
//
// Every look re-materials every mesh from a build it keeps for the session
// (ModeBuild): leaving a mode PARKS its extras, returning re-wears them, so a
// switch never re-derives materials mid-scroll. The bronze matcap is generated
// procedurally — nothing external.

// A technical-drawing palette: flat fill colours keyed by part name (one per
// site theme) plus the edge-line pairs. "blueprint" and "flat" run ONE shared
// construction in applyToMesh, so another technical look is a new entry here, a
// ShadingMode union member, and a page button.
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

const TECHNICAL_PALETTES: Partial<Record<BenchMode, TechnicalPalette>> = {
  // BLUEPRINT: ink's construction under a cyanotype palette — deep drafting
  // blues and white line-work dark, pale blue paper and deep blue lines light.
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

  // FLAT: ink's construction with the cel bands OFF and a higher crease
  // threshold, so only the silhouette and major structural edges survive.
  flat: {
    flat: true,
    edgeThresholdDeg: 40,
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x6fa863; // one mint for every element
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
    // the ribbed bands hatch when every rib gets stroked; their form is
    // carried by fill contrast, so flat drops their lines entirely
    lineSkip: (name) => /^(Ring_Zoom|Ring_Focus|Band_Mid)/.test(name),
    // ink's line pairs
    edgeBody: { dark: 0xe4dbc4, light: 0x2f2a20 },
    edgeGlass: { dark: 0xc9e6bb, light: 0x3f6b39 },
  },

  // EMBER: bold orange ink on near-black paper. The palette IS dark, so both
  // site themes share one family; light only lifts the body ground a hair.
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

  // PAPER: near-black ink on white paper with ONE saturated orange accent on
  // the glass lines and mechanism fills, everything else achromatic warm gray.
  // The dark theme dims it a step — a full-white slab would blast.
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

// OUTLINE: thick screen-print contour — a constant-width inverted-hull outline
// over pure UNLIT two-tone fills. NOTHING is transparent; the glass renders as
// solid discs wearing the same outline. The hull width is in model mm.
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

// RISO: duotone risograph print — hard 3-step N·L posterization, NO outlines
// (the banding carries all the form). `decal` is the flat un-banded print
// colour for the engraved text; the glass is a translucent overprint.
const RISO = {
  light: { shadow: 0x241d18, mid: 0xe8551a, lit: 0xf2e8cf, decal: 0x241d18 },
  dark: { shadow: 0x1b1512, mid: 0xc23e12, lit: 0xff6a2a, decal: 0xf2e8cf },
};

// Hard 3-band posterize of N·L — celShade's quantization, but SELECTING flat
// colours instead of scaling one.
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
// bronze falloff, plus a low warm rim so the dark side separates from the
// stage. The light theme lifts the shadow floor a step.
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

/** The bench half of the shading controller. Every method is a no-op-safe
 *  delegate: materials/shading.ts owns the mesh roster, the site theme and the
 *  current mode, and calls in here only for the looks it cannot wear itself. */
export interface ShadingBench {
  /** Wear `mode` on `meshes`: PARK whatever build was live, then build this
   *  mode the first time it meets a mesh and re-wear it every time after. */
  wear(mode: BenchMode, meshes: readonly THREE.Mesh[]): void;
  /** Take the live build's extras off their meshes and go dormant — the build
   *  stays whole, so returning to that mode is a re-wear, not a rebuild. */
  park(): void;
  /** Fold ONE mesh that arrived after the roster was captured into the live
   *  build. No-op while no build is live — the story's pair covers its own. */
  integrate(mesh: THREE.Mesh): void;
  /** Re-palette. Every build is colour-BAKED, so this throws them ALL away —
   *  keeping the parked ones would re-wear the old theme's colours on the next
   *  switch. The caller re-`wear`s the current mode. */
  setTheme(light: boolean): void;
  dispose(): void;
}

export type ShadingBenchFactory = (light: boolean) => ShadingBench;

export const createShadingBench: ShadingBenchFactory = (light) => {
  // Edge lines cached per mesh × crease threshold: a pure function of the
  // immutable source geometry, and rebuilding them on every re-entry into a
  // look is what makes the toggle janky. Outlives a theme flip.
  const edgeGeoCache = new Map<string, THREE.BufferGeometry>();

  // ONE mode's build — its materials, the extras it parented under the meshes,
  // and what each mesh ended up WEARING. Never torn down on a switch.
  interface ModeBuild {
    materials: THREE.Material[];
    /** lines + hulls with the mesh each hangs under, so parking can detach them
     *  and a return can put them back */
    extras: { owner: THREE.Mesh; obj: THREE.Object3D }[];
    worn: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
    // SHARED-material caches: one per look × part class, not per mesh. They
    // also let integrate() fold a late mesh in without rebuilding the look.
    fill: Map<string, THREE.MeshBasicNodeMaterial>;
    line: Map<string, THREE.LineBasicNodeMaterial>;
    /** the self-contained modes' (outline/riso/bronze) shared materials */
    shared: Map<string, THREE.Material>;
  }
  const builds = new Map<BenchMode, ModeBuild>();
  /** the live mode's build — null while the story's pair is worn */
  let build: ModeBuild | null = null;
  /** which mode `build` belongs to — applyToMesh's branch key */
  let currentMode: BenchMode | null = null;
  const makeBuild = (mode: BenchMode): ModeBuild => {
    const b: ModeBuild = {
      materials: [],
      extras: [],
      worn: new Map(),
      fill: new Map(),
      line: new Map(),
      shared: new Map(),
    };
    builds.set(mode, b);
    return b;
  };
  // the bronze matcap is theme-dependent, so it is cached per theme flag
  let bronzeMatcap: THREE.Texture | null = null;
  let bronzeMatcapLight = false;
  const track = <T extends THREE.Material>(m: T): T => {
    build!.materials.push(m);
    return m;
  };
  const attach = (owner: THREE.Mesh, obj: THREE.Object3D) => {
    obj.raycast = () => {}; // extras are never pickable
    obj.userData.lensExtra = true; // …and never a piece of the model
    owner.add(obj);
    build!.extras.push({ owner, obj });
  };
  /** Free EVERY build. Materials are all a build owns outright — edge
   *  geometries live in edgeGeoCache and hulls borrow the source geometry. */
  const flushBuilds = () => {
    for (const b of builds.values()) {
      b.materials.forEach((m) => m.dispose());
      b.extras.forEach((e) => e.obj.removeFromParent());
    }
    builds.clear();
    build = null;
  };

  // Build the CURRENT mode's material(s) for ONE mesh from that mode's shared
  // caches. Runs only the first time a mode meets a mesh; later entries re-wear
  // `build.worn`.
  function applyToMesh(mesh: THREE.Mesh) {
    // some looks assign renderOrder; clear the override for the rest.
    mesh.renderOrder = 0;
    const mode = currentMode!;
    const b = build!;
    // Every look below classifies by NAME — the GLB's node names, which the
    // palettes' rules are written against.
    const name = mesh.name;

    const palette = TECHNICAL_PALETTES[mode];
    if (palette) {
      // Technical-drawing look: flat fills + edge lines carrying the form, cel
      // banded so the body still reads dimensional. Framed pieces get
      // attribute-preserving edge geometry so the lines deform with the fill.
      // Materials are SHARED per look (colour × glass × framed), not per mesh —
      // a node graph each would dominate time-to-first-frame.
      const theme = light ? ("light" as const) : ("dark" as const);
      const edgeBody = palette.edgeBody[theme];
      const edgeGlass = palette.edgeGlass[theme];
      const glass = isOpticalGlass(name);
      const framed = hasOpFrames(mesh);
      // A mesh whose deform graph VARIES (a spin pivot, a decal's shrink-wrap)
      // can only share a material with meshes that vary the same way, so every
      // cache key below carries the variant.
      const spin = opsVariantKey(mesh);
      const colorHex = palette.fill(name, light);
      const fillKey = `${colorHex}|${glass}|${framed}|${spin}`;
      let m = b.fill.get(fillKey);
      if (!m) {
        m = new THREE.MeshBasicNodeMaterial();
        m.color.setHex(colorHex);
        // cel bands on the body fills only — the glass stays clean, and a
        // `flat` palette skips banding entirely.
        if (!glass && !palette.flat) {
          m.colorNode = colorNode(new THREE.Color(colorHex)).mul(
            celShade(),
          ) as any;
        }
        m.transparent = true;
        // Push the fill's depth back a hair so the edge lines, which share the
        // surface's exact vertices, win the depth test rather than z-fighting.
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
        // Attach the op deform FIRST and feed its position node straight to the
        // fade: a second position graph would double the deform. Glass stays
        // filled always; only the body/metal fills ride uInkFill.
        const opsPos = framed ? attachOps(m, mesh) : undefined;
        const fade = depthFadeFactor(opsPos);
        m.opacityNode = (glass ? float(0.45) : float(1).mul(uInkFill)).mul(
          fade,
        );
        // DISCARD fully-faded fragments: a transparent fill at opacity ~0
        // still writes depth, so a faded wedge would invisibly hard-clip
        // whatever is behind it.
        m.alphaTest = 0.02;
        b.fill.set(fillKey, track(m));
      }
      mesh.material = m;

      // edge lines (skip flat printed decals — their outline is just a
      // rectangle — and any palette-declared lineSkip parts)
      if (isDecal(name) || palette.lineSkip?.(name)) return;
      const lineKey = `${glass}|${framed}|${spin}`;
      let lineMat = b.line.get(lineKey);
      if (!lineMat) {
        lineMat = new THREE.LineBasicNodeMaterial();
        lineMat.color.setHex(glass ? edgeGlass : edgeBody);
        lineMat.transparent = true;
        // Attach the deform first, then share its position node with the fade.
        const lineOpsPos = framed ? attachOpsLine(lineMat, mesh) : undefined;
        lineMat.opacityNode = float(glass ? 0.7 : 0.9).mul(
          depthFadeFactor(lineOpsPos),
        );
        lineMat.alphaTest = 0.02; // faded lines must not depth-clip either
        b.line.set(lineKey, track(lineMat));
      }
      const thr = palette.edgeThresholdDeg ?? 24;
      const geoKey = `${mesh.id}|${thr}`;
      let geo = edgeGeoCache.get(geoKey);
      if (!geo) {
        geo = framed
          ? opsEdgeGeometry(mesh.geometry, thr)
          : new THREE.EdgesGeometry(mesh.geometry, thr);
        edgeGeoCache.set(geoKey, geo);
      }
      const line = new THREE.LineSegments(geo, lineMat);
      attach(mesh, line);
      return;
    }

    if (mode === "outline") {
      // Thick screen-print contour: unlit two-tone fills, everything OPAQUE,
      // plus an inverted hull — the same geometry re-drawn BackSide with its
      // vertices pushed out along the op-deformed normal.
      const P = light ? OUTLINE.light : OUTLINE.dark;
      const framed = hasOpFrames(mesh);
      const spin = opsVariantKey(mesh);
      const fillHex = outlineFill(P, name);
      const fillKey = `outline|${fillHex}|${framed}|${spin}`;
      let m = b.shared.get(fillKey);
      if (!m) {
        const mat = new THREE.MeshBasicNodeMaterial({ color: fillHex });
        if (framed) attachOps(mat, mesh);
        m = track(mat);
        b.shared.set(fillKey, m);
      }
      mesh.material = m;
      // no hull on the flat printed decals — they'd just outline a rectangle
      if (isDecal(name)) return;
      const hullKey = `outline|hull|${framed}|${spin}`;
      let hullMat = b.shared.get(hullKey);
      if (!hullMat) {
        const mat = new THREE.MeshBasicNodeMaterial({
          color: P.line,
          side: THREE.BackSide,
        });
        if (framed) attachOpsHull(mat, OUTLINE_WIDTH, mesh);
        else
          mat.positionNode = positionLocal.add(
            normalLocal.mul(OUTLINE_WIDTH) as any,
          );
        hullMat = track(mat);
        b.shared.set(hullKey, hullMat);
      }
      attach(mesh, new THREE.Mesh(mesh.geometry, hullMat));
      return;
    }

    if (mode === "riso") {
      // Duotone print: flat 3-band posterized fills, no edge lines. Glass is a
      // translucent overprint so the mechanism reads through it.
      const stops = light ? RISO.light : RISO.dark;
      const glass = isOpticalGlass(name);
      const decal = isDecal(name);
      const framed = hasOpFrames(mesh);
      const key = `riso|${glass}|${decal}|${framed}|${opsVariantKey(mesh)}`;
      let m = b.shared.get(key);
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
        if (framed) attachOps(mat, mesh);
        m = track(mat);
        b.shared.set(key, m);
      }
      mesh.material = m;
      return;
    }

    if (mode === "bronze") {
      // Dark-studio metal: the lens cast in copper/bronze, grips kept dark via
      // a matcap tint, glass a smoked amber so the internals read through.
      if (!bronzeMatcap || bronzeMatcapLight !== light) {
        bronzeMatcap?.dispose();
        bronzeMatcap = makeBronzeMatcap(light);
        bronzeMatcapLight = light;
      }
      const glass = isOpticalGlass(name);
      const grip = /Ring_/.test(name);
      const framed = hasOpFrames(mesh);
      const key = `bronze|${glass}|${grip}|${framed}|${opsVariantKey(mesh)}`;
      let m = b.shared.get(key);
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
        if (framed) attachOps(mat, mesh);
        m = track(mat);
        b.shared.set(key, m);
      }
      mesh.material = m;
    }
  }

  /** build this mesh in the current mode and remember what it ends up wearing */
  function style(mesh: THREE.Mesh) {
    applyToMesh(mesh);
    build?.worn.set(mesh, mesh.material);
  }

  function park() {
    if (build) for (const e of build.extras) e.obj.removeFromParent();
    build = null;
    currentMode = null;
  }

  return {
    wear(mode, meshes) {
      // PARK the outgoing mode: its extras come off the meshes but nothing is
      // freed, so coming back is a re-wear rather than a rebuild.
      park();
      currentMode = mode;
      build = builds.get(mode) ?? makeBuild(mode);
      for (const mesh of meshes) {
        const worn = build.worn.get(mesh);
        if (!worn) {
          style(mesh); // first time this mode meets this mesh
          continue;
        }
        mesh.renderOrder = 0; // as applyToMesh does — clear any foreign override
        mesh.material = worn;
      }
      // …and the parked extras go back on. add() on a child already parented
      // here is a no-op, so anything style() just attached doesn't double up.
      for (const e of build.extras) e.owner.add(e.obj);
    },
    park,
    integrate(mesh) {
      if (build) style(mesh);
    },
    setTheme(l) {
      light = l;
      flushBuilds();
      currentMode = null;
    },
    dispose() {
      flushBuilds();
      edgeGeoCache.forEach((g) => g.dispose());
      edgeGeoCache.clear();
      bronzeMatcap?.dispose();
    },
  };
};
