import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import fs from "node:fs";
import { deriveFrames, frameOf, rankKeyOf, type Frame } from "../frames";
import { NUM } from "../algebra";
import { DEPTH_THIN, WRAP_DIR, sheetTerm } from "../house";
import { type OpCtx } from "../ops";
import { createMechanism, MECHANISM } from "../mechanism";
import { recipeChannel, RECIPE_NAMES } from "../host";
import { displaceInto } from "../../dev/ops-cpu";

// The SHIPPED GLB's structural contract, plus the two laws the ops/mechanism
// layer leans on when it consumes one — so a model re-export that changes the
// shape the code is written against fails here.

const TAU = Math.PI * 2;
const MODEL = "public/models/lens_web_segmented.glb";
const Y = new THREE.Vector3(0, 1, 0);

interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    rotation?: number[];
    translation?: number[];
    scale?: number[];
    matrix?: number[];
    children?: number[];
  }[];
  meshes: {
    name?: string;
    primitives: { attributes?: Record<string, number>; indices?: number }[];
  }[];
  materials?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scenes: { nodes: number[] }[];
  accessors: {
    bufferView: number;
    componentType: number;
    type: string;
    count: number;
    byteOffset?: number;
  }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
}

/** The glTF JSON chunk of a .glb. */
function glbJson(path: string): Gltf {
  const buf = fs.readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    off += 8 + len;
  }
  return json!;
}

/** the JSON and BIN chunks together — the BIN is only needed by the real-
 *  geometry loader below, so the JSON-only reader above stays the common path */
function glbChunks(path: string): { json: Gltf; bin: Buffer } {
  const buf = fs.readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  let bin = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8"));
    else bin = body;
    off += 8 + len;
  }
  return { json: json!, bin };
}

const COMPONENT: Record<
  number,
  Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor // prettier-ignore
> = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const PER_ELEMENT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};

/** One accessor as a typed array. The bytes are COPIED: a bufferView's offset
 *  need not be aligned to the component size, and a view over the shared buffer
 *  would throw. */
function accessor(json: Gltf, bin: Buffer, i: number) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const Ctor = COMPONENT[a.componentType];
  if (!Ctor) throw new Error(`accessor ${i}: componentType ${a.componentType}`);
  if (bv.byteStride !== undefined)
    throw new Error(`accessor ${i}: interleaved bufferView is not supported`);
  const n = a.count * PER_ELEMENT[a.type];
  const at = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const bytes = new Uint8Array(
    bin.subarray(at, at + n * Ctor.BYTES_PER_ELEMENT),
  );
  return new Ctor(bytes.buffer);
}

const isIdentity = (r?: number[]): boolean =>
  !r ||
  (Math.abs(r[0]) < 1e-9 &&
    Math.abs(r[1]) < 1e-9 &&
    Math.abs(r[2]) < 1e-9 &&
    Math.abs(Math.abs(r[3]) - 1) < 1e-9);

