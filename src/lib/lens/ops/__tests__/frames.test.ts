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

// frames.ts on SYNTHETIC geometry: cylinder-sector wedge shells and solid boxes
// built here, so every expected value (sector centre, radius, span, rung) is a
// construction constant rather than a measurement of the real model. No GPU is
// involved — BufferGeometry/Object3D are plain CPU objects.

const TAU = Math.PI * 2;
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** One cylinder-sector wedge: a two-row triangle strip at `radius`, centred on
 *  the `t0` meridian and `span` wide, spanning [yLo, yHi] axially. */
function wedgeGeometry(
  radius: number,
  t0: number,
  span: number,
  yLo: number,
  yHi: number,
  steps = 8,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = t0 - span / 2 + (span * i) / steps;
    const x = radius * Math.cos(a);
    const z = radius * Math.sin(a);
    pos.push(x, yLo, z, x, yHi, z);
  }
  for (let i = 0; i < steps; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  g.setIndex(idx);
  return g;
}

/** A segmented shell: `count` equal wedges under one named group, each in its
 *  own mesh named `<name>_Seg<i>`, sector centres at i·TAU/count. */
function shell(
  name: string,
  radius: number,
  count: number,
  yLo = -5,
  yHi = 5,
): THREE.Object3D {
  const group = new THREE.Object3D();
  group.name = name;
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      wedgeGeometry(radius, (TAU * i) / count, TAU / count, yLo, yHi),
    );
    mesh.name = `${name}_Seg${i}`;
    group.add(mesh);
  }
  return group;
}

/** A CLOSED tube of revolution: `steps` columns joined end to end (no duplicated
 *  seam column, so the centroid lands on the axis exactly as a real ring's does). */
function ringGeometry(
  radius: number,
  yLo: number,
  yHi: number,
  steps = 24,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (TAU * i) / steps;
    pos.push(
      radius * Math.cos(a),
      yLo,
      radius * Math.sin(a),
      radius * Math.cos(a),
      yHi,
      radius * Math.sin(a),
    );
  }
  for (let i = 0; i < steps; i++) {
    const b = i * 2;
    const c = ((i + 1) % steps) * 2;
    idx.push(b, b + 1, c, b + 1, c + 1, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  g.setIndex(idx);
  return g;
}

/** Several geometries welded into ONE buffer (islands of a single mesh), the way
 *  a real part arrives: a board sliver plus its soldered components, a ring plus
 *  its relief lobes. */
function merge(...geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const g of geos) {
    const p = g.getAttribute("position");
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const gi = g.getIndex();
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + base);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  out.setIndex(idx);
  return out;
}

function box(name: string, y: number, size = 8): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, 4, size).translate(0, y, 0),
  );
  mesh.name = name;
  return mesh;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

function named(root: THREE.Object3D, name: string): THREE.Mesh {
  const o = root.getObjectByName(name);
  if (!(o instanceof THREE.Mesh)) throw new Error(`no mesh ${name}`);
  return o;
}

/** The single value a per-piece frame field holds across one mesh (the meshes
 *  here are one component each, so the field is constant over the mesh). Read
 *  through `frameOf`, so no assertion has to know which packed lane a field
 *  lives in. */
function constFrame(mesh: THREE.Mesh, field: keyof Frame): number {
  const f = frameOf(mesh.geometry);
  if (!f) throw new Error(`${mesh.name} carries no frame`);
  const n = mesh.geometry.getAttribute("position").count;
  for (let i = 1; i < n; i++)
    expect(frameOf(mesh.geometry, i)![field]).toBeCloseTo(f[field], 6);
  return f[field];
}

/** Every lane the op pipeline reads as a piece's FRAME — i.e. everything except
 *  the two that say what the piece IS (`cls`, `adopted`). Two pieces agreeing on
 *  all of these present the deform with identical inputs. */
const LANES = [
  "t0",
  "R",
  "span",
  "rank",
  "phase",
  "rung",
  "axi",
  "yMin",
  "yMax",
  "layerN",
] as const satisfies readonly (keyof Frame)[];

/** Every distinct value of a per-vertex frame field on one mesh (one value per
 *  piece — and the mesh IS the piece unless it is an adopted feature). */
function distinctFrame(mesh: THREE.Mesh, field: keyof Frame): number[] {
  const n = mesh.geometry.getAttribute("position").count;
  const seen: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = frameOf(mesh.geometry, i)![field];
    if (!seen.some((s) => Math.abs(s - v) < 1e-5)) seen.push(v);
  }
  return seen.sort((x, y) => x - y);
}

