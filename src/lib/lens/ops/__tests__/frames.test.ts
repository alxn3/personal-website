import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  deriveFrames,
  frameOf,
  FRAME_ATTRS,
  rankKeyOf,
  type Frame,
} from "../frames";
import { PART_CLASS } from "../ops";
import { TAU, group, mesh, shell, wedgeGeometry } from "./fixture-mesh";

// frames.ts on synthetic geometry built here (wedges, rings, boxes), so every
// expected value is a construction constant.

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** A closed tube: `steps` columns with no duplicated seam, so its centroid is
 *  on the axis. */
function ringGeometry(radius: number, yLo: number, yHi: number, steps = 24) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < steps; i++) {
    const [x, z] = [radius * Math.cos((TAU * i) / steps), radius * Math.sin((TAU * i) / steps)]; // prettier-ignore
    pos.push(x, yLo, z, x, yHi, z);
    const [b, c] = [i * 2, ((i + 1) % steps) * 2];
    idx.push(b, b + 1, c, b + 1, c + 1, c);
  }
  return indexed(pos, idx);
}

function indexed(pos: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3)); // prettier-ignore
  g.setIndex(idx);
  return g;
}

/** Several geometries merged into one buffer (islands of one mesh). */
function merge(...geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const g of geos) {
    const base = pos.length / 3;
    pos.push(...g.getAttribute("position").array);
    idx.push(...Array.from(g.getIndex()!.array, (i) => i + base));
  }
  return indexed(pos, idx);
}

/** An 8 × 4 × `size` box mesh centred at axial `y`, or at (x, y, z). */
const box = (name: string, y: number, size = 8, x = 0, z = 0) =>
  mesh(name, new THREE.BoxGeometry(size, 4, size).translate(x, y, z));

/** A root holding `children`, framed; returns the root and deriveFrames' result. */
function framed(
  children: THREE.Object3D[],
  overrides?: Parameters<typeof deriveFrames>[1],
) {
  const root = new THREE.Object3D();
  root.add(...children);
  return { root, ...deriveFrames(root, overrides) };
}

function named(root: THREE.Object3D, name: string): THREE.Mesh {
  const o = root.getObjectByName(name);
  if (!(o instanceof THREE.Mesh)) throw new Error(`no mesh ${name}`);
  return o;
}

/** A frame field's value on a mesh, asserting it is the same on every vertex. */
function constFrame(m: THREE.Mesh, field: keyof Frame): number {
  const f = frameOf(m.geometry);
  if (!f) throw new Error(`${m.name} carries no frame`);
  const n = m.geometry.getAttribute("position").count;
  for (let i = 1; i < n; i++)
    expect(frameOf(m.geometry, i)![field]).toBeCloseTo(f[field], 6);
  return f[field];
}

/** Every frame field except `cls` and `adopted`; pieces that match on these get
 *  identical deform inputs. */
const LANES = ["t0", "R", "span", "rank", "phase", "rung", "axi", "yMin", "yMax", "depth"] as const; // prettier-ignore

/** `m` carries exactly `host`'s frame on `lanes`, flagged as adopted. */
function expectAdopted(
  m: THREE.Mesh,
  host: THREE.Mesh,
  lanes: readonly (keyof Frame)[] = LANES,
) {
  for (const lane of lanes)
    expect(constFrame(m, lane), `${m.name} adopted lane: ${lane}`).toBeCloseTo(constFrame(host, lane), 9); // prettier-ignore
  expect(constFrame(m, "adopted")).toBe(1);
  expect(constFrame(host, "adopted")).toBe(0);
}