describe("shipped lens_web_segmented.glb", () => {
  const g = glbJson(MODEL);
  const names = g.nodes.map((n) => n.name);

  it("is material-less, one primitive per mesh, `_geo` datablocks", () => {
    expect(g.materials ?? []).toHaveLength(0);
    expect(g.meshes.filter((m) => m.primitives.length > 1)).toHaveLength(0);
    expect(g.meshes.filter((m) => !/_geo$/.test(m.name ?? ""))).toHaveLength(0);
    // a datablock name must never equal a node name
    const nodeNames = new Set(names);
    expect(g.meshes.filter((m) => nodeNames.has(m.name ?? ""))).toHaveLength(0);
  });

  it("uses NO glTF extension — geometry is plain accessors (N.15)", () => {
    // The site ships no Draco decoder, so a re-export that turns compression
    // back on would load nothing. The exporter OMITS the two arrays rather than
    // writing empty ones, so absence is the passing shape.
    expect(g.extensionsUsed ?? [], "extensionsUsed").toEqual([]);
    expect(g.extensionsRequired ?? [], "extensionsRequired").toEqual([]);
    expect(JSON.stringify(g)).not.toContain("KHR_draco_mesh_compression");
    // …and every primitive really does carry readable accessors
    for (const m of g.meshes)
      for (const p of m.primitives) {
        expect(p.attributes?.POSITION, m.name).toBeTypeOf("number");
        expect(p.indices, m.name).toBeTypeOf("number");
      }
  });

  it("carries the measured N.12 counts", () => {
    expect(g.nodes.length, "nodes").toBe(227);
    expect(g.meshes.length, "meshes").toBe(194);
    expect(names.filter((n) => /^Element_/.test(n)).length, "glass").toBe(13);
    expect(names.filter((n) => /_Seg\d+$/.test(n)).length, "wedges").toBe(143);
    expect(g.scenes[0].nodes.length, "top-level groups").toBe(19);
    const wedgeGroups = new Set(
      names
        .filter((n) => /_Seg\d+$/.test(n))
        .map((n) => n.replace(/_Seg\d+$/, "")),
    );
    expect(wedgeGroups.size, "wedge groups").toBe(26);
  });

  it("seats every node at identity — no rotation anywhere (§9)", () => {
    expect(g.nodes.filter((n) => !isIdentity(n.rotation)).map((n) => n.name)) //
      .toEqual([]);
    // …and no node hides one in a baked TRS matrix, which `rotation` cannot see
    expect(g.nodes.filter((n) => n.matrix !== undefined).map((n) => n.name)) //
      .toEqual([]);
  });

  it("ships SEVEN distinct blade meshes, fan baked into the vertices", () => {
    // Seven baked meshes, not one datablock shared by seven nodes.
    const blades = g.nodes.filter((n) => /^Iris_Blade_\d+$/.test(n.name));
    expect(blades).toHaveLength(7);
    expect(new Set(blades.map((b) => b.mesh)).size, "distinct meshes").toBe(7);
    blades.forEach((b, i) => {
      expect(g.meshes[b.mesh!].name, `blade ${i + 1} datablock`).toBe(
        `Iris_Blade_0${i + 1}_geo`,
      );
      expect(isIdentity(b.rotation), `blade ${i + 1} seat is identity`).toBe(
        true,
      );
      expect(b.translation, `blade ${i + 1} pivot`).toBeTruthy();
    });
    // …and NOTHING in the file shares a datablock any more
    const users = new Map<number, number>();
    for (const n of g.nodes)
      if (n.mesh !== undefined) users.set(n.mesh, (users.get(n.mesh) ?? 0) + 1);
    expect(
      [...users.values()].filter((c) => c > 1),
      "shared datablocks",
    ).toEqual([]);
  });

  it("parents Focus_Arms and Focus_Carrier under Optics_G4_Focus (§10)", () => {
    // The re-parent arrives IN THE FILE: both nest under the focus shell, so
    // they ride the focus slide and share its explode rung — no site-side
    // re-parent list is needed.
    expect(names).toContain("Focus_Arms");
    const g4 = g.nodes.find((n) => n.name === "Optics_G4_Focus")!;
    const kids = (g4.children ?? []).map((c) => g.nodes[c].name);
    expect(kids).toContain("Focus_Arms");
    expect(kids).toContain("Focus_Carrier");
    // the carrier is still the only one of the pair that is wedge-cut
    expect(names.filter((n) => /^Focus_Carrier_Seg\d+$/.test(n))).toHaveLength(
      5,
    );
    expect(names.filter((n) => /^Focus_Arms_Seg\d+$/.test(n))).toHaveLength(0);
  });

  it("carries the STEP 4b names and none of the ones they replaced", () => {
    // The names ARE the API with the model pipeline, and each is keyed on
    // site-side (peelcards' tables, frames' SHELL_ADOPT, the parts regexes), so
    // a half-applied rename is a silent no-op rather than a crash.
    for (const n of [
      "Decal_DotMIJ",
      "Decal_BadgeDisc",
      "Shim_Ring_01",
      "Shim_Ring_02",
      "Baffle_Front",
      "Baffle_G2",
      "Baffle_Rear",
      "Mount_ScrewCounterbores",
    ])
      expect(names, n).toContain(n);
    const OLD = [
      /^Decal_Dot2$/,
      /^DecalT_BadgeDisc$/,
      /^Shim_Ring_[01](_Seg\d+)?$/,
      /^Optics_Baffle_/,
      /^Mount_ScrewBores$/,
    ];
    expect(names.filter((n) => OLD.some((re) => re.test(n)))).toEqual([]);
    // wedge children follow their stem — and the three that are not wedge-cut
    // still have no `_SegN` children
    for (const stem of [
      "Baffle_Front",
      "Baffle_G2",
      "Shim_Ring_01",
      "Shim_Ring_02",
    ])
      // prettier-ignore
      expect(
        names.filter((n) => n.startsWith(`${stem}_Seg`)),
        stem,
      ).toHaveLength(5);
    for (const stem of [
      "Decal_DotMIJ",
      "Decal_BadgeDisc",
      "Mount_ScrewCounterbores",
    ])
      expect(
        names.filter((n) => n.startsWith(`${stem}_Seg`)),
        stem,
      ).toHaveLength(0);
  });

  it("carries the MISNOMER names and none of the ones they replaced", () => {
    // The three optics CELLS dropped `Optics_` and the three structural tubes
    // dropped `Cam_`. Same hazard as above: core/names.ts keys peelcards'
    // TUBE_CUT and the parts predicates off these.
    for (const n of [
      "Cell_G3",
      "Cell_Collar",
      "Cell_Flange",
      "LightTrap",
      "OpticsCage",
      "RearTube",
    ])
      expect(names, n).toContain(n);
    // `Cam_` now means exactly the two REAL cam parts and nothing else
    const camParts = [
      ...new Set(
        names
          .filter((n) => n.startsWith("Cam_"))
          .map((n) => n.replace(/_Seg\d+$/, "")),
      ),
    ].sort();
    expect(camParts).toEqual(["Cam_Barrel", "Cam_Followers"]);
    const OLD = [/^Optics_Cell/, /^Cam_(LightTrap|OpticsCage|RearTube)/];
    expect(names.filter((n) => OLD.some((re) => re.test(n)))).toEqual([]);
    // all six are wedge-cut, so their wedges follow the new stem: 7 for the
    // three cells and the cage, 5 for the light trap and the rear tube
    for (const [stem, count] of [
      ["Cell_G3", 7],
      ["Cell_Collar", 7],
      ["Cell_Flange", 7],
      ["OpticsCage", 7],
      ["LightTrap", 5],
      ["RearTube", 5],
    ] as const)
      expect(
        names.filter((n) => n.startsWith(`${stem}_Seg`)),
        stem,
      ).toHaveLength(count);
  });

  it("gathers the focus block, the rear mount and the front pair (STEP 5)", () => {
    const node = (n: string) => g.nodes.find((x) => x.name === n)!;
    const kidsOf = (n: string) =>
      (node(n).children ?? []).map((c) => g.nodes[c].name).sort();
    expect(kidsOf("Grp_FocusDrive")).toEqual([
      "Focus_GuideRods",
      "Focus_LeadScrew",
      "Focus_Motor",
    ]);
    expect(kidsOf("Grp_MountRear")).toEqual([
      "Mount_BrassRing",
      "Mount_ChassisPlate",
      "Mount_EncoderStrip",
      "PCB_Rear",
      "Shim_Ring_01",
      "Shim_Ring_02",
    ]);
    // Optics_G1 is a NESTED group empty; the nesting is what keeps its two
    // elements on Barrel_Inner's ladder rung.
    expect(kidsOf("Optics_G1")).toEqual(["Element_01", "Element_02"]);
    expect(kidsOf("Barrel_Inner")).toContain("Optics_G1");
    const top = g.scenes[0].nodes.map((i) => g.nodes[i].name);
    expect(top).toContain("Grp_FocusDrive");
    expect(top).toContain("Grp_MountRear");
    expect(top).not.toContain("Optics_G1");

    // PURE IDENTITY, and the whole `Grp_` design rests on it: these carry no
    // mesh and NO transform key at all, so skipping them for naming (ops/frames
    // nameChain) cannot move anything.
    for (const n of ["Grp_FocusDrive", "Grp_MountRear", "Optics_G1"]) {
      const nd = node(n);
      expect(nd.mesh, `${n} carries no mesh`).toBeUndefined();
      expect(
        [nd.translation, nd.rotation, nd.scale, nd.matrix],
        `${n} is identity`,
      ).toEqual([undefined, undefined, undefined, undefined]);
    }

    // …and the five REAL re-parents, which do surrender their rungs
    expect(kidsOf("PCB_Rear")).toContain("PCB_Components");
    expect(kidsOf("Mount_ContactShelf")).toContain("Mount_Contacts");
    for (const s of [
      "Mount_Screws",
      "Mount_ScrewCounterbores",
      "Mount_FlangeScrews",
    ])
      expect(kidsOf("Mount_Bayonet"), s).toContain(s);
  });
});