describe("deriveFrames — per-mesh measurement", () => {
  it("measures each wedge's sector centre, radius, span and axial extents", () => {
    const root = new THREE.Object3D();
    root.add(shell("Shell_Inner", 20, 5, -5, 5));
    root.add(shell("Shell_Outer", 40, 7, -2, 8));
    deriveFrames(root);

    for (let i = 0; i < 5; i++) {
      const m = named(root, `Shell_Inner_Seg${i}`);
      expect(wrap(constFrame(m, "t0") - (TAU * i) / 5)).toBeCloseTo(0, 3);
      const R = constFrame(m, "R");
      expect(R).toBeGreaterThan(0);
      expect(Math.abs(R - 20) / 20).toBeLessThan(0.02);
      expect(constFrame(m, "span")).toBeCloseTo(TAU / 5, 3);
      expect(constFrame(m, "yMin")).toBeCloseTo(-5, 4);
      expect(constFrame(m, "yMax")).toBeCloseTo(5, 4);
    }
    for (let i = 0; i < 7; i++) {
      const m = named(root, `Shell_Outer_Seg${i}`);
      expect(wrap(constFrame(m, "t0") - (TAU * i) / 7)).toBeCloseTo(0, 3);
      expect(Math.abs(constFrame(m, "R") - 40) / 40).toBeLessThan(0.02);
      expect(constFrame(m, "span")).toBeCloseTo(TAU / 7, 3);
      expect(constFrame(m, "yMin")).toBeCloseTo(-2, 4);
      expect(constFrame(m, "yMax")).toBeCloseTo(8, 4);
    }
  });

  it("writes the packed frame attributes at their declared sizes", () => {
    const root = new THREE.Object3D();
    root.add(shell("Shell_Inner", 20, 5));
    deriveFrames(root);
    // Three attributes, no more: WebGPU allows only 8 vertex buffers per
    // pipeline, which is why the twelve frame fields are packed rather than
    // named. `_opY` is a vec4 — (yMin, yMax, layerN, adopted) — so the layer
    // population and the adoption flag ride along without costing a fourth
    // buffer.
    expect(FRAME_ATTRS.map((a) => a.name)).toEqual(["_opA", "_opB", "_opY"]);
    expect(FRAME_ATTRS.map((a) => a.size)).toEqual([4, 4, 4]);
    for (const m of meshesOf(root)) {
      const count = m.geometry.getAttribute("position").count;
      for (const { name, size } of FRAME_ATTRS) {
        const a = m.geometry.getAttribute(name);
        expect(a, `${m.name} missing ${name}`).toBeTruthy();
        expect(a.count).toBe(count);
        expect(a.itemSize).toBe(size);
      }
      expect(frameOf(m.geometry)).not.toBeNull();
    }
    expect(frameOf(new THREE.BufferGeometry())).toBeNull();
  });

  it("frames a merged multi-island mesh as ONE piece — the MESH is the unit", () => {
    // Three wedges MERGED into a single buffer. The classic stamped its
    // attributes per MESH and so does this pass: the islands do NOT get frames
    // of their own. (Framing islands separately is what broke the real
    // PCB/shim/tube meshes — see the case below.) Three wedges 120° apart
    // average to an ON-AXIS centroid and cover the whole turn, so the single
    // frame they share is the axisymmetric one.
    const mesh = new THREE.Mesh(
      merge(
        ...[0, 1, 2].map((w) =>
          wedgeGeometry(25, (TAU * w) / 3, TAU / 3 - 0.2, -3, 3),
        ),
      ),
    );
    mesh.name = "Merged_Wedges";
    const root = new THREE.Object3D();
    root.add(mesh);
    deriveFrames(root);

    expect(distinctFrame(mesh, "t0")).toEqual([0]);
    expect(distinctFrame(mesh, "span").length).toBe(1);
    expect(constFrame(mesh, "span")).toBeCloseTo(TAU, 6);
    expect(constFrame(mesh, "axi")).toBe(1);
    expect(constFrame(mesh, "yMin")).toBeCloseTo(-3, 4);
    expect(constFrame(mesh, "yMax")).toBeCloseTo(3, 4);
  });

  it("measures a PCB-like mesh (board sliver + scattered components) from the WHOLE mesh", () => {
    // The failure this pins: `PCB_Components_Seg3` is ONE mesh holding a board
    // sliver and dozens of soldered components. Per-island framing measured a
    // ~0.05 rad frame per solder blob, and the piece — which the classic stamped
    // as one sheet spanning the whole board — dropped out of the wrap. The mesh
    // must measure ONE frame, from its whole angular/axial extent.
    const board = wedgeGeometry(15, 0.5, 0.6, -4, 4);
    const parts = [0.3, 0.4, 0.5, 0.6, 0.7].map((t) =>
      wedgeGeometry(16, t, 0.05, -0.5, 0.5, 2),
    );
    const mesh = new THREE.Mesh(merge(board, ...parts));
    mesh.name = "PCB_Components_Seg0";
    const root = new THREE.Object3D();
    root.add(mesh);
    root.add(shell("Shell_Outer", 40, 5)); // widens the model's radius span
    deriveFrames(root);

    // constFrame asserts the field vertex by vertex: uniform across the mesh,
    // solder blobs included.
    for (const field of ["t0", "R", "span", "rank", "phase", "axi"] as const)
      constFrame(mesh, field);
    expect(constFrame(mesh, "span")).toBeCloseTo(0.6, 3); // the board's extent…
    expect(wrap(constFrame(mesh, "t0") - 0.5)).toBeCloseTo(0, 3);
    expect(constFrame(mesh, "yMin")).toBeCloseTo(-4, 4);
    expect(constFrame(mesh, "yMax")).toBeCloseTo(4, 4);
    expect(constFrame(mesh, "axi")).toBe(0);
    expect(constFrame(mesh, "adopted")).toBe(0);
  });

  it("takes the MEDIAN vertex radius, so one spike cannot move R", () => {
    const geo = wedgeGeometry(20, 0, 1, -3, 3);
    const p = geo.getAttribute("position");
    // drag one vertex out to 10× the radius: a mean would jump ~10%, a median not
    p.setXYZ(0, 200, -3, 0);
    const mesh = new THREE.Mesh(geo);
    mesh.name = "Spiked";
    const root = new THREE.Object3D();
    root.add(mesh);
    deriveFrames(root);
    expect(Math.abs(constFrame(mesh, "R") - 20) / 20).toBeLessThan(0.02);
  });

  it("clamps a degenerate on-axis component to R = 0.5mm", () => {
    // A flat on-axis disc: every vertex radius is ~0, which would divide by zero
    // downstream. The guard lives HERE, at the source.
    const pos: number[] = [0, 0, 0, 1e-6, 0, 0, 0, 0, 1e-6];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(pos), 3),
    );
    geo.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geo);
    mesh.name = "OnAxis";
    const root = new THREE.Object3D();
    root.add(mesh);
    deriveFrames(root);
    expect(constFrame(mesh, "R")).toBeCloseTo(0.5, 6);
  });
});