describe("deriveFrames — per-mesh measurement", () => {
  it("measures each wedge's sector centre, radius, span and axial extents, on every vertex", () => {
    const { root } = framed([
      shell("Shell_Inner", 20, 5, -5, 5),
      shell("Shell_Outer", 40, 7, -2, 8),
    ]);
    for (const [name, R, count, yLo, yHi] of [
      ["Shell_Inner", 20, 5, -5, 5],
      ["Shell_Outer", 40, 7, -2, 8],
    ] as const)
      // prettier-ignore
      for (let i = 0; i < count; i++) {
        const m = named(root, `${name}_Seg${i}`);
        expect(wrap(constFrame(m, "t0") - (TAU * i) / count)).toBeCloseTo(0, 3);
        expect(Math.abs(constFrame(m, "R") - R) / R).toBeLessThan(0.02);
        expect(constFrame(m, "span")).toBeCloseTo(TAU / count, 3);
        expect(constFrame(m, "yMin")).toBeCloseTo(yLo, 4);
        expect(constFrame(m, "yMax")).toBeCloseTo(yHi, 4);
        // the packed attributes, one item per vertex
        for (const { name: attr, size } of FRAME_ATTRS) {
          const a = m.geometry.getAttribute(attr);
          expect(a.count).toBe(m.geometry.getAttribute("position").count);
          expect(a.itemSize).toBe(size);
        }
      }
    expect(frameOf(new THREE.BufferGeometry())).toBeNull();
  });

  it("frames a merged multi-island mesh as one piece", () => {
    // Three wedges 120° apart in one mesh: one frame, and it's axisymmetric.
    const m = mesh("Merged_Wedges", merge(...[0, 1, 2].map((w) => wedgeGeometry(25, (TAU * w) / 3, TAU / 3 - 0.2, -3, 3)))); // prettier-ignore
    framed([m]);
    expect(constFrame(m, "t0")).toBe(0);
    expect(constFrame(m, "span")).toBeCloseTo(TAU, 6);
    expect(constFrame(m, "axi")).toBe(1);
    expect(constFrame(m, "yMin")).toBeCloseTo(-3, 4);
    expect(constFrame(m, "yMax")).toBeCloseTo(3, 4);
  });

  it("measures a PCB-like mesh (board + components) as one piece", () => {
    const board = wedgeGeometry(15, 0.5, 0.6, -4, 4);
    const parts = [0.3, 0.4, 0.5, 0.6, 0.7].map((t) => wedgeGeometry(16, t, 0.05, -0.5, 0.5, 2)); // prettier-ignore
    const m = mesh("PCB_Components_Seg0", merge(board, ...parts));
    framed([m, shell("Shell_Outer", 40, 5)]); // the shell widens the radius span
    for (const field of ["R", "rank", "phase"] as const) constFrame(m, field);
    expect(constFrame(m, "span")).toBeCloseTo(0.6, 3); // the board's extent…
    expect(wrap(constFrame(m, "t0") - 0.5)).toBeCloseTo(0, 3);
    expect(constFrame(m, "yMin")).toBeCloseTo(-4, 4);
    expect(constFrame(m, "yMax")).toBeCloseTo(4, 4);
    expect(constFrame(m, "axi")).toBe(0);
    expect(constFrame(m, "adopted")).toBe(0);
  });

  it("takes the median vertex radius, so one spike cannot move R, and floors R at 0.5 mm", () => {
    const spiked = mesh("Spiked", wedgeGeometry(20, 0, 1, -3, 3));
    spiked.geometry.getAttribute("position").setXYZ(0, 200, -3, 0); // 10× the radius
    // A flat on-axis disc: every radius is ~0.
    const onAxis = mesh("OnAxis", indexed([0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6], [0, 1, 2])); // prettier-ignore
    framed([spiked, onAxis]);
    expect(Math.abs(constFrame(spiked, "R") - 20) / 20).toBeLessThan(0.02);
    expect(constFrame(onAxis, "R")).toBeCloseTo(0.5, 6);
  });
});

describe("deriveFrames — ranks and layer phases", () => {
  it("ranks layers by radius value, not by order", () => {
    const { root, layerCount } = framed([
      shell("Shell_Inner", 20, 5),
      shell("Shell_Skin", 20.6, 3), // glued to the inner shell
      shell("Shell_Outer", 40, 7),
    ]);
    const rank = (name: string) => constFrame(named(root, `${name}_Seg0`), "rank"); // prettier-ignore
    expect(rank("Shell_Inner")).toBeCloseTo(0, 3);
    expect(rank("Shell_Outer")).toBeCloseTo(1, 3);
    // Ranking by order would put the 20.6mm skin at 0.5; by value it sits next
    // to its shell.
    expect(rank("Shell_Skin")).toBeGreaterThan(0);
    expect(rank("Shell_Skin")).toBeCloseTo(0.6 / 20, 2);
    expect(Object.fromEntries(layerCount)).toEqual({ 2000: 5, 2060: 3, 4000: 7 }); // prettier-ignore
  });

  it("steps layer phase by 1/count within a layer, ordered by t0", () => {
    const { root } = framed([shell("Shell_Inner", 20, 5), shell("Shell_Outer", 40, 7)]); // prettier-ignore
    for (const [name, count] of [
      ["Shell_Inner", 5],
      ["Shell_Outer", 7],
    ] as const) {
      // prettier-ignore
      const layer = Array.from({ length: count }, (_, i) => {
        const m = named(root, `${name}_Seg${i}`);
        return { t0: constFrame(m, "t0"), phase: constFrame(m, "phase") };
      }).sort((a, b) => a.t0 - b.t0);
      layer.forEach((p, i) => expect(p.phase, name).toBeCloseTo(i / count, 5));
    }
  });
});