// ── The derived ladder, on the SHIPPED hierarchy ────────────────────────────
//
// The fixture rebuilds the shipped NODE GRAPH — names, parenting, translations
// — and hangs one triangle off every mesh node. The ladder's GROUP MEMBERSHIP
// is derived from the graph alone, so the group set below is the browser's.
// (The rung VALUES are not: they measure geometry this fixture lacks.)

/** A small triangle, offset off the axis so R > 0 and the span is real. */
function tri(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([5, 0, 0, 5, 1, 0.4, 5.4, 0.5, 0.2]),
      3,
    ),
  );
  geo.setIndex([0, 1, 2]);
  return geo;
}

function shippedGraph(): THREE.Object3D {
  const g = glbJson(MODEL);
  const root = new THREE.Object3D();
  root.name = "lens";
  const objs = g.nodes.map((n) => {
    const o =
      n.mesh !== undefined ? new THREE.Mesh(tri()) : new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    return o;
  });
  g.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) objs[i].add(objs[c]);
  });
  for (const i of g.scenes[0].nodes) root.add(objs[i]);
  return root;
}

describe("the derived explode ladder of the shipped hierarchy", () => {
  const root = shippedGraph();
  const { ladderRungs } = deriveFrames(root);
  const groups = [...ladderRungs.keys()].sort();

  it("frames every mesh node in the file", () => {
    // dev/model-contract's frameScan, run headless: a mesh with no frame is a
    // NaN source for every op that normalizes over it.
    const unframed: string[] = [];
    let meshes = 0;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      meshes++;
      if (!frameOf(o.geometry)) unframed.push(o.name);
    });
    expect(meshes, "mesh nodes").toBe(194);
    expect(unframed).toEqual([]);
  });

  it("derives 26 groups — the `Grp_` empties are transparent", () => {
    // 26, not 19: without the `Grp_` skip in ops/frames nameChain, the three
    // focus-drive parts and the six rear-mount ones collapse onto two rungs.
    expect(groups).toHaveLength(26);
    expect(groups.filter((n) => n.startsWith("Grp_")), "no Grp_ group").toEqual([]); // prettier-ignore
    for (const n of [
      "Focus_Motor",
      "Focus_LeadScrew",
      "Focus_GuideRods",
      "Mount_ChassisPlate",
      "Mount_EncoderStrip",
      "Mount_BrassRing",
      "Shim_Ring_01",
      "Shim_Ring_02",
      "PCB_Rear",
    ])
      expect(groups, `${n} keeps its own rung`).toContain(n);
  });

  it("merges exactly the five parts that were re-parented onto their hosts", () => {
    // These surrendered their rungs model-side: each now rides the part it is
    // fastened to. A merge REAPPEARING as its own group means the re-parent was
    // undone in the export.
    for (const n of [
      "PCB_Components",
      "Mount_Contacts",
      "Mount_Screws",
      "Mount_ScrewCounterbores",
      "Mount_FlangeScrews",
    ])
      expect(groups, `${n} rides its host`).not.toContain(n);
  });

  it("keeps the front pair on Barrel_Inner's rung through Optics_G1", () => {
    // The nested group empty is NOT a `Grp_`, so topmost-wins still lands
    // Element_01/02 on Barrel_Inner — which is what makes the count 26, not 27.
    expect(groups).not.toContain("Optics_G1");
    expect(groups).not.toContain("Element_01");
    expect(groups).toContain("Barrel_Inner");
  });
});