describe("deriveFrames — ranks and layer phases", () => {
  it("ranks layers by radius VALUE, not by order", () => {
    const root = new THREE.Object3D();
    root.add(shell("Shell_Inner", 20, 5));
    root.add(shell("Shell_Skin", 20.6, 3)); // glued to the inner shell
    root.add(shell("Shell_Outer", 40, 7));
    const { layerCount } = deriveFrames(root);

    expect(constFrame(named(root, "Shell_Inner_Seg0"), "rank")).toBeCloseTo(
      0,
      3,
    );
    expect(constFrame(named(root, "Shell_Outer_Seg0"), "rank")).toBeCloseTo(
      1,
      3,
    );
    // ORDER ranking would put the 20.6mm skin at 0.5; the VALUE law keeps it
    // next to the shell it is glued to.
    const skin = constFrame(named(root, "Shell_Skin_Seg0"), "rank");
    expect(skin).toBeGreaterThan(0);
    expect(skin).toBeLessThan(0.06);
    expect(skin).toBeCloseTo(0.6 / 20, 2);

    expect(layerCount.get(2000)).toBe(5);
    expect(layerCount.get(2060)).toBe(3);
    expect(layerCount.get(4000)).toBe(7);

    // …and each piece carries its OWN layer's population, which is what the
    // assemble sheet selector reads to tell a cut shell from a lone body.
    expect(constFrame(named(root, "Shell_Inner_Seg0"), "layerN")).toBe(5);
    expect(constFrame(named(root, "Shell_Skin_Seg0"), "layerN")).toBe(3);
    expect(constFrame(named(root, "Shell_Outer_Seg0"), "layerN")).toBe(7);
  });

  it("steps layer phase by 1/count within a layer, ordered by t0", () => {
    const root = new THREE.Object3D();
    root.add(shell("Shell_Inner", 20, 5));
    root.add(shell("Shell_Outer", 40, 7));
    deriveFrames(root);

    const readLayer = (name: string, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const m = named(root, `${name}_Seg${i}`);
        return { t0: constFrame(m, "t0"), phase: constFrame(m, "phase") };
      });

    const inner = readLayer("Shell_Inner", 5);
    expect(inner.map((p) => p.phase).sort((a, b) => a - b)).toEqual(
      [0, 0.2, 0.4, 0.6, 0.8].map((v) => expect.closeTo(v, 5)),
    );
    const outer = readLayer("Shell_Outer", 7);
    outer
      .map((p) => p.phase)
      .sort((a, b) => a - b)
      .forEach((p, i) => expect(p).toBeCloseTo(i / 7, 5));

    // phase order tracks t0 order within the layer
    const byT0 = [...inner].sort((a, b) => a.t0 - b.t0);
    byT0.forEach((p, i) => expect(p.phase).toBeCloseTo(i / 5, 5));
  });
});