describe("deriveFrames — feature adoption", () => {
  it("bolted features adopt the host wedge nearest in angle: its whole frame, but their own depth", () => {
    // Three screws, each its own mesh, at 33 mm and a few degrees off centre,
    // plus a box screw just off sector 0.
    const screws = [0, 1, 2].map((i) => mesh(`Screw_${i}`, wedgeGeometry(33, (TAU * i) / 5 + 0.12, 0.08, -1, 1, 2))); // prettier-ignore
    const boxScrew = box("Screw_A", -0.5, 2, 33 * Math.cos(0.12), 33 * Math.sin(0.12)); // prettier-ignore
    const { root, layerCount } = framed([
      shell("Mount_Bayonet", 30, 5, -4, 0),
      shell("Shell_Outer", 60, 5), // widens the radius span so rank < 1
      group("Mount_Screws", ...screws, boxScrew),
    ]);
    for (const [i, s] of [...screws, boxScrew].entries())
      expectAdopted(s, named(root, `Mount_Bayonet_Seg${i % 3}`), LANES.filter((l) => l !== "depth")); // prettier-ignore
    expect(constFrame(boxScrew, "span")).toBeCloseTo(TAU / 5, 3);
    // adopted pieces don't count toward the layer
    const host = named(root, "Mount_Bayonet_Seg0");
    expect(layerCount.get(rankKeyOf(constFrame(host, "R")))).toBe(5);
    expect([...layerCount.values()].reduce((a, b) => a + b, 0)).toBe(10);
    // Depth is the feature's own, measured about the host's R (0.137 here).
    expect(constFrame(host, "depth")).toBeLessThan(0.01);
    expect(constFrame(boxScrew, "depth")).toBeGreaterThan(0.13);
    expect(constFrame(boxScrew, "depth")).toBeLessThan(0.145);
  });

  it("an adopted feature's depth is its own about the host's R, at least the host's", () => {
    const rod = box("Rod_A", -2, 2, 15 * Math.cos(0.1), 15 * Math.sin(0.1));
    // a deep host: one vertex of every wedge pushed 30% out
    const bayonet = shell("Mount_Bayonet", 60, 5, -12, -8);
    bayonet.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const pos = o.geometry.getAttribute("position");
      pos.setXYZ(0, pos.getX(0) * 1.3, pos.getY(0), pos.getZ(0) * 1.3);
    });
    const notch = box("Mount_Notch", -10, 1, 60 * Math.cos(0.2), 60 * Math.sin(0.2)); // prettier-ignore
    const { root } = framed([
      shell("Chassis_Fixed", 30, 5, -4, 0),
      group("Focus_GuideRods", rod),
      bayonet,
      notch,
    ]);
    expect(constFrame(named(root, "Chassis_Fixed_Seg0"), "depth")).toBeLessThan(0.01); // prettier-ignore
    // (15 − 1.4) mm inside a 30 mm ring: ≈ 0.48 of R
    expect(constFrame(rod, "R")).toBeCloseTo(30, 3);
    expect(constFrame(rod, "depth")).toBeGreaterThan(0.45);
    expect(constFrame(rod, "depth")).toBeLessThan(0.55);
    // the tab's own is ~0.02, raised to the host's 0.3
    const bay = constFrame(named(root, "Mount_Bayonet_Seg0"), "depth");
    expect(bay).toBeCloseTo(0.3, 4);
    expect(constFrame(notch, "depth")).toBe(bay);
  });

  it("a decal adopts the wedge it is printed on, finding the host from its _Seg wedges", () => {
    // Each wedge has its own radius (30, 30.5, 31 …), so the right host is visible.
    const ring = group("Ring_Zoom", ...[0, 1, 2, 3, 4].map((i) => mesh(`Ring_Zoom_Seg${i}`, wedgeGeometry(30 + i * 0.5, (TAU * i) / 5, TAU / 5, -4, 4)))); // prettier-ignore
    const band = shell("Band_Mid", 20, 5, -2, 2); // the MESH-named seg shape
    // A numeral slightly off the ring and off sector 0's centre; a brand on the
    // band; a decal on the ring's flat front rim (constant y, extends radially).
    const numeral = mesh("DecalT_Zoom_18", wedgeGeometry(31, 0.1, 0.05, -1, 1, 2)); // prettier-ignore
    const brand = mesh("DecalT_Brand", wedgeGeometry(20.3, 0.1, 0.05, -0.5, 0.5, 2)); // prettier-ignore
    const bezel = mesh("DecalT_Bezel", wedgeGeometry(29.9, 0.1, 0.05, 3.9, 4, 2)); // prettier-ignore
    ring.add(numeral, bezel);
    band.add(brand);
    const { root } = framed([ring, band, shell("Shell_Outer", 60, 5)]);

    const wedge = named(root, "Ring_Zoom_Seg0");
    expect(constFrame(wedge, "R")).toBeCloseTo(30, 3);
    expectAdopted(numeral, wedge);
    expectAdopted(bezel, wedge);
    expectAdopted(brand, named(root, "Band_Mid_Seg0"));
    for (const m of [numeral, brand, bezel])
      expect(constFrame(m, "cls")).toBe(PART_CLASS.decal);
  });
});