/** The shipped graph with REAL geometry — the radii the rank/layer partition is
 *  measured from. `shippedGraph` above stands a triangle in for every mesh,
 *  which is enough for the ladder's node walk and useless for anything metric. */
function shippedModel(): THREE.Object3D {
  const { json, bin } = glbChunks(MODEL);
  const geos = json.meshes.map((m) => {
    const prim = m.primitives[0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        accessor(json, bin, prim.attributes!.POSITION) as Float32Array,
        3,
      ),
    );
    geo.setIndex(
      new THREE.BufferAttribute(
        accessor(json, bin, prim.indices!) as Uint32Array,
        1,
      ),
    );
    return geo;
  });
  const objs = json.nodes.map((n) => {
    const o =
      n.mesh !== undefined
        ? new THREE.Mesh(geos[n.mesh])
        : new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  json.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) objs[i].add(objs[c]);
  });
  const root = new THREE.Object3D();
  root.name = "lens";
  for (const i of json.scenes[0].nodes) root.add(objs[i]);
  return root;
}

describe("the LAYER PARTITION the per-piece stagger reads", () => {
  // A TRIPWIRE OVER THE EXPORT: `layerN`/`phase` come from 0.01mm radius
  // buckets sorted by meridian, and the ending's stagger keys each piece's
  // slice of the explode channel on that phase. A re-export nudging one radius
  // across a bucket edge re-indexes both layers and moves every arrival.
  const root = shippedModel();
  const { layerCount } = deriveFrames(root);
  // a piece's layer population, off the derived table (no lane carries it)
  const layerN = (f: Frame): number => layerCount.get(rankKeyOf(f.R)) ?? 1;

  it("buckets the 194 pieces into the histogram the stagger was tuned on", () => {
    const hist = new Map<number, number>();
    let meshes = 0;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      meshes++;
      const f = frameOf(o.geometry);
      expect(f, `${o.name} is framed`).not.toBeNull();
      hist.set(layerN(f!), (hist.get(layerN(f!)) ?? 0) + 1);
    });
    expect(meshes).toBe(194);
    // layer SIZE → pieces living in a layer of that size
    expect(Object.fromEntries([...hist].sort((a, b) => a[0] - b[0]))).toEqual({
      1: 48,
      2: 34,
      3: 20,
      4: 4,
      5: 67,
      7: 21,
    });
  });

  it("gives every piece of a layer its own phase, evenly spaced", () => {
    // the stagger divides the channel by this: a duplicate phase inside a layer
    // would put two pieces on one slice and leave a gap in the sequence
    const byLayer = new Map<number, number[]>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const f = frameOf(o.geometry)!;
      // the phase is i/n, so the layer's own key is (n, rounded rank)
      const key = layerN(f) * 1e4 + Math.round(f.rank * 1e3);
      const list = byLayer.get(key) ?? [];
      list.push(f.phase);
      byLayer.set(key, list);
    });
    for (const [key, phases] of byLayer) {
      for (const ph of phases) {
        expect(ph, `layer ${key}`).toBeGreaterThanOrEqual(0);
        expect(ph, `layer ${key}`).toBeLessThan(1);
      }
    }
  });
});