describe("deriveFrames — feature adoption", () => {
  it("bolted features adopt the host shell's R, rank and nearest sector", () => {
    const root = new THREE.Object3D();
    root.add(shell("Mount_Bayonet", 30, 5, -4, 0));
    root.add(shell("Shell_Outer", 60, 5)); // widens the radius span so rank < 1
    // three screws, each its OWN mesh, sitting proud of the shell at 33mm and
    // off the sector centres by a few degrees
    const screws = new THREE.Object3D();
    screws.name = "Mount_Screws";
    for (let i = 0; i < 3; i++) {
      const t = (TAU * i) / 5 + 0.12;
      const m = new THREE.Mesh(wedgeGeometry(33, t, 0.08, -1, 1, 2));
      m.name = `Screw_${i}`;
      screws.add(m);
    }
    root.add(screws);
    deriveFrames(root);

    const hostR = constFrame(named(root, "Mount_Bayonet_Seg0"), "R");
    const hostRank = constFrame(named(root, "Mount_Bayonet_Seg0"), "rank");
    for (let i = 0; i < 3; i++) {
      const m = named(root, `Screw_${i}`);
      expect(constFrame(m, "R")).toBeCloseTo(hostR, 4);
      expect(constFrame(m, "rank")).toBeCloseTo(hostRank, 5);
      expect(wrap(constFrame(m, "t0") - (TAU * i) / 5)).toBeCloseTo(0, 3);
    }
  });

  it("adopts the host wedge's WHOLE frame — span, yExt and phase, not just R/t0", () => {
    // The failure this guards: a screw keeping its own ~0.08 rad / 2mm extent
    // normalizes over that extent and bends off the wedge it is bolted to (the
    // classic's "phantom card" inverted). It must ride the wedge's frame.
    const root = new THREE.Object3D();
    root.add(shell("Mount_Bayonet", 30, 5, -4, 0));
    const screws = new THREE.Object3D();
    screws.name = "Mount_Screws";
    const t = 0.12; // just off sector centre 0
    const screw = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2).translate(
        33 * Math.cos(t),
        -0.5,
        33 * Math.sin(t),
      ),
    );
    screw.name = "Screw_A";
    screws.add(screw);
    root.add(screws);
    const { layerCount } = deriveFrames(root);

    const host = named(root, "Mount_Bayonet_Seg0");
    expect(constFrame(screw, "span")).toBeCloseTo(constFrame(host, "span"), 6);
    expect(constFrame(screw, "span")).toBeCloseTo(TAU / 5, 3);
    expect(constFrame(screw, "yMin")).toBeCloseTo(-4, 4);
    expect(constFrame(screw, "yMax")).toBeCloseTo(0, 4);
    // …and the wedge's timeline slot, which is the point of adopting its frame.
    expect(constFrame(screw, "phase")).toBeCloseTo(
      constFrame(host, "phase"),
      6,
    );
    expect(constFrame(screw, "axi")).toBe(constFrame(host, "axi"));
    // …and it says so in the spare lane: `adopted` is the participation flag the
    // assemble sheet reads, so hardware rides whatever its host does.
    expect(constFrame(screw, "adopted")).toBe(1);
    expect(constFrame(host, "adopted")).toBe(0);

    // adopted features ride a wedge; they are not pieces OF the layer
    expect([...layerCount.values()].reduce((a, b) => a + b, 0)).toBe(5);
    expect(layerCount.get(rankKeyOf(constFrame(host, "R")))).toBe(5);
    // …but they REPORT the host layer's population, so bolted hardware counts
    // as segmented exactly like the shell it is bolted to and wraps with it.
    expect(constFrame(screw, "layerN")).toBe(5);
    expect(constFrame(host, "layerN")).toBe(5);
  });

  it("a DECAL adopts the wedge it is printed on, host DERIVED from the segmentation", () => {
    // The failure this pins: a printed marking derived its own frame (own
    // median R, own t0, own rank/layer), so every frame-driven op — spread's
    // radial direction and magnitude, the orbit, the wrap — moved it
    // DIFFERENTLY from the wedge it is printed on, and the zoom numerals
    // floated off the ring on explode. A decal adopts exactly like a
    // SHELL_ADOPT feature; only the HOST is derived rather than authored: the
    // nearest ancestor that owns `<name>_Seg<n>` wedge NODES.
    //
    // The host is found by the WALK — `Ring_Zoom` is two levels up from nothing
    // and the decal is its direct child — and the wedges are addressed as
    // NODES, which is what lets a decal snap to the whole physical wedge.
    const root = new THREE.Object3D();
    const host = new THREE.Object3D();
    host.name = "Ring_Zoom";
    // Each wedge sits at its OWN radius (30, 30.5, 31 …). The sector spread
    // puts the whole-host POOL median a full millimetre away from the wedge the
    // decal actually snaps to, so an adopter taking the pool median cannot pass
    // for one taking its host's.
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(
        wedgeGeometry(30 + i * 0.5, (TAU * i) / 5, TAU / 5, -4, 4),
      );
      seg.name = `Ring_Zoom_Seg${i}`;
      host.add(seg);
    }
    root.add(host);
    root.add(shell("Band_Mid", 20, 5, -2, 2)); // the MESH-named seg shape
    root.add(shell("Shell_Outer", 60, 5)); // widens the radius span so rank < 1
    // A numeral printed proud of the ring and off sector 0's centre
    const decal = new THREE.Mesh(wedgeGeometry(31, 0.1, 0.05, -1, 1, 2));
    decal.name = "DecalT_Zoom_18";
    host.add(decal);
    const brand = new THREE.Mesh(wedgeGeometry(20.3, 0.1, 0.05, -0.5, 0.5, 2));
    brand.name = "DecalT_Brand";
    root.getObjectByName("Band_Mid")!.add(brand);
    // A decal printed on the ring's front RIM — a flat annulus, y constant and
    // all of its extent RADIAL. It is not a special case: it adopts the same
    // lane vector as every other marking, which is what makes the wedge carry it.
    const bezel = new THREE.Mesh(wedgeGeometry(29.9, 0.1, 0.05, 3.9, 4, 2));
    bezel.name = "DecalT_Bezel";
    host.add(bezel);
    deriveFrames(root);

    // THE UNIT: one node, one mesh, one frame at that wedge's own radius.
    const wedge = named(root, "Ring_Zoom_Seg0");
    expect(constFrame(wedge, "R")).toBeCloseTo(30, 3);

    // …and the ADOPTER takes that unit frame EXACTLY — every lane but the two
    // that say what it is. A pool median (which this used to take) left the
    // decal a few hundredths off its host: a different rank bucket, a different
    // gate slot, a visibly different radial throw. Identical lanes are the whole
    // "one object" guarantee, and the op pipeline reads nothing else.
    for (const lane of LANES)
      expect(constFrame(decal, lane), `adopted lane: ${lane}`).toBeCloseTo(
        constFrame(wedge, lane),
        9,
      );
    expect(constFrame(decal, "adopted")).toBe(1);
    expect(constFrame(wedge, "adopted")).toBe(0);

    // the mesh-named seg shape still adopts, unchanged
    const band = named(root, "Band_Mid_Seg0");
    expect(constFrame(brand, "adopted")).toBe(1);
    for (const lane of LANES)
      expect(constFrame(brand, lane), `mesh-named host: ${lane}`).toBeCloseTo(
        constFrame(band, lane),
        9,
      );

    // a RIM-FACE marking adopts on exactly the same terms — no special class,
    // no special coordinates. Sharing the lane vector IS the mechanism.
    expect(constFrame(bezel, "adopted")).toBe(1);
    for (const lane of LANES)
      expect(
        constFrame(bezel, lane),
        `rim-face decal lane: ${lane}`,
      ).toBeCloseTo(constFrame(wedge, lane), 9);
    for (const m of [decal, brand, bezel])
      expect(constFrame(m, "cls")).toBe(PART_CLASS.decal);
  });
});