describe("deriveFrames — axisymmetric guard", () => {
  it("pins a full ring to t0 = 0, span = 2π — by centroid, or by span for an off-axis lobe", () => {
    // A ring's centroid is on the axis, so its angle would be float noise. A
    // ring with a heavy lobe falls short of 2π by its angular gap, within the
    // 0.15 rad tolerance.
    const ring = mesh("Band_Mid", ringGeometry(18, -3, 3));
    const lobed = mesh("Shim_Ring", merge(ringGeometry(18, -3, 3, 96), wedgeGeometry(20, 0, 0.4, -1, 1, 60))); // prettier-ignore
    const { root } = framed([ring, lobed, shell("Shell_Outer", 40, 5)]);
    for (const m of [ring, lobed]) {
      expect(constFrame(m, "t0")).toBe(0);
      // A 2π span keeps it out of the sheet selection.
      expect(constFrame(m, "span")).toBeCloseTo(TAU, 6);
      expect(constFrame(m, "axi")).toBe(1);
    }
    expect(Math.abs(constFrame(ring, "R") - 18) / 18).toBeLessThan(0.02);
    const wedge = named(root, "Shell_Outer_Seg2");
    expect(constFrame(wedge, "axi")).toBe(0);
    expect(constFrame(wedge, "span")).toBeCloseTo(TAU / 5, 3);
  });
});

