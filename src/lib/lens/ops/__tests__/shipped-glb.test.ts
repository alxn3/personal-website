import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import fs from "node:fs";
import { deriveFrames } from "../frames";
import { createMechanism, MECHANISM } from "../mechanism";
import { recipeChannel, RECIPE_NAMES } from "../host";
import { displaceInto } from "../../dev/ops-cpu";

// The SHIPPED GLB's structural contract, plus the two laws the ops/mechanism
// layer leans on when it consumes one. The model pipeline has moved the iris
// blades' seat between the vertices and the node twice in one drop cycle, so
// the shape the code is written against is pinned here — a change fails in this
// file rather than in a screenshot the owner has to catch.

const TAU = Math.PI * 2;
const MODEL = "public/models/lens_web_segmented.glb";
const Y = new THREE.Vector3(0, 1, 0);

interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    rotation?: number[];
    translation?: number[];
    children?: number[];
  }[];
  meshes: { name?: string; primitives: unknown[] }[];
  materials?: unknown[];
  scenes: { nodes: number[] }[];
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

  it("carries the measured N.12 counts", () => {
    expect(g.nodes.length, "nodes").toBe(224);
    expect(g.meshes.length, "meshes").toBe(194);
    expect(names.filter((n) => /^Element_/.test(n)).length, "glass").toBe(13);
    expect(names.filter((n) => /_Seg\d+$/.test(n)).length, "wedges").toBe(143);
    expect(g.scenes[0].nodes.length, "top-level groups").toBe(31);
    const wedgeGroups = new Set(
      names
        .filter((n) => /_Seg\d+$/.test(n))
        .map((n) => n.replace(/_Seg\d+$/, "")),
    );
    expect(wedgeGroups.size, "wedge groups").toBe(26);
  });

  it("seats every node at identity — no rotation anywhere (§9)", () => {
    // Not load-bearing: the aperture drive composes onto whatever seat a node
    // carries. It IS the contract N.12 chose, though, and a rotation
    // reappearing is worth learning about deliberately rather than visually.
    expect(g.nodes.filter((n) => !isIdentity(n.rotation)).map((n) => n.name)) //
      .toEqual([]);
  });

  it("ships SEVEN distinct blade meshes, fan baked into the vertices", () => {
    // N.12 replaced the single `Iris_Blade_geo` shared by seven nodes (W.4)
    // with seven baked meshes — owner's ruling, +73 KB accepted for simplicity.
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
    // §10's "§6-style re-parent" arrives IN THE FILE: the exporter already
    // nests both under the focus shell, so they ride the focus slide through
    // the hierarchy and share its explode rung. No site-side re-parent list
    // exists, and none is needed.
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
  // Every shipped seat is identity today, so this is the plain absolute
  // behaviour. It is pinned anyway, because the pipeline HAS put the fan on the
  // nodes once: an absolute write then erased it and stacked all seven blades
  // on blade 1's meridian, and the additive `rotation.y` that fixed that swept
  // four of the seven backwards.

  it("keeps seven seats distinct and correctly swept, at every aperture", () => {
    const { root, blades } = build("node-seat", FAN);
    const mech = createMechanism(root);
    for (const aperture of [0, 0.37, 1]) {
      mech.update({ zoom: 0, focus: 0, aperture });
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
    mech.update({ zoom: 0, focus: 0, aperture: 0 });
    const rest = blades.map(seatOf);
    mech.update({ zoom: 0, focus: 0, aperture: 1 });
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
    mech.update({ zoom: 0, focus: 0, aperture: 1 });
    const closeRad = (MECHANISM.irisCloseDeg * Math.PI) / 180;
    for (const b of blades) expect(seatOf(b)).toBeCloseTo(wrap(closeRad), 6);
  });
});

describe("a seat may live in the vertices or on the node", () => {
  // Frames are measured in the mesh's LOCAL space on purpose — that is the
  // space the shader's `position` lives in — so a node-seated blade measures a
  // different t0 from a baked one. That is only safe because every op consumes
  // `theta - t0`, `r` and `y`, all invariant under rotation about the optical
  // axis, while the one root-space quantity (the ladder rung) already composes
  // `node.matrixWorld`.
  //
  // This test IS that argument, executed. It builds its OWN fixtures, so it
  // keeps guarding the law now that the shipped file seats everything at
  // identity: an op that ever reads an ABSOLUTE meridian fails here.

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