describe("deriveFrames — axisymmetric guard", () => {
  it("pins a full ring to the deterministic frame t0 = 0, span = 2π", () => {
    // A body of revolution has an ON-AXIS centroid: atan2(≈0, ≈0) is float noise,
    // so the meridian is meaningless and must not be allowed to wobble.
    const ring = new THREE.Mesh(ringGeometry(18, -3, 3));
    ring.name = "Band_Mid";
    const root = new THREE.Object3D();
    root.add(ring);
    root.add(shell("Shell_Outer", 40, 5));
    deriveFrames(root);

    expect(constFrame(ring, "t0")).toBe(0);
    expect(constFrame(ring, "span")).toBeCloseTo(TAU, 6);
    expect(constFrame(ring, "axi")).toBe(1);
    expect(Math.abs(constFrame(ring, "R") - 18) / 18).toBeLessThan(0.02);
    // …and the pinned span is what keeps it off the assemble sheet: 2π is not a
    // sector, so there is no sheet to unroll. (layerN 1 rides along, but nothing
    // reads it — the 0.01mm rank bucket is too tight to decide participation.)
    expect(constFrame(ring, "span")).toBeGreaterThan(2.5);
    expect(constFrame(ring, "layerN")).toBe(1);

    const wedge = named(root, "Shell_Outer_Seg2");
    expect(constFrame(wedge, "axi")).toBe(0);
    expect(constFrame(wedge, "span")).toBeCloseTo(TAU / 5, 3);
    expect(constFrame(wedge, "layerN")).toBe(5);
  });

  it("flags a full-turn mesh whose relief pulls its centroid OFF the axis (the SPAN branch)", () => {
    // The centroid test alone misses this: a ring carrying a heavy lobe (a
    // bracket, a relief boss) has an off-axis centroid, so it measures a real
    // meridian — but it still wraps the whole turn, which makes that meridian
    // just as meaningless. Its measured span falls SHORT of 2π by the mesh's
    // coarsest angular gap, which is why the span tolerance is 0.15 rad and not
    // the 0.01 that never fired.
    const mesh = new THREE.Mesh(
      merge(
        ringGeometry(18, -3, 3, 96),
        wedgeGeometry(20, 0, 0.4, -1, 1, 60), // the off-axis lobe
      ),
    );
    mesh.name = "Shim_Ring";
    const root = new THREE.Object3D();
    root.add(mesh);
    root.add(shell("Shell_Outer", 40, 5));
    deriveFrames(root);

    expect(constFrame(mesh, "axi")).toBe(1);
    expect(constFrame(mesh, "t0")).toBe(0);
    expect(constFrame(mesh, "span")).toBeCloseTo(TAU, 6);
  });
});