describe("deriveFrames — derived ladder", () => {
  const ladderScene = () => [
    box("Chassis_Fixed", 0), // the axial anchor
    box("Rear_Near", -10),
    box("Rear_Far", -30),
    box("Front_Near", 15),
    box("Front_Far", 40),
  ];
  const rungOf = (root: THREE.Object3D, name: string) =>
    constFrame(named(root, name), "rung");

  it("orders each side outward from the anchor with signed uniform steps; children share the group's rung", () => {
    const scene = ladderScene();
    const child = box("Element_09", 41, 3);
    scene[4].add(child);
    const { root, ladderRungs } = framed(scene);
    // rear: −70·i/2, front: +95·i/2
    for (const [name, rung] of [
      ["Rear_Near", -35],
      ["Rear_Far", -70],
      ["Front_Near", 47.5],
      ["Front_Far", 95],
      ["Chassis_Fixed", 0],
    ] as const) {
      // prettier-ignore
      expect(ladderRungs.get(name), name).toBeCloseTo(rung, 6);
      expect(rungOf(root, name), name).toBeCloseTo(rung, 4);
    }
    expect(constFrame(child, "rung")).toBeCloseTo(95, 4);
  });

  it.each([
    ["at the top level", (s: THREE.Object3D) => s],
    // ladderRungs is keyed by group, so the lookup must use the host's group.
    ["nested below the top level", (s: THREE.Object3D) => group("Barrel_Assembly", s)], // prettier-ignore
  ])("adopted features ride their host shell's rung, host %s", (_, place) => {
    const { root } = framed([...ladderScene(), place(shell("Mount_Bayonet", 30, 5, -52, -48)), box("Mount_Notch", -50, 2)]); // prettier-ignore
    const hostRung = rungOf(root, "Mount_Bayonet_Seg0");
    expect(hostRung).toBeLessThan(0);
    expect(rungOf(root, "Mount_Notch")).toBeCloseTo(hostRung, 4);
  });

  it("a group with own-framed pieces keeps its derived rung when a member adopts", () => {
    const drive = group("Focus_Drive", box("Focus_LeadScrew", -20), box("Mount_Notch", -50, 2)); // prettier-ignore
    const { root, ladderRungs } = framed([...ladderScene(), shell("Mount_Bayonet", 30, 5, -52, -48), drive]); // prettier-ignore
    const hostRung = rungOf(root, "Mount_Bayonet_Seg0");
    const driveRung = ladderRungs.get("Focus_Drive")!;
    expect(hostRung).toBeLessThan(0);
    expect(driveRung).toBeLessThan(0);
    expect(Math.abs(driveRung - hostRung)).toBeGreaterThan(1);
    expect(rungOf(root, "Focus_LeadScrew")).toBeCloseTo(driveRung, 4);
    expect(rungOf(root, "Mount_Notch")).toBeCloseTo(hostRung, 4);
  });

  it("tierOrder overrides win over the derived rung", () => {
    const { root, ladderRungs } = framed(ladderScene(), { tierOrder: { Front_Near: 12, Rear_Far: -5 } }); // prettier-ignore
    expect(ladderRungs.get("Front_Near")).toBeCloseTo(12, 6);
    expect(rungOf(root, "Front_Near")).toBeCloseTo(12, 4);
    expect(rungOf(root, "Rear_Far")).toBeCloseTo(-5, 4);
    // other parts keep the derived rung
    expect(rungOf(root, "Front_Far")).toBeCloseTo(95, 4);
  });

  it("overrides.anchorY moves the rear/front split plane", () => {
    // With the plane past every part, the whole model is "rear", ordered
    // outward from y = 50: Front_Far, Front_Near, Rear_Near, Rear_Far.
    const { root, ladderRungs } = framed(ladderScene(), { anchorY: 50 });
    expect(ladderRungs.get("Front_Far")).toBeCloseTo(-17.5, 6); // −70·1/4
    expect(ladderRungs.get("Front_Near")).toBeCloseTo(-35, 6);
    expect(ladderRungs.get("Rear_Far")).toBeCloseTo(-70, 6);
    expect(rungOf(root, "Front_Far")).toBeCloseTo(-17.5, 4);
  });

  it("places the ladder at 0 when there is no anchor part", () => {
    const { ladderRungs } = framed([box("Rear_Far", -30), box("Front_Far", 40)]); // prettier-ignore
    expect(ladderRungs.get("Rear_Far")).toBeCloseTo(-70, 6);
    expect(ladderRungs.get("Front_Far")).toBeCloseTo(95, 6);
  });
});