describe("the RADIAL DEPTH lane the bend cast reads", () => {
  // The ending's rebend re-curves every sheet-like piece THINNER than
  // DEPTH_THIN onto its ring and slides the rest rigid (ops/house.ts
  // bendTerm), so where the shipped pieces fall against that threshold is what
  // the park looks like. Measured here so a re-export that thickens a shell
  // past the cut, or a threshold nudge that catches a body, fails with names.
  const root = shippedModel();
  deriveFrames(root);

  const ctxOf = (f: Frame): OpCtx<number> => ({
    A: NUM, t0: f.t0, R: f.R, rank01: f.rank, layerPhase: f.phase, halfSpan: f.span / 2, partClass: f.cls, phi: 0, d: 0, L: 0, yN: 0, off: 0, rung: f.rung, axi: f.axi, depth: f.depth, adopted: f.adopted, channel: 0, gateAt: () => ({ flight: 0, stick: 0 }), flight: 0, stick: 0, wrapDir: WRAP_DIR }); // prettier-ignore

  /** every own-framed sheet-like piece, by name → depth */
  const sheets = new Map<string, number>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const f = frameOf(o.geometry)!;
    if (f.adopted || sheetTerm(NUM, ctxOf(f)) !== 1) return;
    sheets.set(o.name, f.depth);
  });
  const group = (name: string) => name.replace(/_Seg\d+$/, "");

  it("cuts between the shells and the bodies with a margin on both sides", () => {
    let below = ["", 0];
    let above = ["", 1];
    for (const [name, depth] of sheets) {
      if (depth < DEPTH_THIN && depth > (below[1] as number)) below = [name, depth]; // prettier-ignore
      if (depth >= DEPTH_THIN && depth < (above[1] as number)) above = [name, depth]; // prettier-ignore
    }
    expect(sheets.size).toBe(139);
    expect(DEPTH_THIN - (below[1] as number), `thinnest side: ${below[0]}`).toBeGreaterThan(0.01); // prettier-ignore
    expect((above[1] as number) - DEPTH_THIN, `deep side: ${above[0]}`).toBeGreaterThan(0.025); // prettier-ignore
  });

  it("holds the plates, the bezel lip, the boards and the focus arms rigid — and nothing else", () => {
    const deep = new Set<string>();
    for (const [name, depth] of sheets)
      if (depth >= DEPTH_THIN) deep.add(group(name));
    expect([...deep].sort()).toEqual([
      "Baffle_G2",
      "Baffle_Rear",
      "Barrel_Inner",
      "Focus_Arms",
      "Mount_Bayonet",
      "PCB_Rear",
    ]);
    expect([...sheets.values()].filter((d) => d >= DEPTH_THIN)).toHaveLength(26); // prettier-ignore
    // the kept-class shells the class cast used to hold rigid are all thin
    for (const g of [
      "Focus_Carrier",
      "Mount_ChassisPlate",
      "Mount_BrassRing",
      "Shim_Ring_01",
    ])
      // prettier-ignore
      for (const [name, depth] of sheets)
        if (group(name) === g) expect(depth, name).toBeLessThan(DEPTH_THIN);
  });

  it("hands bolted hardware its host's depth, so it bends or rides with its shell", () => {
    const depthOf = (name: string): number =>
      frameOf((root.getObjectByName(name) as THREE.Mesh).geometry)!.depth;
    const wedges = (host: string): number[] =>
      [0, 1, 2, 3, 4].map((i) => depthOf(`${host}_Seg${i}`));
    // exactly a host wedge's float, not the feature's own measurement
    expect(wedges("Chassis_Fixed")).toContain(depthOf("Focus_Motor"));
    expect(depthOf("Focus_Motor")).toBeLessThan(DEPTH_THIN);
    expect(wedges("Mount_Bayonet")).toContain(depthOf("Mount_Screws"));
    expect(depthOf("Mount_Screws")).toBeGreaterThan(DEPTH_THIN);
  });
});

// ── The two laws the mechanism leans on ─────────────────────────────────────