describe("deriveFrames — derived ladder", () => {
  function ladderScene(): THREE.Object3D {
    const root = new THREE.Object3D();
    root.add(box("Chassis_Fixed", 0)); // the axial anchor
    root.add(box("Rear_Near", -10));
    root.add(box("Rear_Far", -30));
    root.add(box("Front_Near", 15));
    root.add(box("Front_Far", 40));
    return root;
  }

  it("orders each side outward from the anchor with signed uniform steps", () => {
    const root = ladderScene();
    const { ladderRungs } = deriveFrames(root);

    expect(ladderRungs.get("Rear_Near")).toBeCloseTo(-35, 6); // −70·1/2
    expect(ladderRungs.get("Rear_Far")).toBeCloseTo(-70, 6); // −70·2/2
    expect(ladderRungs.get("Front_Near")).toBeCloseTo(47.5, 6); // +95·1/2
    expect(ladderRungs.get("Front_Far")).toBeCloseTo(95, 6); // +95·2/2
    expect(ladderRungs.get("Chassis_Fixed")).toBeCloseTo(0, 6); // the anchor

    expect(constFrame(named(root, "Rear_Far"), "rung")).toBeCloseTo(-70, 4);
    expect(constFrame(named(root, "Front_Near"), "rung")).toBeCloseTo(47.5, 4);
    expect(constFrame(named(root, "Chassis_Fixed"), "rung")).toBeCloseTo(0, 4);
  });

  it("gives a group's children the group's rung (they travel together)", () => {
    const root = ladderScene();
    const group = root.getObjectByName("Front_Far")!;
    const child = box("Element_09", 41, 3);
    group.add(child);
    deriveFrames(root);
    expect(constFrame(child, "rung")).toBeCloseTo(95, 4);
  });

  it("adopted features ride their host shell's rung", () => {
    const root = ladderScene();
    const bay = shell("Mount_Bayonet", 30, 5, -52, -48);
    root.add(bay);
    const notch = box("Mount_Notch", -50, 2);
    root.add(notch);
    deriveFrames(root);
    const hostRung = constFrame(named(root, "Mount_Bayonet_Seg0"), "rung");
    expect(hostRung).toBeLessThan(0);
    expect(constFrame(notch, "rung")).toBeCloseTo(hostRung, 4);
  });

  it("…even when the host shell is nested below the top level", () => {
    // ladderRungs is keyed by GROUP, so the adoption lookup must use the host's
    // group, not its mesh/part name — otherwise it silently returns 0 the moment
    // a host stops being a top-level node.
    const root = ladderScene();
    const assembly = new THREE.Object3D();
    assembly.name = "Barrel_Assembly";
    assembly.add(shell("Mount_Bayonet", 30, 5, -52, -48));
    root.add(assembly);
    const notch = box("Mount_Notch", -50, 2);
    root.add(notch);
    deriveFrames(root);
    const hostRung = constFrame(named(root, "Mount_Bayonet_Seg0"), "rung");
    expect(hostRung).toBeLessThan(0);
    expect(constFrame(notch, "rung")).toBeCloseTo(hostRung, 4);
  });

  it("tierOrder overrides win over the derived rung", () => {
    const root = ladderScene();
    const { ladderRungs } = deriveFrames(root, {
      tierOrder: { Front_Near: 12, Rear_Far: -5 },
    });
    expect(ladderRungs.get("Front_Near")).toBeCloseTo(12, 6);
    expect(constFrame(named(root, "Front_Near"), "rung")).toBeCloseTo(12, 4);
    expect(constFrame(named(root, "Rear_Far"), "rung")).toBeCloseTo(-5, 4);
    // untouched parts keep the derived ladder
    expect(constFrame(named(root, "Front_Far"), "rung")).toBeCloseTo(95, 4);
  });

  it("overrides.anchorY moves the rear/front split plane", () => {
    // Anchor strategies are A/B'd from the caller; with the plane pushed past
    // every part, the whole model is "rear".
    expect(
      deriveFrames(ladderScene()).ladderRungs.get("Front_Far"),
    ).toBeCloseTo(95, 6);
    const root = ladderScene();
    const { ladderRungs } = deriveFrames(root, { anchorY: 50 });
    // ordered outward from y = 50: Front_Far, Front_Near, Rear_Near, Rear_Far
    expect(ladderRungs.get("Front_Far")).toBeCloseTo(-17.5, 6); // −70·1/4
    expect(ladderRungs.get("Front_Near")).toBeCloseTo(-35, 6);
    expect(ladderRungs.get("Rear_Far")).toBeCloseTo(-70, 6);
    expect(constFrame(named(root, "Front_Far"), "rung")).toBeCloseTo(-17.5, 4);
  });

  it("places the ladder at 0 when there is no anchor part", () => {
    const root = new THREE.Object3D();
    root.add(box("Rear_Far", -30));
    root.add(box("Front_Far", 40));
    const { ladderRungs } = deriveFrames(root);
    expect(ladderRungs.get("Rear_Far")).toBeCloseTo(-70, 6);
    expect(ladderRungs.get("Front_Far")).toBeCloseTo(95, 6);
  });
});