describe("deriveFrames — part classes", () => {
  it("classes each mesh from its name, or its nearest classed ancestor; Iris_Housing is structure", () => {
    const { root, layerCount } = framed([
      box("Element_05", 0),
      box("Iris_Blade_01", 0),
      box("DecalT_Brand", 0),
      box("Cam_Barrel_Seg0", 0),
      group("Iris_Blade_03", box("Cylinder012", 0)),
      shell("Iris_Housing", 16, 7),
      box("Iris_CamPlate", 0),
      box("Iris_ActuatorGear", 0),
    ]);
    const CLASSES: [string, number][] = [
      ["Element_05", PART_CLASS.glass],
      ["Iris_Blade_01", PART_CLASS.iris],
      ["DecalT_Brand", PART_CLASS.decal],
      ["Cam_Barrel_Seg0", PART_CLASS.structure],
      ["Cylinder012", PART_CLASS.iris],
      // only the aperture mechanism is iris
      ...Array.from({ length: 7 }, (_, i): [string, number] => [`Iris_Housing_Seg${i}`, PART_CLASS.structure]), // prettier-ignore
      ["Iris_CamPlate", PART_CLASS.iris],
      ["Iris_ActuatorGear", PART_CLASS.iris],
    ];
    for (const [name, cls] of CLASSES)
      expect(constFrame(named(root, name), "cls"), name).toBe(cls);
    // Its wedges form a 7-piece layer.
    const housing = named(root, "Iris_Housing_Seg0");
    expect(layerCount.get(rankKeyOf(constFrame(housing, "R")))).toBe(7);
  });

  it("skips accessories in the model pass, but frames one that is the root itself", () => {
    // Accessories load later, and scene.ts frames each with the accessory as
    // the root.
    const { root } = framed([box("Cam_Barrel_Seg0", 0), box("Acc_Hood", 0)]);
    expect(frameOf(named(root, "Cam_Barrel_Seg0").geometry)).not.toBeNull();
    expect(frameOf(named(root, "Acc_Hood").geometry)).toBeNull();
    const cap = box("Acc_CapRear", 0);
    deriveFrames(cap);
    expect(constFrame(cap, "cls")).toBe(PART_CLASS.accessory);
  });
});

describe("deriveFrames — radial depth", () => {
  /** A wedge with walls at R·(1 − d) and R·(1 + d): median R, depth d. */
  const thickWedge = (name: string, R: number, d: number) =>
    mesh(name, merge(wedgeGeometry(R * (1 - d), 0, 1, -5, 5), wedgeGeometry(R * (1 + d), 0, 1, -5, 5))); // prettier-ignore

  it("measures the widest wall offset as a fraction of R — a max, not a mean; 0 for a bare sheet", () => {
    const lobed = shell("Shell_Lobed", 20, 5);
    // one vertex pushed 8mm outward: 0.4 of R on an otherwise flat sheet
    const pos = (lobed.children[0] as THREE.Mesh).geometry.getAttribute("position"); // prettier-ignore
    pos.setXYZ(0, pos.getX(0) * 1.4, pos.getY(0), pos.getZ(0) * 1.4);
    const { root } = framed([
      shell("Shell_Thin", 20, 5),
      thickWedge("Plate_Seg0", 20, 0.3),
      thickWedge("Skin_Seg0", 40, 0.05),
      lobed,
    ]);
    const at = (name: string, field: keyof Frame) => constFrame(named(root, name), field); // prettier-ignore
    expect(at("Shell_Thin_Seg0", "depth")).toBeCloseTo(0, 5);
    expect(at("Plate_Seg0", "R")).toBeCloseTo(20, 4);
    expect(at("Plate_Seg0", "depth")).toBeCloseTo(0.3, 5);
    expect(at("Skin_Seg0", "depth")).toBeCloseTo(0.05, 5);
    expect(at("Shell_Lobed_Seg0", "R")).toBeCloseTo(20, 4);
    expect(at("Shell_Lobed_Seg0", "depth")).toBeCloseTo(0.4, 4);
  });
});

describe("deriveFrames — shared geometry", () => {
  it("un-shares an instanced geometry so every mesh keeps its own frame", () => {
    // GLTFLoader gives instanced meshes (e.g. the iris blades) one shared
    // geometry; without a clone the last frame written would win.
    const shared = wedgeGeometry(20, 0, 1, -3, 3);
    const twins = ["Twin_A", "Twin_B", "Twin_C"].map((n) => mesh(n, shared));
    framed(twins);
    // Each mesh has its own geometry and attribute buffers.
    expect(new Set(twins.map((m) => m.geometry)).size, "geometries").toBe(3);
    for (const { name } of FRAME_ATTRS)
      expect(new Set(twins.map((m) => m.geometry.getAttribute(name))).size, `${name} buffers`).toBe(3); // prettier-ignore
    twins[0].geometry.getAttribute("_opA").setX(0, 12345);
    expect(twins[1].geometry.getAttribute("_opA").getX(0)).not.toBe(12345);
  });
});