/** A blade-shaped sector at LOCAL meridian 0, off the optical axis. */
function bladeGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const a = -0.35 + (0.7 * i) / steps;
    for (const r of [6, 11]) pos.push(r * Math.cos(a), -0.2, r * Math.sin(a));
  }
  for (let i = 0; i < steps; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  geo.setIndex(idx);
  return geo;
}

/** A 7-cut shell, so the model has a radius spread and a ladder anchor. */
function shell(root: THREE.Object3D, name: string, radius: number): void {
  const grp = new THREE.Object3D();
  grp.name = name;
  for (let i = 0; i < 7; i++) {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k <= 4; k++) {
      const a = (TAU * i) / 7 + ((TAU / 7) * k) / 4;
      pos.push(radius * Math.cos(a), -3, radius * Math.sin(a));
      pos.push(radius * Math.cos(a), 3, radius * Math.sin(a));
    }
    for (let k = 0; k < 4; k++) {
      const b = k * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(pos), 3),
    );
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo);
    m.name = `${name}_Seg${i}`;
    grp.add(m);
  }
  root.add(grp);
}

/** Seven blades seated either by BAKED vertices (what ships today) or by a node
 *  QUATERNION — the latter set the way GLTFLoader sets it, which is the whole
 *  point: three then decomposes `.rotation` to x = z = π for a seat past 90°. */
function build(mode: "baked" | "node-seat", seats: number[]) {
  const root = new THREE.Object3D();
  root.name = "root";
  shell(root, "Chassis_Fixed", 24);
  const housing = new THREE.Object3D();
  housing.name = "Iris_Housing";
  root.add(housing);
  const blades: THREE.Mesh[] = [];
  seats.forEach((ang, i) => {
    const m =
      mode === "baked"
        ? new THREE.Mesh(bladeGeo().rotateY(ang))
        : new THREE.Mesh(bladeGeo());
    if (mode === "node-seat") m.quaternion.setFromAxisAngle(Y, ang);
    m.name = `Iris_Blade_0${i + 1}`;
    housing.add(m);
    blades.push(m);
  });
  deriveFrames(root);
  root.updateWorldMatrix(true, true);
  return { root, blades };
}

/** A node's seat angle about Y, read off the QUATERNION — never off
 *  `.rotation`, whose decomposition is the thing these tests survive. */
function seatOf(o: THREE.Object3D): number {
  const v = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion);
  return Math.atan2(-v.z, v.x);
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** World-space displaced vertices of one mesh, through the real op field. */
function worldVerts(mesh: THREE.Mesh): number[] {
  const n = mesh.geometry.getAttribute("position").count;
  const out = new Float32Array(n * 3);
  displaceInto(mesh.geometry, out, null);
  const v = new THREE.Vector3();
  const res: number[] = [];
  for (let i = 0; i < n; i++) {
    v.set(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]).applyMatrix4(
      mesh.matrixWorld,
    );
    res.push(v.x, v.y, v.z);
  }
  return res;
}

const FAN = Array.from({ length: 7 }, (_, i) => (i * TAU) / 7);

describe("the aperture drive composes onto a node's seat", () => {
  // Every shipped seat is identity today, but the pipeline has put the fan on
  // the nodes before, so the composing behaviour is pinned too.

  it("keeps seven seats distinct and correctly swept, at every aperture", () => {
    const { root, blades } = build("node-seat", FAN);
    const mech = createMechanism(root);
    for (const aperture of [0, 0.37, 1]) {
      mech.update({ zoom: 0, focus: 0, aperture, huddle: 0 });
      const closeRad = (MECHANISM.irisCloseDeg * aperture * Math.PI) / 180;
      blades.forEach((b, i) => {
        expect(
          wrap(seatOf(b) - closeRad),
          `blade 0${i + 1} @ ap ${aperture}`,
        ).toBeCloseTo(wrap(FAN[i]), 5);
      });
      expect(
        new Set(blades.map((b) => seatOf(b).toFixed(5))).size,
        `distinct @ ap ${aperture}`,
      ).toBe(7);
    }
  });

  it("sweeps ALL SEVEN the same way — the mirrored-blade bug", () => {
    // Seats 04..07 sit past 90°, where `Object3D.rotation` decomposes to
    // x = z = π with a mirrored y. An additive EULER drive turned those blades
    // the wrong way; composing quaternions cannot.
    const { root, blades } = build("node-seat", FAN);
    const mech = createMechanism(root);
    mech.update({ zoom: 0, focus: 0, aperture: 0, huddle: 0 });
    const rest = blades.map(seatOf);
    mech.update({ zoom: 0, focus: 0, aperture: 1, huddle: 0 });
    const deltas = blades.map((b, i) => wrap(seatOf(b) - rest[i]));
    for (const [i, d] of deltas.entries())
      expect(d, `blade 0${i + 1} sweep`).toBeCloseTo(deltas[0], 6);
    expect(Math.abs(deltas[0]), "a real sweep").toBeGreaterThan(0.1);
    expect(new Set(deltas.map((d) => Math.sign(d))).size, "one direction").toBe(
      1,
    );
  });

  it("leaves an identity-seated part on the plain absolute behaviour", () => {
    // What the shipped file actually does today (§9).
    const { root, blades } = build("baked", new Array(7).fill(0));
    const mech = createMechanism(root);
    mech.update({ zoom: 0, focus: 0, aperture: 1, huddle: 0 });
    const closeRad = (MECHANISM.irisCloseDeg * Math.PI) / 180;
    for (const b of blades) expect(seatOf(b)).toBeCloseTo(wrap(closeRad), 6);
  });
});