describe("deriveFrames — part classes", () => {
  it("classes each mesh from its name", () => {
    const root = new THREE.Object3D();
    const parts: [string, number][] = [
      ["Element_05", PART_CLASS.glass],
      ["Iris_Blade_01", PART_CLASS.iris],
      ["DecalT_Brand", PART_CLASS.decal],
      ["Acc_Hood", PART_CLASS.accessory],
      ["Cam_Barrel_Seg0", PART_CLASS.structure],
    ];
    for (const [name] of parts) root.add(box(name, 0));
    deriveFrames(root);
    for (const [name, cls] of parts)
      expect(constFrame(named(root, name), "cls")).toBe(cls);
  });

  it("classes a LEAF MESH ROOT from its own name", () => {
    // scene.ts derives frames per accessory root, and a single-primitive
    // accessory (Acc_CapRear) IS that root — the ancestor chain stops at the
    // root and excludes it, so the chain is empty and the class fell through to
    // `structure`: the cap would have flown with the chassis instead of being
    // held off the ladder with the other accessories.
    const cap = box("Acc_CapRear", 0);
    deriveFrames(cap);
    expect(constFrame(cap, "cls")).toBe(PART_CLASS.accessory);
  });

  it("classes a generic sub-mesh from its nearest classed ancestor", () => {
    const root = new THREE.Object3D();
    const cell = new THREE.Object3D();
    cell.name = "Iris_Blade_03";
    const anon = box("Cylinder012", 0);
    cell.add(anon);
    root.add(cell);
    deriveFrames(root);
    expect(constFrame(anon, "cls")).toBe(PART_CLASS.iris);
  });

  it("classes Iris_HOUSING as structure — the iris class is the MECHANISM only", () => {
    // The housing is a segmented shell that blooms and wraps like every other
    // shell; only the aperture-driven mechanism (blades, cam plate, actuator
    // gear) is class iris. A `/^Iris_/` class caught the housing too and parked
    // its wedges out of the assemble sheet while their neighbours flew.
    const root = new THREE.Object3D();
    root.add(shell("Iris_Housing", 16, 7));
    root.add(box("Iris_CamPlate", 0));
    root.add(box("Iris_ActuatorGear", 0));
    deriveFrames(root);

    for (let i = 0; i < 7; i++)
      expect(constFrame(named(root, `Iris_Housing_Seg${i}`), "cls")).toBe(
        PART_CLASS.structure,
      );
    expect(constFrame(named(root, "Iris_CamPlate"), "cls")).toBe(
      PART_CLASS.iris,
    );
    expect(constFrame(named(root, "Iris_ActuatorGear"), "cls")).toBe(
      PART_CLASS.iris,
    );
    // …and the housing's wedges measure a 7-piece layer, so the derived rule
    // ("segmented shell or rides one") puts them IN the wrap.
    expect(constFrame(named(root, "Iris_Housing_Seg0"), "layerN")).toBe(7);
  });
});

