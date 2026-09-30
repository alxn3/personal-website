import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { deriveFrames, frameOf, rankKeyOf, type Frame } from "../frames";
import { NUM } from "../algebra";
import { PART_CLASS } from "../ops";
import { DEPTH_THIN, sheetTerm } from "../house";
import { createMechanism, MECHANISM } from "../mechanism";
import { recipeChannel, RECIPE_NAMES } from "../host";
import { displaceInto } from "../../dev/ops-cpu";
import { makeCtx } from "./fixture";
import { TAU, group, mesh, shell, strip } from "./fixture-mesh";
import { MODEL, accessor, glb } from "../../core/__tests__/glb";

// The shipped GLB's structure, plus the mechanism behaviours that depend on it,
// so a model re-export that changes what the code expects fails here.

const isIdentity = (r?: number[]): boolean =>
  !r || [0, 0, 0].every((_, i) => Math.abs(r[i]) < 1e-9) && Math.abs(Math.abs(r[3]) - 1) < 1e-9; // prettier-ignore

const { json: g, bin } = glb(MODEL);
const names = g.nodes.map((n) => n.name);
const node = (n: string) => g.nodes.find((x) => x.name === n)!;
const kidsOf = (n: string) =>
  (node(n).children ?? []).map((c) => g.nodes[c].name).sort();
const wedgesOf = (stem: string) =>
  names.filter((n) => new RegExp(`^${stem}_Seg\\d+$`).test(n)).length;

