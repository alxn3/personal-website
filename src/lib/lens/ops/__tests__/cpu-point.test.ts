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

// ops/cpu.ts evaluates the deform at an arbitrary point of a piece; it must be
// the SAME field as the per-vertex sweep, or the refraction rays describe a
// column the render does not draw. The frame-loop reader reads the host's
// channels and knobs LIVE, so it must equal a fresh snapshot at every value
// with no sync step in between.

const TAU = Math.PI * 2;

/** A cylinder-sector wedge, `steps` quads across the sector. */
function wedge(radius: number, t0: number, span: number, steps: number) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = t0 - span / 2 + (span * i) / steps;
    pos.push(radius * Math.cos(a), -6, radius * Math.sin(a));
    pos.push(radius * Math.cos(a), 6, radius * Math.sin(a));
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

/** A five-cut shell whose wedges carry real derived frames. */
function scene() {
  const root = new THREE.Object3D();
  const shell = new THREE.Object3D();
  shell.name = "Ring_Zoom";
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(wedge(30, (TAU * i) / 5, TAU / 5, 4));
    m.name = `Ring_Zoom_Seg${i}`;
    shell.add(m);
  }
  root.add(shell);
  deriveFrames(root);
  return { root, mesh: shell.children[0] as THREE.Mesh };
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

/** The bbox centre the refraction rays thread: not a vertex. */
const centreOf = (mesh: THREE.Mesh) => {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
};

/** The point as a fresh SNAPSHOT of the host's live state moves it (the path
 *  every other caller takes). */
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
      // 1e-4 mm, not exact: the sweep lands in a Float32Array (a proxy's
      // vertex buffer) while a point stays in double precision.
      for (const c of [0, 1, 2])
        expect(point.getComponent(c)).toBeCloseTo(moved[i * 3 + c], 4);
      // …and it really moved, so the agreement is not a seated tie.
      expect(point.distanceTo(seated)).toBeGreaterThan(1);
    }
    // A point that is NOT a vertex (the bbox centre the rays thread) rides
    // the same field.
    const centre = centreOf(mesh);
    const movedCentre = displacer.displace(centre.clone());
    expect(movedCentre.distanceTo(centre)).toBeGreaterThan(1);
    expect(Number.isFinite(movedCentre.length())).toBe(true);
  });

  it("counter-rotates a spin-tagged mesh's delta, cancelling its pivot", () => {
    // The delta is added INSIDE the pivot's rotation, so un-spinning it leaves
    // the world displacement equal to the untagged one — the piece spins about
    // its own displaced axis instead of orbiting its seat.
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
      // the tag really did something (the two deltas are not identical)
      expect(Math.abs(spun[0] - plain[0])).toBeGreaterThan(0.01);
      // …and the displacer applies the same un-spin as the sweep.
      const p = vertex(mesh, 3);
      const point = seatedPointDisplacer(mesh).displace(p.clone());
      for (const k of [0, 1, 2])
        expect(point.getComponent(k)).toBeCloseTo(spun[3 * 3 + k], 4);
    } finally {
      spinBox.value = 0;
    }
  });

  it("reads the channels live: equals a fresh snapshot at every value", () => {
    const { mesh } = scene();
    const centre = centreOf(mesh);
    const probes = [centre, vertex(mesh, 0), vertex(mesh, 7)];
    const displacer = seatedPointDisplacer(mesh);
    for (const c of [0.3, 0.55, 0.8, 1]) {
      recipeChannel("explode").value = c;
      for (const p of probes)
        expectSame(displacer.displace(p.clone()), freshDisplace(mesh, p));
    }
    // …with two recipes live, summed as the shader sums them.
    for (const c of [0.4, 0.7, 0.95]) {
      recipeChannel("assemble").value = c;
      recipeChannel("explode").value = 1 - c;
      for (const p of probes)
        expectSame(displacer.displace(p.clone()), freshDisplace(mesh, p));
    }
    // a moved channel moved the point
    recipeChannel("assemble").value = 0;
    recipeChannel("explode").value = 0.4;
    const at04 = displacer.displace(centre.clone());
    recipeChannel("explode").value = 0.8;
    expect(displacer.displace(centre.clone()).distanceTo(at04)).toBeGreaterThan(1); // prettier-ignore
  });

  it("follows the live set: a recipe joining or leaving changes the result", () => {
    const { mesh } = scene();
    const centre = centreOf(mesh);
    recipeChannel("explode").value = 1;
    const displacer = seatedPointDisplacer(mesh);
    const one = displacer.displace(centre.clone());
    recipeChannel("assemble").value = 0.5;
    const both = displacer.displace(centre.clone());
    expectSame(both, freshDisplace(mesh, centre));
    expect(both.distanceTo(one)).toBeGreaterThan(0.01);
    // …and leaving (below the idle gate) restores the single-recipe field.
    recipeChannel("assemble").value = 0;
    expectSame(displacer.displace(centre.clone()), one);
  });

  it("reads a knob live: a moved knob changes the result with no sync", () => {
    const { mesh } = scene();
    const centre = centreOf(mesh);
    recipeChannel("explode").value = 1;
    const displacer = seatedPointDisplacer(mesh);
    const before = displacer.displace(centre.clone());
    const knob = recipeKnob("explode", "bloom");
    knob.value = knob.value * 2 + 0.5;
    const after = displacer.displace(centre.clone());
    expect(after.distanceTo(before)).toBeGreaterThan(0.01);
    expectSame(after, freshDisplace(mesh, centre));
  });

  it("writes the caller's point in place and hands the same object back", () => {
    const { mesh } = scene();
    recipeChannel("explode").value = 0.7;
    const displacer = seatedPointDisplacer(mesh);
    const p = centreOf(mesh);
    expect(displacer.displace(p)).toBe(p);
    // the seated identity hands the same object back untouched too
    recipeChannel("explode").value = 0;
    const q = vertex(mesh, 2);
    expect(displacer.displace(q)).toBe(q);
  });
});
