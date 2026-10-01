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
import {
  attachOps,
  attachOpsLine,
  attachOpsHull,
  hasOpFrames,
  opsVariantKey,
} from "../ops/host";
import { depthFadeFactor } from "./depthfade";
import { CEL_LIGHT, celShade, edgeGeometry, uInkFill } from "./unified";
import { isOpticalGlass, isDecal } from "../core/parts";
import type { BenchMode } from "./shading";

// The extra shading looks for /lens, loaded lazily. Only `import type` from
// shading.ts here, or this chunk gets bundled into the homepage.
//
// Each look's materials are built once per mesh and kept (a ModeBuild), so
// switching back to a look re-applies them instead of rebuilding.

// A fill-and-edge-lines look: fill colour per part name and theme, plus edge
// line colours.
interface TechnicalPalette {
  fill(name: string, light: boolean): number;
  edgeBody: { dark: number; light: number };
  edgeGlass: { dark: number; light: number };
  /** no cel shading on the fills */
  flat?: boolean;
  /** crease angle for edge lines (default 24) */
  edgeThresholdDeg?: number;
  /** parts that get no edge lines (decals never do) */
  lineSkip?: (name: string) => boolean;
}

const TECHNICAL_PALETTES: Partial<Record<BenchMode, TechnicalPalette>> = {
  // Blueprint: cyanotype blues.
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

  // Flat: unshaded fills, fewer edge lines.
  flat: {
    flat: true,
    edgeThresholdDeg: 40,
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x6fa863; // one mint for every element
        if (isDecal(name)) return 0x3f3a2f; // printed text goes dark on cream
        if (/^Iris_Blade|Ring_/.test(name)) return 0x4a4f5e; // ink's slate bands
        if (/^(Mount_|Focus_|PCB_)/.test(name)) return 0x7c766a; // muted metal
        return 0xece6d6; // one cream shell tone — no gloss/matte split
      }
      if (isOpticalGlass(name)) return 0x9ccb92;
      if (isDecal(name)) return 0xefe8d4;
      if (/^Iris_Blade|Ring_/.test(name)) return 0x343846;
      if (/^(Mount_|Focus_|PCB_)/.test(name)) return 0x9a9482;
      return 0x211d16;
    },
    // ribbed bands would be solid hatching
    lineSkip: (name) => /^(Ring_Zoom|Ring_Focus|Band_Mid)/.test(name),
    // ink's line pairs
    edgeBody: { dark: 0xe4dbc4, light: 0x2f2a20 },
    edgeGlass: { dark: 0xc9e6bb, light: 0x3f6b39 },
  },

  // Ember: orange lines on near-black, in both themes.
  ember: {
    fill(name: string, light: boolean): number {
      if (isOpticalGlass(name)) return 0xe08a4f; // warm amber glass — uniform
      if (/^Iris_Blade/.test(name)) return 0x93401d; // deep-rust blades
      if (isDecal(name)) return 0xffb489; // printed text glows pale orange
      if (/^Mount_Contacts/.test(name)) return 0xffa14e;
      if (/^Mount_/.test(name)) return 0x6f4a35;
      if (/^Focus_/.test(name)) return 0xff7a2e; // hottest accent
      if (/^PCB_/.test(name)) return 0x83492a;
      if (/Ring_/.test(name)) return 0x382216; // rubber grips stay near-black
      if (/Band_Mid|Barrel_Base|Chassis/.test(name))
        return light ? 0x2a1c12 : 0x241811; // gloss body
      return light ? 0x231710 : 0x1c120b; // matte body — the near-black paper
    },
    edgeBody: { dark: 0xff5c1f, light: 0xf25818 }, // the bold orange ink
    edgeGlass: { dark: 0xffa96b, light: 0xf09a5a },
  },

  // Paper: black ink on white with an orange accent.
  paper: {
    fill(name: string, light: boolean): number {
      if (light) {
        if (isOpticalGlass(name)) return 0x8f8879; // warm-gray glass
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

// Outline: thick contour (inverted hull) over flat two-tone fills, opaque.
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

// Riso: three-band posterized fills, no lines; translucent glass.
const RISO = {
  light: { shadow: 0x241d18, mid: 0xe8551a, lit: 0xf2e8cf, decal: 0x241d18 },
  dark: { shadow: 0x1b1512, mid: 0xc23e12, lit: 0xff6a2a, decal: 0xf2e8cf },
};

// Pick one of three colours by quantized N·L (same bands as celShade).
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

// Bronze: a painted matcap texture (gold core to bronze falloff, warm rim).
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

/** The bench looks, driven by shading.ts. */
export interface ShadingBench {
  /** Apply `mode` to `meshes`, building its materials on first use. */
  wear(mode: BenchMode, meshes: Iterable<THREE.Mesh>): void;
  /** Detach the current look's extras (kept for reuse). */
  park(): void;
  /** Add a mesh that loaded later to the current look, if any. */
  integrate(mesh: THREE.Mesh): void;
  /** Drop every build (colours are baked in); the caller re-wears. */
  setTheme(light: boolean): void;
}

export type ShadingBenchFactory = (light: boolean) => ShadingBench;

export const createShadingBench: ShadingBenchFactory = (light) => {
  // One look's materials, its extra objects, and each mesh's material.
  interface ModeBuild {
    mode: BenchMode;
    /** materials by cache key, shared between meshes */
    mats: Map<string, THREE.Material>;
    /** added lines and hulls, with the mesh each hangs under */
    extras: { owner: THREE.Mesh; obj: THREE.Object3D }[];
    worn: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  }
  const builds = new Map<BenchMode, ModeBuild>();
  /** null while no bench look is worn */
  let build: ModeBuild | null = null;
  let bronzeMatcap: THREE.Texture | null = null;

  /** The current look's material for `key`, built by `make` on first use. */
  const cached = <M extends THREE.Material>(key: string, make: () => M): M => {
    const mats = build!.mats;
    let m = mats.get(key) as M | undefined;
    if (!m) {
      m = make();
      mats.set(key, m);
    }
    return m;
  };
  const attach = (owner: THREE.Mesh, obj: THREE.Object3D) => {
    obj.raycast = () => {};
    obj.userData.lensExtra = true; // not a model piece
    owner.add(obj);
    build!.extras.push({ owner, obj });
  };

  // Build and apply the current look's materials to one mesh.
  function applyToMesh(mesh: THREE.Mesh) {
    const mode = build!.mode;
    const name = mesh.name;
    const glass = isOpticalGlass(name);
    const framed = hasOpFrames(mesh);
    // meshes share a material only if their deform variant matches
    const spin = opsVariantKey(mesh);

    const palette = TECHNICAL_PALETTES[mode];
    if (palette) {
      // fills plus edge lines that deform with the mesh
      const theme = light ? ("light" as const) : ("dark" as const);
      const colorHex = palette.fill(name, light);
      mesh.material = cached(
        `fill|${colorHex}|${glass}|${framed}|${spin}`,
        () => {
          const m = new THREE.MeshBasicNodeMaterial();
          m.color.setHex(colorHex);
          // cel shading on body fills only
          if (!glass && !palette.flat)
            m.colorNode = colorNode(new THREE.Color(colorHex)).mul(
              celShade(),
            ) as any;
          m.transparent = true;
          // push fills back so edge lines on the same vertices win the depth test
          m.polygonOffset = true;
          m.polygonOffsetFactor = 1;
          m.polygonOffsetUnits = 1;
          // glass ignores uInkFill
          const fade = depthFadeFactor(framed ? attachOps(m, mesh) : undefined);
          m.opacityNode = (glass ? float(0.45) : float(1).mul(uInkFill)).mul(
            fade,
          );
          // discard faded fragments so they don't write depth
          m.alphaTest = 0.02;
          return m;
        },
      );

      if (isDecal(name) || palette.lineSkip?.(name)) return;
      const lineMat = cached(`line|${glass}|${framed}|${spin}`, () => {
        const m = new THREE.LineBasicNodeMaterial();
        m.color.setHex(
          glass ? palette.edgeGlass[theme] : palette.edgeBody[theme],
        );
        m.transparent = true;
        const opsPos = framed ? attachOpsLine(m, mesh) : undefined;
        m.opacityNode = float(glass ? 0.7 : 0.9).mul(depthFadeFactor(opsPos));
        m.alphaTest = 0.02;
        return m;
      });
      const geo = edgeGeometry(mesh, palette.edgeThresholdDeg ?? 24);
      attach(mesh, new THREE.LineSegments(geo, lineMat));
      return;
    }

    if (mode === "outline") {
      // hull: the same geometry drawn back-faced, pushed out along the normal
      const P = light ? OUTLINE.light : OUTLINE.dark;
      const fillHex = outlineFill(P, name);
      mesh.material = cached(`outline|${fillHex}|${framed}|${spin}`, () => {
        const m = new THREE.MeshBasicNodeMaterial({ color: fillHex });
        if (framed) attachOps(m, mesh);
        return m;
      });
      if (isDecal(name)) return;
      const hullMat = cached(`outline|hull|${framed}|${spin}`, () => {
        const m = new THREE.MeshBasicNodeMaterial({
          color: P.line,
          side: THREE.BackSide,
        });
        if (framed) attachOpsHull(m, OUTLINE_WIDTH, mesh);
        else
          m.positionNode = positionLocal.add(
            normalLocal.mul(OUTLINE_WIDTH) as any,
          );
        return m;
      });
      attach(mesh, new THREE.Mesh(mesh.geometry, hullMat));
      return;
    }

    if (mode === "riso") {
      const stops = light ? RISO.light : RISO.dark;
      const decal = isDecal(name);
      mesh.material = cached(`riso|${glass}|${decal}|${framed}|${spin}`, () => {
        const m = new THREE.MeshBasicNodeMaterial();
        if (glass) {
          m.color.setHex(stops.mid);
          m.transparent = true;
          m.opacity = 0.35;
        } else if (decal) {
          m.color.setHex(stops.decal);
        } else {
          m.colorNode = risoBands(stops);
        }
        if (framed) attachOps(m, mesh);
        return m;
      });
      return;
    }

    if (mode === "bronze") {
      // matcap per theme; grips tinted dark; glass smoked amber
      const matcap = (bronzeMatcap ??= makeBronzeMatcap(light));
      const grip = /Ring_/.test(name);
      mesh.material = cached(
        `bronze|${glass}|${grip}|${framed}|${spin}`,
        () => {
          const m = glass
            ? new THREE.MeshBasicNodeMaterial({
                color: 0x40220f,
                transparent: true,
                opacity: 0.45,
              })
            : new THREE.MeshMatcapNodeMaterial({
                color: grip ? 0x4c4440 : 0xffffff,
                matcap,
              });
          if (framed) attachOps(m, mesh);
          return m;
        },
      );
    }
  }

  /** Build `mesh` in the current look and record its material. */
  function style(mesh: THREE.Mesh) {
    applyToMesh(mesh);
    build!.worn.set(mesh, mesh.material);
  }

  function park() {
    if (build) for (const e of build.extras) e.obj.removeFromParent();
    build = null;
  }

  return {
    wear(mode, meshes) {
      park();
      build = builds.get(mode) ?? null;
      if (!build) {
        build = { mode, mats: new Map(), extras: [], worn: new Map() };
        builds.set(mode, build);
      }
      for (const mesh of meshes) {
        const worn = build.worn.get(mesh);
        if (worn) mesh.material = worn;
        else style(mesh); // first time this mode meets this mesh
      }
      // re-attach extras (add() is a no-op for ones just attached)
      for (const e of build.extras) e.owner.add(e.obj);
    },
    park,
    integrate(mesh) {
      if (build) style(mesh);
    },
    setTheme(l) {
      light = l;
      // dispose every build's materials and detach its extras
      for (const b of builds.values()) {
        for (const m of b.mats.values()) m.dispose();
        for (const e of b.extras) e.obj.removeFromParent();
      }
      builds.clear();
      build = null;
      bronzeMatcap?.dispose();
      bronzeMatcap = null;
    },
  };
};