describe("shipped lens_web_segmented.glb", () => {
  it("is material-less, extension-free, one primitive per mesh, `_geo` datablocks", () => {
    expect(g.materials ?? []).toHaveLength(0);
    // The site ships no Draco decoder; geometry is plain accessors.
    expect(g.extensionsUsed ?? [], "extensionsUsed").toEqual([]);
    expect(g.extensionsRequired ?? [], "extensionsRequired").toEqual([]);
    for (const m of g.meshes) {
      expect(m.primitives, m.name).toHaveLength(1);
      expect(m.name, "datablock name").toMatch(/_geo$/);
      // a datablock name must never equal a node name
      expect(names, m.name).not.toContain(m.name);
      expect(m.primitives[0].attributes.POSITION, m.name).toBeTypeOf("number");
      expect(m.primitives[0].indices, m.name).toBeTypeOf("number");
    }
  });

  it("has the expected counts, no node rotations or matrices, and no shared meshes", () => {
    expect(g.nodes.length, "nodes").toBe(227);
    expect(g.meshes.length, "meshes").toBe(194);
    expect(names.filter((n) => /^Element_/.test(n)).length, "glass").toBe(13);
    expect(names.filter((n) => /_Seg\d+$/.test(n)).length, "wedges").toBe(143);
    expect(g.scenes[0].nodes.length, "top-level groups").toBe(19);
    const stems = new Set(names.filter((n) => /_Seg\d+$/.test(n)).map((n) => n.replace(/_Seg\d+$/, ""))); // prettier-ignore
    expect(stems.size, "wedge groups").toBe(26);
    expect(g.nodes.filter((n) => !isIdentity(n.rotation) || n.matrix).map((n) => n.name)).toEqual([]); // prettier-ignore
    const meshes = g.nodes.flatMap((n) => (n.mesh === undefined ? [] : [n.mesh])); // prettier-ignore
    expect(new Set(meshes).size, "shared datablocks").toBe(meshes.length);
  });

  it("ships seven distinct blade meshes, fan baked into the vertices", () => {
    const blades = g.nodes.filter((n) => /^Iris_Blade_\d+$/.test(n.name));
    expect(blades).toHaveLength(7);
    blades.forEach((b, i) => {
      expect(g.meshes[b.mesh!].name).toBe(`Iris_Blade_0${i + 1}_geo`);
      expect(b.translation, `blade ${i + 1} pivot`).toBeTruthy();
    });
  });

  it("uses the current part names and none of the old ones", () => {
    // Code keys on these names, so a partial rename would fail silently.
    // Three optics cells dropped `Optics_`, three tubes dropped `Cam_`.
    for (const n of [
      "Decal_DotMIJ",
      "Decal_BadgeDisc",
      "Shim_Ring_01",
      "Shim_Ring_02",
      "Baffle_Front",
      "Baffle_G2",
      "Baffle_Rear",
      "Mount_ScrewCounterbores",
      "Cell_G3",
      "Cell_Collar",
      "Cell_Flange",
      "LightTrap",
      "OpticsCage",
      "RearTube",
      "Focus_Arms",
    ])
      // prettier-ignore
      expect(names, n).toContain(n);
    const OLD = [/^Decal_Dot2$/, /^DecalT_BadgeDisc$/, /^Shim_Ring_[01](_Seg\d+)?$/, /^Optics_Baffle_/, /^Mount_ScrewBores$/, /^Optics_Cell/, /^Cam_(LightTrap|OpticsCage|RearTube)/]; // prettier-ignore
    expect(names.filter((n) => OLD.some((re) => re.test(n)))).toEqual([]);
    // `Cam_` is only the two real cam parts
    const cams = new Set(names.filter((n) => n.startsWith("Cam_")).map((n) => n.replace(/_Seg\d+$/, ""))); // prettier-ignore
    expect([...cams].sort()).toEqual(["Cam_Barrel", "Cam_Followers"]);
    // wedges are named after their part; the uncut parts have none
    for (const [stem, count] of [
      ["Baffle_Front", 5],
      ["Baffle_G2", 5],
      ["Shim_Ring_01", 5],
      ["Shim_Ring_02", 5],
      ["Decal_DotMIJ", 0],
      ["Decal_BadgeDisc", 0],
      ["Mount_ScrewCounterbores", 0],
      ["Cell_G3", 7],
      ["Cell_Collar", 7],
      ["Cell_Flange", 7],
      ["OpticsCage", 7],
      ["LightTrap", 5],
      ["RearTube", 5],
      ["Focus_Carrier", 5],
      ["Focus_Arms", 0],
    ] as const)
      // prettier-ignore
      expect(wedgesOf(stem), stem).toBe(count);
  });

  it("groups the focus block, the rear mount, the front pair and the re-parented parts", () => {
    expect(kidsOf("Grp_FocusDrive")).toEqual(["Focus_GuideRods", "Focus_LeadScrew", "Focus_Motor"]); // prettier-ignore
    expect(kidsOf("Grp_MountRear")).toEqual(["Mount_BrassRing", "Mount_ChassisPlate", "Mount_EncoderStrip", "PCB_Rear", "Shim_Ring_01", "Shim_Ring_02"]); // prettier-ignore
    // Optics_G1 nests under Barrel_Inner, keeping its elements on that rung.
    expect(kidsOf("Optics_G1")).toEqual(["Element_01", "Element_02"]);
    const top = g.scenes[0].nodes.map((i) => g.nodes[i].name);
    expect(top).toEqual(expect.arrayContaining(["Grp_FocusDrive", "Grp_MountRear"])); // prettier-ignore
    expect(top).not.toContain("Optics_G1");
    // These groups have no mesh and no transform, so skipping them when naming
    // (ops/frames nameChain) changes nothing.
    for (const n of ["Grp_FocusDrive", "Grp_MountRear", "Optics_G1"]) {
      const { mesh: m, translation, rotation, scale, matrix } = node(n);
      expect([m, translation, rotation, scale, matrix], n).toEqual([undefined, undefined, undefined, undefined, undefined]); // prettier-ignore
    }
    // parts parented onto their hosts, so they follow them (the focus slide too)
    for (const [host, kid] of [
      ["Barrel_Inner", "Optics_G1"],
      ["Optics_G4_Focus", "Focus_Arms"],
      ["Optics_G4_Focus", "Focus_Carrier"],
      ["PCB_Rear", "PCB_Components"],
      ["Mount_ContactShelf", "Mount_Contacts"],
      ["Mount_Bayonet", "Mount_Screws"],
      ["Mount_Bayonet", "Mount_ScrewCounterbores"],
      ["Mount_Bayonet", "Mount_FlangeScrews"],
    ])
      // prettier-ignore
      expect(kidsOf(host), host).toContain(kid);
  });
});

// ── The shipped model, framed ───────────────────────────────────────────────
// The real node graph and geometry, through deriveFrames.

