import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { deriveFrames } from "../frames";
import { recipeChannel, tagOpsSpin } from "../host";
import { displaceSeatedPoint } from "../cpu";
import { displaceInto } from "../../dev/ops-cpu";

// ops/cpu.ts evaluates the deform AT AN ARBITRARY POINT of a piece — the value
// story/cinematics.ts threads its refraction rays through, and the value the
// inspector's per-vertex sweep is built out of. The two must be the SAME field:
// a point that happens to sit on a vertex has to land exactly where that vertex
// lands, or the rays describe a column the render does not draw.

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

describe("displaceSeatedPoint", () => {
  it("is an exact identity while every channel is seated", () => {
    const { mesh } = scene();
    const p = vertex(mesh, 3);
    const out = displaceSeatedPoint(mesh, p.clone());
    expect(out.x).toBe(p.x);
    expect(out.y).toBe(p.y);
    expect(out.z).toBe(p.z);
  });

  it("moves a point exactly as the per-vertex sweep moves that vertex", () => {
    const { mesh } = scene();
    recipeChannel("explode").value = 1;
    try {
      const moved = displaced(mesh);
      for (const i of [0, 3, 7]) {
        const seated = vertex(mesh, i);
        const point = displaceSeatedPoint(mesh, seated.clone());
        // 1e-4 mm, not exact: the sweep lands in a Float32Array (a proxy's
        // vertex buffer) while a point stays in double precision.
        for (const c of [0, 1, 2])
          expect(point.getComponent(c)).toBeCloseTo(moved[i * 3 + c], 4);
        // …and it really moved, so the agreement is not a seated tie.
        expect(point.distanceTo(seated)).toBeGreaterThan(1);
      }
      // A point that is NOT a vertex (the bbox centre the rays thread) rides
      // the same field.
      mesh.geometry.computeBoundingBox();
      const centre = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
      const movedCentre = displaceSeatedPoint(mesh, centre.clone());
      expect(movedCentre.distanceTo(centre)).toBeGreaterThan(1);
      expect(Number.isFinite(movedCentre.length())).toBe(true);
    } finally {
      recipeChannel("explode").value = 0;
    }
  });

  it("counter-rotates a spin-tagged mesh's delta, cancelling its pivot", () => {
    // The law (ops/host.ts's spin-pivot note): the delta is added INSIDE the
    // pivot's rotation, so un-spinning it leaves the WORLD displacement equal to
    // the untagged one — the piece spins about its own displaced axis instead of
    // orbiting its seat. Stated here as that invariant, not as a copy of the
    // rotation formula, so a sign error cannot pass by symmetry.
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
    } finally {
      spinBox.value = 0;
      recipeChannel("explode").value = 0;
    }
  });
});
