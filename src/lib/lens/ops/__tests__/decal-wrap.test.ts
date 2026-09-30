import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { deriveFrames, WRAP_ATTRS } from "../frames";
import { recipeChannel } from "../host";
import { displaceInto } from "../../dev/ops-cpu";
import { TAU, mesh, shell, wedgeGeometry } from "./fixture-mesh";

// A decal follows its host's flat facets, not the smooth deform field
// (ops/frames.ts bindDecals). The host is deliberately coarse so the two differ.

/** A segmented host with 3 facets per wedge and a decal 0.1 mm above wedge 0. */
function scene() {
  const root = new THREE.Object3D();
  const host = shell("Ring_Zoom", 30, 5, -6, 6, 3);
  root.add(host, mesh("Shell_Outer", wedgeGeometry(60, 0, TAU / 5, -6, 6, 3)));
  const decal = mesh("DecalT_Zoom_18", wedgeGeometry(30.1, 0, 0.5, -1, 1, 6));
  host.add(decal);
  deriveFrames(root);
  return { decal, wedge: host.children[0] as THREE.Mesh };
}

function displaced(m: THREE.Mesh): THREE.Vector3[] {
  const n = m.geometry.getAttribute("position").count;
  const out = new Float32Array(n * 3);
  displaceInto(m.geometry, out);
  return Array.from({ length: n }, (_, i) => new THREE.Vector3().fromArray(out, i * 3)); // prettier-ignore
}

/** u·P0 + v·P1 + (1 − u − v)·P2 + h·n̂ over the facet (P0, P1, P2). */
function rebuild(P: THREE.Vector3[], [u, v, h]: number[]) {
  const n = new THREE.Vector3()
    .subVectors(P[1], P[0])
    .cross(new THREE.Vector3().subVectors(P[2], P[0]))
    .normalize();
  return P[0]
    .clone()
    .multiplyScalar(u)
    .addScaledVector(P[1], v)
    .addScaledVector(P[2], 1 - u - v)
    .addScaledVector(n, h);
}

describe("decal shrink-wrap binding", () => {
  it("recomposes at rest, then follows the host's facet through the deform", () => {
    const { decal, wedge } = scene();
    const pos = decal.geometry.getAttribute("position");
    const w = WRAP_ATTRS.map(({ name }) => decal.geometry.getAttribute(name));
    expect(w[0], "no binding written").toBeTruthy();
    const corners = (i: number) =>
      w.map((a) => new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)));
    const uvh = (i: number) => w.map((a) => a.getW(i));

    // (a) Each vertex's binding rebuilds its authored position, and with every
    // channel at 0 the decal stays put.
    const rest = displaced(decal);
    for (let i = 0; i < pos.count; i++) {
      const want = new THREE.Vector3().fromBufferAttribute(pos, i);
      expect(rebuild(corners(i), uvh(i)).distanceTo(want), `vertex ${i} recomposition`).toBeLessThan(1e-4); // prettier-ignore
      expect(rest[i].distanceTo(want)).toBeLessThan(5e-7);
    }

    // (b) Deformed, the decal lands on the plane of its host's deformed facet
    // corners. At 0.9 the wrap's bend is active for this piece.
    recipeChannel("assemble").value = 0.9;
    try {
      const moved = displaced(decal);
      const hostMoved = displaced(wedge);
      const hp = wedge.geometry.getAttribute("position");
      const seated = Array.from({ length: hp.count }, (_, k) => new THREE.Vector3().fromBufferAttribute(hp, k)); // prettier-ignore
      // the host corners a vertex is bound to, found by position
      const hostCorner = (q: THREE.Vector3) =>
        hostMoved[seated.findIndex((s) => s.distanceTo(q) < 1e-5)];
      let checked = 0;
      for (let i = 0; i < pos.count; i++) {
        const P = corners(i).map(hostCorner);
        if (P.some((c) => !c)) continue;
        expect(moved[i].distanceTo(rebuild(P, uvh(i))), `decal vertex ${i} left its host's facet`).toBeLessThan(1e-4); // prettier-ignore
        checked++;
      }
      expect(checked, "no vertex resolved to host corners").toBeGreaterThan(4);
      // It really moved.
      expect(moved[0].distanceTo(rest[0])).toBeGreaterThan(1);
    } finally {
      recipeChannel("assemble").value = 0;
    }
  });

  it("(c) leaves an unbound (structure) mesh alone", () => {
    const { wedge } = scene();
    for (const { name } of WRAP_ATTRS)
      expect(wedge.geometry.getAttribute(name)).toBeUndefined();
  });
});