const root = new THREE.Object3D();
root.name = "lens";
const geos = g.meshes.map((m) => {
  const prim = m.primitives[0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(accessor(g, bin, prim.attributes.POSITION), 3)); // prettier-ignore
  geo.setIndex(new THREE.BufferAttribute(accessor(g, bin, prim.indices!), 1)); // prettier-ignore
  return geo;
});
const objs = g.nodes.map((n) => {
  const o = n.mesh !== undefined ? new THREE.Mesh(geos[n.mesh]) : new THREE.Object3D(); // prettier-ignore
  o.name = n.name;
  if (n.translation) o.position.fromArray(n.translation);
  if (n.rotation) o.quaternion.fromArray(n.rotation);
  if (n.scale) o.scale.fromArray(n.scale);
  return o;
});
g.nodes.forEach((n, i) => {
  for (const c of n.children ?? []) objs[i].add(objs[c]);
});
for (const i of g.scenes[0].nodes) root.add(objs[i]);
const { ladderRungs, layerCount } = deriveFrames(root);
const pieces: { name: string; f: Frame }[] = [];
root.traverse((o) => {
  if (o instanceof THREE.Mesh) pieces.push({ name: o.name, f: frameOf(o.geometry)! }); // prettier-ignore
});

describe("the derived explode ladder of the shipped hierarchy", () => {
  const groups = [...ladderRungs.keys()];

  it("derives 26 groups: `Grp_` empties skipped, re-parented parts merged into their hosts", () => {
    // Without the skip, the focus-drive and rear-mount parts would share two rungs.
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
      "Barrel_Inner",
    ])
      // prettier-ignore
      expect(groups, `${n} keeps its own rung`).toContain(n);
    // Each rides the part it is fastened to; one reappearing as its own group
    // means the export undid the parenting. Optics_G1 is not a `Grp_`, so its
    // elements join Barrel_Inner's group.
    for (const n of [
      "PCB_Components",
      "Mount_Contacts",
      "Mount_Screws",
      "Mount_ScrewCounterbores",
      "Mount_FlangeScrews",
      "Optics_G1",
      "Element_01",
    ])
      // prettier-ignore
      expect(groups, `${n} rides its host`).not.toContain(n);
  });
});

describe("the LAYER PARTITION the per-piece stagger reads", () => {
  // Layers are 0.01 mm radius buckets and the explode stagger keys on each
  // piece's phase in its layer, so a re-export that shifts a radius moves arrivals.
  const layerN = (f: Frame): number => layerCount.get(rankKeyOf(f.R)) ?? 1;

  it("frames all 194 pieces, bucketed into the histogram the stagger was tuned on", () => {
    // A mesh without a frame would feed NaNs into the ops.
    expect(pieces.filter((p) => !p.f).map((p) => p.name)).toEqual([]);
    expect(pieces).toHaveLength(194);
    const hist: Record<number, number> = {};
    for (const { f } of pieces) hist[layerN(f)] = (hist[layerN(f)] ?? 0) + 1;
    // layer size → number of pieces in layers of that size
    expect(hist).toEqual({ 1: 48, 2: 34, 3: 20, 4: 4, 5: 67, 7: 21 });
    for (const { name, f } of pieces) {
      expect(f.phase, name).toBeGreaterThanOrEqual(0);
      expect(f.phase, name).toBeLessThan(1);
    }
  });
});