describe("a seat may live in the vertices or on the node", () => {
  // Frames are measured in the mesh's LOCAL space (the shader's `position`
  // space), so a node-seated blade measures a different t0 from a baked one.
  // That is safe only because every op consumes `theta - t0`, `r` and `y`, all
  // invariant under rotation about the optical axis. An op that reads an
  // ABSOLUTE meridian fails here.

  it("deforms to the same world geometry either way, on every channel", () => {
    for (const channel of [null, ...RECIPE_NAMES]) {
      const A = build("baked", FAN);
      const B = build("node-seat", FAN);
      if (channel) recipeChannel(channel).value = 1;
      try {
        for (let b = 0; b < 7; b++) {
          const wa = worldVerts(A.blades[b]);
          const wb = worldVerts(B.blades[b]);
          expect(wa.length).toBe(wb.length);
          for (let i = 0; i < wa.length; i++)
            expect(
              Math.abs(wa[i] - wb[i]),
              `${channel ?? "seated"} blade ${b} comp ${i}`,
            ).toBeLessThan(1e-4);
        }
      } finally {
        if (channel) recipeChannel(channel).value = 0;
      }
    }
  });

  it("…and the deform really moves them, so that is not a seated tie", () => {
    const { blades } = build("node-seat", FAN);
    const before = worldVerts(blades[3]);
    recipeChannel("explode").value = 1;
    try {
      const after = worldVerts(blades[3]);
      let max = 0;
      for (let i = 0; i < before.length; i++)
        max = Math.max(max, Math.abs(before[i] - after[i]));
      expect(max, "explode displacement").toBeGreaterThan(1);
    } finally {
      recipeChannel("explode").value = 0;
    }
  });
});

describe("the huddle drive — the cards chapter's compact core", () => {
  const rig = () => {
    const root = new THREE.Object3D();
    for (const name of ["Grp_MountRear", "Grp_FocusDrive", "Barrel_Inner"]) {
      const g = new THREE.Object3D();
      g.name = name;
      const m = new THREE.Mesh(bladeGeo());
      m.name = `${name}_child`;
      g.add(m);
      root.add(g);
    }
    return root;
  };

  it("at channel 0 every rider sits EXACTLY on its seat — /lens never moves", () => {
    const root = rig();
    const mech = createMechanism(root);
    mech.update({ zoom: 0, focus: 0, aperture: 0, huddle: 0 });
    for (const n of ["Grp_MountRear", "Grp_FocusDrive", "Barrel_Inner"])
      expect(root.getObjectByName(n)!.position.y, n).toBe(0);
  });

  it("draws the core compact by its own mm table, composing with zoom", () => {
    const root = rig();
    const mech = createMechanism(root);
    mech.update({ zoom: 0, focus: 0, aperture: 0, huddle: 1 });
    const mm = MECHANISM.huddleMm;
    expect(root.getObjectByName("Grp_MountRear")!.position.y).toBeCloseTo(mm.Grp_MountRear, 9); // prettier-ignore
    expect(root.getObjectByName("Grp_FocusDrive")!.position.y).toBeCloseTo(mm.Grp_FocusDrive, 9); // prettier-ignore
    // the mount steps FRONTWARD (toward the stop) and the front pair drops
    // BACK — the two signs that make it a huddle rather than a slide
    expect(mm.Grp_MountRear).toBeGreaterThan(0);
    expect(mm.Barrel_Inner).toBeLessThan(0);
    // …and the sum with zoom is a sum, not an overwrite
    mech.update({ zoom: 1, focus: 0, aperture: 0, huddle: 1 });
    expect(root.getObjectByName("Barrel_Inner")!.position.y).toBeCloseTo(
      MECHANISM.zoomMm.Barrel_Inner + mm.Barrel_Inner,
      9,
    );
  });
});

