import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { deriveFrames } from "../frames";
import {
  recipeChannel,
  recipeKnob,
  resetRecipeKnobs,
  tagOpsSpin,
} from "../host";
import { liveRecipes, pieceFields, seatedPointDisplacer } from "../cpu";
import { displaceInto } from "../../dev/ops-cpu";
import { shell } from "./fixture-mesh";

// ops/cpu.ts's point displacer must match the per-vertex sweep, and must read
// channels and knobs live (equal to a fresh snapshot at every value).

/** A five-cut shell whose wedges carry real derived frames. */
function scene() {
  const root = new THREE.Object3D();
  const ring = shell("Ring_Zoom", 30, 5, -6, 6, 4);
  root.add(ring);
  deriveFrames(root);
  return { root, mesh: ring.children[0] as THREE.Mesh };
}

function displaced(mesh: THREE.Mesh, spin = false): Float32Array {
  const out = new Float32Array(
    mesh.geometry.getAttribute("position").count * 3,
  );
  displaceInto(mesh.geometry, out, spin ? mesh : null);
  return out;
}

const vertex = (mesh: THREE.Mesh, i: number) =>
  new THREE.Vector3().fromBufferAttribute(
    mesh.geometry.getAttribute("position") as THREE.BufferAttribute,
    i,
  );

/** The bbox centre: a point that is not a vertex. */
const centreOf = (mesh: THREE.Mesh) => {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
};

/** Displace a point via a fresh snapshot of the live state. */
function freshDisplace(mesh: THREE.Mesh, p: THREE.Vector3): THREE.Vector3 {
  const live = liveRecipes();
  if (live.length === 0) return p.clone();
  const d = pieceFields(mesh.geometry, live)!(0)(p.x, p.y, p.z, [0, 0, 0]);
  return new THREE.Vector3(p.x + d[0], p.y + d[1], p.z + d[2]);
}

function expectSame(a: THREE.Vector3, b: THREE.Vector3, dp = 9) {
  expect(a.x).toBeCloseTo(b.x, dp);
  expect(a.y).toBeCloseTo(b.y, dp);
  expect(a.z).toBeCloseTo(b.z, dp);
}

afterEach(() => {
  for (const name of ["explode", "assemble", "peel", "rose"] as const)
    recipeChannel(name).value = 0;
  resetRecipeKnobs();
});

describe("seatedPointDisplacer", () => {
  it("is an exact identity while every channel is seated", () => {
    const { mesh } = scene();
    const p = vertex(mesh, 3);
    const out = seatedPointDisplacer(mesh).displace(p.clone());
    expect(out.x).toBe(p.x);
    expect(out.y).toBe(p.y);
    expect(out.z).toBe(p.z);
  });

  it("moves a point exactly as the per-vertex sweep moves that vertex", () => {
    const { mesh } = scene();
    recipeChannel("explode").value = 1;
    const displacer = seatedPointDisplacer(mesh);
    const moved = displaced(mesh);
    for (const i of [0, 3, 7]) {
      const seated = vertex(mesh, i);
      const point = displacer.displace(seated.clone());
      // Not exact: the sweep writes to a Float32Array.
      for (const c of [0, 1, 2])
        expect(point.getComponent(c)).toBeCloseTo(moved[i * 3 + c], 4);
      // It really moved.
      expect(point.distanceTo(seated)).toBeGreaterThan(1);
    }
    // A non-vertex point moves too.
    const centre = centreOf(mesh);
    const movedCentre = displacer.displace(centre.clone());
    expect(movedCentre.distanceTo(centre)).toBeGreaterThan(1);
    expect(Number.isFinite(movedCentre.length())).toBe(true);
  });

  it("counter-rotates a spin-tagged mesh's delta, cancelling its pivot", () => {
    // After the pivot's rotation, the world displacement equals the untagged one.
    const { mesh } = scene();
    const spinBox = tagOpsSpin(mesh);
    const theta = 0.7;
    recipeChannel("explode").value = 1;
    try {
      const plain = displaced(mesh);
      spinBox.value = theta;
      const spun = displaced(mesh, true);
      const pos = mesh.geometry.getAttribute("position");
      // R_y(theta)·v in the convention Object3D.rotation.y turns by
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      for (let i = 0; i < pos.count; i++) {
        const dx = spun[i * 3] - pos.getX(i);
        const dy = spun[i * 3 + 1] - pos.getY(i);
        const dz = spun[i * 3 + 2] - pos.getZ(i);
        const world = [c * dx + s * dz, dy, -s * dx + c * dz];
        for (const k of [0, 1, 2])
          expect(world[k]).toBeCloseTo(
            plain[i * 3 + k] - pos.getComponent(i, k),
            4, // both sides round-trip through a Float32Array
          );
      }
      // the tag changed the delta
      expect(Math.abs(spun[0] - plain[0])).toBeGreaterThan(0.01);
      // The displacer applies the same un-spin as the sweep.
      const p = vertex(mesh, 3);
      const point = seatedPointDisplacer(mesh).displace(p.clone());
      for (const k of [0, 1, 2])
        expect(point.getComponent(k)).toBeCloseTo(spun[3 * 3 + k], 4);
    } finally {
      spinBox.value = 0;
    }
  });

  it("reads channels and knobs live: equals a fresh snapshot as they move", () => {
    const { mesh } = scene();
    const centre = centreOf(mesh);
    const probes = [centre, vertex(mesh, 0), vertex(mesh, 7)];
    const displacer = seatedPointDisplacer(mesh);
    const expectFresh = () => {
      for (const p of probes)
        expectSame(displacer.displace(p.clone()), freshDisplace(mesh, p));
      return displacer.displace(centre.clone());
    };
    const explode = recipeChannel("explode");
    const assemble = recipeChannel("assemble");
    const moved = (before: THREE.Vector3, min: number) =>
      expect(expectFresh().distanceTo(before)).toBeGreaterThan(min);

    // One channel moving.
    explode.value = 0.4;
    const at04 = expectFresh();
    for (const c of [0.3, 0.55, 0.8, 1]) {
      explode.value = c;
      expectFresh();
    }
    moved(at04, 1);
    // A second recipe joining, both moving, then leaving again.
    const one = expectFresh();
    assemble.value = 0.5;
    moved(one, 0.01);
    for (const c of [0.4, 0.7, 0.95]) {
      assemble.value = c;
      explode.value = 1 - c;
      expectFresh();
    }
    assemble.value = 0;
    explode.value = 1;
    expectSame(expectFresh(), one);
    // A knob moving, with no sync.
    const knob = recipeKnob("explode", "bloom");
    knob.value = knob.value * 2 + 0.5;
    moved(one, 0.01);
  });

  it("writes the caller's point in place and hands the same object back", () => {
    const { mesh } = scene();
    recipeChannel("explode").value = 0.7;
    const displacer = seatedPointDisplacer(mesh);
    const p = centreOf(mesh);
    expect(displacer.displace(p)).toBe(p);
    // also when seated
    recipeChannel("explode").value = 0;
    const q = vertex(mesh, 2);
    expect(displacer.displace(q)).toBe(q);
  });
});