describe("the RADIAL DEPTH lane the bend cast reads", () => {
  // Sheet pieces thinner than DEPTH_THIN bend; the rest move rigidly
  // (ops/house.ts bendTerm). Checks which shipped pieces land on each side.
  const isSheet = (f: Frame) =>
    sheetTerm(NUM, makeCtx({ halfSpan: f.span / 2, partClass: f.cls, axi: f.axi, adopted: f.adopted })) === 1; // prettier-ignore
  /** every non-adopted sheet piece */
  const sheets = pieces.filter(({ f }) => !f.adopted && isSheet(f));
  const stem = (name: string) => name.replace(/_Seg\d+$/, "");
  const depthOf = (name: string) => pieces.find((p) => p.name === name)!.f.depth; // prettier-ignore

  it("cuts between the shells and the bodies with a margin on both sides", () => {
    expect(sheets).toHaveLength(139);
    const thin = sheets.filter(({ f }) => f.depth < DEPTH_THIN);
    const deep = sheets.filter(({ f }) => f.depth >= DEPTH_THIN);
    expect(DEPTH_THIN - Math.max(...thin.map(({ f }) => f.depth)), "thinnest side").toBeGreaterThan(0.01); // prettier-ignore
    expect(Math.min(...deep.map(({ f }) => f.depth)) - DEPTH_THIN, "deep side").toBeGreaterThan(0.025); // prettier-ignore
  });

  it("holds the plates, the bezel lip, the boards and the focus arms rigid — and nothing else", () => {
    const deep = sheets.filter(({ f }) => f.depth >= DEPTH_THIN);
    expect(deep).toHaveLength(26);
    expect([...new Set(deep.map((p) => stem(p.name)))].sort()).toEqual(["Baffle_G2", "Baffle_Rear", "Barrel_Inner", "Focus_Arms", "Mount_Bayonet", "PCB_Rear"]); // prettier-ignore
    // the kept-class shells are all thin
    for (const { name, f } of sheets)
      if (
        [
          "Focus_Carrier",
          "Mount_ChassisPlate",
          "Mount_BrassRing",
          "Shim_Ring_01",
        ].includes(stem(name))
      )
        // prettier-ignore
        expect(f.depth, name).toBeLessThan(DEPTH_THIN);
  });

  it("gives bolted hardware its own depth, at least the host's", () => {
    const wedges = (host: string) => [0, 1, 2, 3, 4].map((i) => depthOf(`${host}_Seg${i}`)); // prettier-ignore
    // the focus motor and guide rods are deep solids on a thin chassis ring
    for (const w of wedges("Chassis_Fixed")) expect(w).toBeLessThan(0.02);
    expect(depthOf("Focus_Motor")).toBeGreaterThan(DEPTH_THIN);
    expect(depthOf("Focus_GuideRods")).toBeGreaterThan(DEPTH_THIN);
    // a thin screw on a deep mount takes the mount's depth
    expect(wedges("Mount_Bayonet")).toContain(depthOf("Mount_Screws"));
    expect(depthOf("Mount_Screws")).toBeGreaterThan(DEPTH_THIN);
  });

  it("every adopted piece's depth covers its own vertices", () => {
    // No vertex may lie outside the declared depth about R (decals use the host's).
    let adopted = 0;
    let decals = 0;
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        const f = frameOf(o.geometry, i)!;
        if (!f.adopted) continue;
        if (f.cls === PART_CLASS.decal) {
          decals++;
          continue;
        }
        adopted++;
        const wall = Math.abs(Math.hypot(pos.getX(i), pos.getZ(i)) - f.R) / f.R;
        expect(f.depth + 1e-5, `${o.name} vertex ${i}`).toBeGreaterThanOrEqual(wall); // prettier-ignore
      }
    });
    expect(adopted).toBeGreaterThan(1000);
    expect(decals).toBeGreaterThan(100);
  });
});

// ── Mechanism behaviour ─────────────────────────────────────────────────────

/** A strip from (r0, y0) to (r1, y1) swept over angles `as`, at local meridian 0. */
const sector = (as: number[], [r0, y0]: number[], [r1, y1]: number[]) =>
  strip(as.map((a) => [r0 * Math.cos(a), y0, r0 * Math.sin(a), r1 * Math.cos(a), y1, r1 * Math.sin(a)])); // prettier-ignore
/** A blade-shaped sector off the optical axis. */
const bladeGeo = () =>
  sector(Array.from({ length: 7 }, (_, i) => -0.35 + (0.7 * i) / 6), [6, -0.2], [11, -0.2]); // prettier-ignore
/** A 7-cut chassis shell, so the model has a radius spread and a ladder anchor. */
const chassis = () => shell("Chassis_Fixed", 24, 7, -3, 3, 4);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const FAN = Array.from({ length: 7 }, (_, i) => (i * TAU) / 7);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const drive = (aperture = 0, focus = 0, zoom = 0, huddle = 0) => ({ zoom, focus, aperture, huddle }); // prettier-ignore

/** Seven blades seated either in their vertices (as shipped) or by a node
 *  quaternion, set the way GLTFLoader does. */
function build(mode: "baked" | "node-seat", seats: number[]) {
  const blades = seats.map((ang, i) => {
    const m = mesh(`Iris_Blade_0${i + 1}`, mode === "baked" ? bladeGeo().rotateY(ang) : bladeGeo()); // prettier-ignore
    if (mode === "node-seat") m.quaternion.setFromAxisAngle(Y_AXIS, ang);
    return m;
  });
  const r = group("root", chassis(), group("Iris_Housing", ...blades));
  deriveFrames(r);
  r.updateWorldMatrix(true, true);
  return { root: r, blades };
}