describe("the lead screw's pivot, now that it has a real parent", () => {
  // `Focus_LeadScrew` hangs under `Grp_FocusDrive`, so createMechanism's runtime
  // `Focus_LeadScrew_Pivot` is INSERTED between the two. The shipped empty is
  // identity; a transformed holder is pinned too, because the `Grp_` design
  // rests on the insertion composing with whatever is above it.

  /** An off-axis rod, like the lead screw: away from the axis, along it. */
  function rodGeo(): THREE.BufferGeometry {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= 4; i++) {
      const y = -6 + 3 * i;
      pos.push(8, y, -0.6, 8.6, y, 0.6);
    }
    for (let i = 0; i < 4; i++) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(pos), 3),
    );
    geo.setIndex(idx);
    return geo;
  }

  /** A lens root whose lead screw hangs under `holder` (null = at the root, the
   *  pre-STEP-5 shape), with the screw seated at `seat`. */
  function rig(holder: string | null, seat: THREE.Vector3, holderAt = 0) {
    const root = new THREE.Object3D();
    root.name = "lens";
    shell(root, "Chassis_Fixed", 24);
    const screw = new THREE.Mesh(rodGeo());
    screw.name = "Focus_LeadScrew";
    let parent: THREE.Object3D = root;
    if (holder) {
      const grp = new THREE.Object3D();
      grp.name = holder;
      grp.position.set(0, holderAt, 0);
      root.add(grp);
      parent = grp;
    }
    screw.position.copy(seat);
    parent.add(screw);
    root.updateWorldMatrix(true, true);
    return { root, screw, holder: parent };
  }

  /** Every vertex of a mesh in ROOT space. */
  function verts(root: THREE.Object3D, mesh: THREE.Mesh): number[] {
    root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const a = mesh.geometry.getAttribute("position");
    const v = new THREE.Vector3();
    const out: number[] = [];
    for (let i = 0; i < a.count; i++) {
      v.fromBufferAttribute(a, i).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
    return out;
  }

  it("inserts the pivot BETWEEN the screw and the group empty", () => {
    const { root, screw, holder } = rig("Grp_FocusDrive", new THREE.Vector3());
    const before = verts(root, screw);
    createMechanism(root);
    const pivot = screw.parent!;
    expect(pivot.name).toBe("Focus_LeadScrew_Pivot");
    expect(pivot.parent, "the pivot took the screw's place").toBe(holder);
    expect(holder.children).not.toContain(screw);
    // …and the screw has not moved a micron: the insertion is a re-frame, not a
    // transform.
    const after = verts(root, screw);
    for (let i = 0; i < before.length; i++)
      expect(after[i], `vertex comp ${i}`).toBeCloseTo(before[i], 6);
  });

  it("spins the screw about its OWN axis, not the lens's", () => {
    const { root, screw } = rig("Grp_FocusDrive", new THREE.Vector3());
    const mech = createMechanism(root);
    mech.update({ zoom: 0, focus: 0, aperture: 0, huddle: 0 });
    const rest = verts(root, screw);
    const centre = (v: number[]) => {
      const c = [0, 0, 0];
      for (let i = 0; i < v.length; i += 3)
        for (const k of [0, 1, 2]) c[k] += (v[i + k] * 3) / v.length;
      return c;
    };
    mech.update({ zoom: 0, focus: 1, aperture: 0, huddle: 0 });
    const spun = verts(root, screw);
    // the rod really turned…
    let max = 0;
    for (let i = 0; i < rest.length; i++)
      max = Math.max(max, Math.abs(rest[i] - spun[i]));
    expect(max, "a real spin").toBeGreaterThan(0.1);
    // …about its own centre, which stayed where it was (an orbit about the lens
    // axis would have thrown the centre metres across the model)
    const [a, b] = [centre(rest), centre(spun)];
    for (const k of [0, 1, 2]) expect(b[k], `centre ${k}`).toBeCloseTo(a[k], 4);
  });

  it("composes with a holder that CARRIES a transform", () => {
    // The pivot is measured in its holder's space, so a screw seated at the
    // same place through a translated empty must land identically to one
    // parented at the root.
    const flat = rig(null, new THREE.Vector3(0, 9, 0));
    const nested = rig("Grp_FocusDrive", new THREE.Vector3(0, 2, 0), 7);
    const mechFlat = createMechanism(flat.root);
    const mechNested = createMechanism(nested.root);
    for (const focus of [0, 0.4, 1]) {
      mechFlat.update({ zoom: 0, focus, aperture: 0, huddle: 0 });
      mechNested.update({ zoom: 0, focus, aperture: 0, huddle: 0 });
      const a = verts(flat.root, flat.screw);
      const b = verts(nested.root, nested.screw);
      for (let i = 0; i < a.length; i++)
        expect(b[i], `focus ${focus}, comp ${i}`).toBeCloseTo(a[i], 5);
    }
  });
});