describe("deriveFrames — shared geometry", () => {
  it("un-shares an INSTANCED geometry so every mesh keeps its own frame", () => {
    // THE IRIS-BLADE LANDMINE. The seven blades are one Blender mesh instanced
    // across seven nodes (`Iris_Blade_01..07` → `Iris_Blade_geo`), so GLTFLoader
    // hands all seven the SAME BufferGeometry. Frame attributes live on the
    // GEOMETRY, so without a clone the seventh write wins and all seven blades
    // fly on blade 7's seat angle, radius and gate slot.
    //
    const root = new THREE.Object3D();
    const meshes = ["Twin_A", "Twin_B", "Twin_C"].map((name) => {
      const m = new THREE.Mesh(wedgeGeometry(20, 0, 1, -3, 3));
      m.name = name;
      root.add(m);
      return m;
    });
    // the shape the loader actually delivers: ONE geometry, three meshes
    const shared = meshes[0].geometry;
    for (const m of meshes) m.geometry = shared;

    deriveFrames(root);

    // Every mesh owns its geometry, and — the property that actually matters —
    // its own attribute BUFFERS. One shared `_opA` across the three is exactly
    // the clobber: the last write would be the only frame any of them has.
    expect(new Set(meshes.map((m) => m.geometry)).size, "geometries").toBe(3);
    for (const lane of FRAME_ATTRS) {
      const attrs = meshes.map((m) => m.geometry.getAttribute(lane.name));
      for (const [i, a] of attrs.entries())
        expect(a, `${meshes[i].name} ${lane.name}`).toBeTruthy();
      expect(new Set(attrs).size, `${lane.name} buffers`).toBe(3);
    }
    // and the buffers are independent memory, not three views on one array
    const first = meshes[0].geometry.getAttribute("_opA");
    first.setX(0, 12345);
    expect(meshes[1].geometry.getAttribute("_opA").getX(0)).not.toBe(12345);
  });
});