/** A node's angle about Y, from its quaternion (`.rotation` flips past 90°). */
function seatOf(o: THREE.Object3D): number {
  const v = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion);
  return Math.atan2(-v.z, v.x);
}

/** World-space displaced vertices of one mesh, through the real op field. */
function worldVerts(m: THREE.Mesh): THREE.Vector3[] {
  const out = new Float32Array(m.geometry.getAttribute("position").count * 3);
  displaceInto(m.geometry, out, null);
  return Array.from({ length: out.length / 3 }, (_, i) => new THREE.Vector3().fromArray(out, i * 3).applyMatrix4(m.matrixWorld)); // prettier-ignore
}

describe("the aperture drive composes onto a node's seat", () => {
  // Shipped seats are identity, but a node-seated fan must work too.

  it("keeps seven seats distinct and correctly swept, all turning the same way, at every aperture", () => {
    // Blades past 90° would turn backwards with an Euler-angle drive.
    const { root: r, blades } = build("node-seat", FAN);
    const mech = createMechanism(r);
    const seats: number[][] = [];
    for (const aperture of [0, 0.37, 1]) {
      mech.update(drive(aperture));
      const closeRad = (MECHANISM.irisCloseDeg * aperture * Math.PI) / 180;
      seats.push(blades.map(seatOf));
      blades.forEach(
        (b, i) =>
        expect(wrap(seatOf(b) - closeRad), `blade 0${i + 1} @ ap ${aperture}`).toBeCloseTo(wrap(FAN[i]), 5), // prettier-ignore
      );
      expect(new Set(blades.map((b) => seatOf(b).toFixed(5))).size, `distinct @ ap ${aperture}`).toBe(7); // prettier-ignore
    }
    const sweeps = seats[2].map((s, i) => wrap(s - seats[0][i]));
    for (const [i, d] of sweeps.entries())
      expect(d, `blade 0${i + 1} sweep`).toBeCloseTo(sweeps[0], 6);
    expect(Math.abs(sweeps[0]), "a real sweep").toBeGreaterThan(0.1);
  });

  it("leaves an identity-seated part on the plain absolute behaviour", () => {
    const { root: r, blades } = build("baked", new Array(7).fill(0));
    createMechanism(r).update(drive(1));
    const closeRad = (MECHANISM.irisCloseDeg * Math.PI) / 180;
    for (const b of blades) expect(seatOf(b)).toBeCloseTo(wrap(closeRad), 6);
  });
});

describe("a seat may live in the vertices or on the node", () => {
  // Frames are measured in local space, so the two seatings get different t0.
  // Safe as long as no op reads an absolute angle.

  it("deforms to the same world geometry either way, on every channel, and the deform moves them", () => {
    const A = build("baked", FAN);
    const B = build("node-seat", FAN);
    const seated = worldVerts(B.blades[3]);
    for (const channel of [null, ...RECIPE_NAMES]) {
      if (channel) recipeChannel(channel).value = 1;
      try {
        for (let b = 0; b < 7; b++) {
          const wb = worldVerts(B.blades[b]);
          worldVerts(A.blades[b]).forEach(
            (v, i) =>
            expect(v.distanceTo(wb[i]), `${channel ?? "seated"} blade ${b} vertex ${i}`).toBeLessThan(1e-4), // prettier-ignore
          );
        }
        if (channel === "explode")
          expect(Math.max(...worldVerts(B.blades[3]).map((v, i) => v.distanceTo(seated[i]))), "explode displacement").toBeGreaterThan(1); // prettier-ignore
      } finally {
        if (channel) recipeChannel(channel).value = 0;
      }
    }
  });
});

describe("the huddle drive — the cards chapter's compact core", () => {
  it("sits on its seat at 0, draws the core compact by its own mm table, and composes with zoom", () => {
    const PARTS = ["Grp_MountRear", "Grp_FocusDrive", "Barrel_Inner"];
    const r = group("lens", ...PARTS.map((n) => group(n, mesh(`${n}_child`, bladeGeo())))); // prettier-ignore
    const y = (n: string) => r.getObjectByName(n)!.position.y;
    const mech = createMechanism(r);
    mech.update(drive());
    for (const n of PARTS) expect(y(n), n).toBe(0);
    const mm = MECHANISM.huddleMm;
    mech.update(drive(0, 0, 0, 1));
    expect(y("Grp_MountRear")).toBeCloseTo(mm.Grp_MountRear, 9);
    expect(y("Grp_FocusDrive")).toBeCloseTo(mm.Grp_FocusDrive, 9);
    // the mount moves forward and the front pair back
    expect(mm.Grp_MountRear).toBeGreaterThan(0);
    expect(mm.Barrel_Inner).toBeLessThan(0);
    mech.update(drive(0, 0, 1, 1));
    expect(y("Barrel_Inner")).toBeCloseTo(MECHANISM.zoomMm.Barrel_Inner + mm.Barrel_Inner, 9); // prettier-ignore
  });
});

describe("the lead screw's pivot under its parent group", () => {
  // createMechanism inserts `Focus_LeadScrew_Pivot` between the screw and its
  // parent; this must work under an identity or a transformed parent.

  /** A lens root with an off-axis rod (like the lead screw) under `holder`
   *  (null = the root), at `seat`. */
  function rig(holder: string | null, seatY = 0, holderAt = 0) {
    const r = group("lens", chassis());
    // away from the axis, along it
    const screw = mesh("Focus_LeadScrew", strip([0, 1, 2, 3, 4].map((i) => [8, -6 + 3 * i, -0.6, 8.6, -6 + 3 * i, 0.6]))); // prettier-ignore
    screw.position.set(0, seatY, 0);
    const parent = holder ? group(holder) : r;
    parent.position.set(0, holderAt, 0);
    if (holder) r.add(parent);
    parent.add(screw);
    r.updateWorldMatrix(true, true);
    return { root: r, screw, holder: parent };
  }

  /** Every vertex of a mesh in root space. */
  function verts(r: THREE.Object3D, m: THREE.Mesh): THREE.Vector3[] {
    r.updateWorldMatrix(true, true);
    const toRoot = new THREE.Matrix4().copy(r.matrixWorld).invert().multiply(m.matrixWorld); // prettier-ignore
    const a = m.geometry.getAttribute("position");
    return Array.from({ length: a.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(toRoot)); // prettier-ignore
  }
  const centre = (vs: THREE.Vector3[]) =>
    vs.reduce((c, v) => c.add(v), new THREE.Vector3()).divideScalar(vs.length);

  it("inserts the pivot between the screw and the group empty, leaving the screw in place", () => {
    const { root: r, screw, holder } = rig("Grp_FocusDrive");
    const before = verts(r, screw);
    createMechanism(r);
    const pivot = screw.parent!;
    expect(pivot.name).toBe("Focus_LeadScrew_Pivot");
    expect(pivot.parent, "the pivot took the screw's place").toBe(holder);
    expect(holder.children).not.toContain(screw);
    verts(r, screw).forEach((v, i) => expect(v.distanceTo(before[i]), `vertex ${i}`).toBeLessThan(5e-7)); // prettier-ignore
  });

  it("spins the screw about its own axis, not the lens's", () => {
    const { root: r, screw } = rig("Grp_FocusDrive");
    const mech = createMechanism(r);
    mech.update(drive());
    const rest = verts(r, screw);
    mech.update(drive(0, 1));
    const spun = verts(r, screw);
    expect(Math.max(...rest.map((v, i) => v.distanceTo(spun[i]))), "a real spin").toBeGreaterThan(0.1); // prettier-ignore
    // about its own centre, which stayed put
    expect(centre(spun).distanceTo(centre(rest))).toBeLessThan(5e-5);
  });

  it("works under a parent with a transform", () => {
    // Same world placement as a screw parented at the root.
    const flat = rig(null, 9);
    const nested = rig("Grp_FocusDrive", 2, 7);
    const mechFlat = createMechanism(flat.root);
    const mechNested = createMechanism(nested.root);
    for (const focus of [0, 0.4, 1]) {
      mechFlat.update(drive(0, focus));
      mechNested.update(drive(0, focus));
      const a = verts(flat.root, flat.screw);
      verts(nested.root, nested.screw).forEach((v, i) => expect(v.distanceTo(a[i]), `focus ${focus}, vertex ${i}`).toBeLessThan(5e-6)); // prettier-ignore
    }
  });
});
