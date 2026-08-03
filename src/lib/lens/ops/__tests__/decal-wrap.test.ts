import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { deriveFrames, WRAP_ATTRS } from "../frames";
import { recipeChannel } from "../host";
import { displaceInto } from "../../dev/ops-cpu";

// THE SHRINK-WRAP BINDING (ops/frames.ts bindDecals + its host.ts variant): a
// decal rides its host's RENDERED FACET rather than the smooth op field, so the
// chord error across a coarse facet cancels on both instead of swallowing the
// text.
//
// Driven through `displaceInto` — dev/ops-cpu.ts sweeps the NUM mirror
// (ops/cpu.ts) of the very graph host.ts builds over every vertex, so this
// exercises the shipped path rather than a restatement of it. The host below is deliberately COARSE (few, wide facets):
// on a fine host the field and the facet agree and the law is untestable.

const TAU = Math.PI * 2;

/** A coarse cylinder-sector wedge: `steps` quads across the sector, so each
 *  facet spans a wide chord of the true arc. */
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

/** A scene whose decal sits on a 3-facet host — coarse enough that the facet
 *  chord and the true arc differ by ~0.5mm at the same angle. */
function scene() {
  const root = new THREE.Object3D();
  const host = new THREE.Object3D();
  host.name = "Ring_Zoom";
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(wedge(30, (TAU * i) / 5, TAU / 5, 3));
    m.name = `Ring_Zoom_Seg${i}`;
    host.add(m);
  }
  root.add(host);
  root.add(
    (() => {
      const m = new THREE.Mesh(wedge(60, 0, TAU / 5, 3));
      m.name = "Shell_Outer";
      return m;
    })(),
  );
  // A dense little decal patch floating 0.1mm proud of sector 0's face.
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= 6; i++) {
    const a = -0.25 + (0.5 * i) / 6;
    for (const y of [-1, 1]) {
      pos.push(30.1 * Math.cos(a), y, 30.1 * Math.sin(a));
    }
  }
  for (let i = 0; i < 6; i++) {
    const b = i * 2;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(pos), 3),
  );
  g.setIndex(idx);
  const decal = new THREE.Mesh(g);
  decal.name = "DecalT_Zoom_18";
  host.add(decal);
  return { root, decal, wedgeMesh: host.children[0] as THREE.Mesh };
}

function displaced(mesh: THREE.Mesh): Float32Array {
  const out = new Float32Array(
    mesh.geometry.getAttribute("position").count * 3,
  );
  displaceInto(mesh.geometry, out);
  return out;
}

describe("decal shrink-wrap binding", () => {
  it("recomposes at rest, then rides the host's FACET through the deform", () => {
    const { root, decal, wedgeMesh } = scene();
    deriveFrames(root);
    const pos = decal.geometry.getAttribute("position");

    // (a) every decal vertex carries a binding, and it REPRODUCES the authored
    // position: u·p0 + v·p1 + w·p2 + h·n̂ decomposes the vertex in a complete
    // basis, so the seated render is unmoved (to recomposition float error).
    const wa = decal.geometry.getAttribute(WRAP_ATTRS[0].name);
    const wb = decal.geometry.getAttribute(WRAP_ATTRS[1].name);
    const wc = decal.geometry.getAttribute(WRAP_ATTRS[2].name);
    expect(wa, "no binding written").toBeTruthy();
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p0.set(wa.getX(i), wa.getY(i), wa.getZ(i));
      p1.set(wb.getX(i), wb.getY(i), wb.getZ(i));
      p2.set(wc.getX(i), wc.getY(i), wc.getZ(i));
      const u = wa.getW(i);
      const v = wb.getW(i);
      const h = wc.getW(i);
      const n = new THREE.Vector3()
        .subVectors(p1, p0)
        .cross(new THREE.Vector3().subVectors(p2, p0))
        .normalize();
      const back = p0
        .clone()
        .multiplyScalar(u)
        .addScaledVector(p1, v)
        .addScaledVector(p2, 1 - u - v)
        .addScaledVector(n, h);
      const want = new THREE.Vector3().fromBufferAttribute(pos, i);
      expect(back.distanceTo(want), `vertex ${i} recomposition`).toBeLessThan(
        1e-4,
      );
    }

    // …and with every channel seated the mirror leaves the decal exactly where
    // it was authored.
    const rest = displaced(decal);
    for (let i = 0; i < pos.count; i++)
      for (const c of [0, 1, 2])
        expect(rest[i * 3 + c]).toBeCloseTo(pos.getComponent(i, c), 6);

    // (b) CO-MOVEMENT. Deform, then check the decal against its host's own
    // deformed FACET — the corners' displaced positions, read from the same
    // mirror. The decal must land on the plane through them, not on the smooth
    // field, which on this coarse host is a different surface entirely.
    // Deep enough that this piece's gate has actually released it (its layer
    // phase holds it seated until ~0.9) and the wrap's BEND is live, so the
    // facet and the smooth field are genuinely different surfaces.
    recipeChannel("assemble").value = 0.9;
    try {
      const moved = displaced(decal);
      const hostMoved = displaced(wedgeMesh);
      const hp = wedgeMesh.geometry.getAttribute("position");
      const at = (buf: Float32Array, i: number) =>
        new THREE.Vector3(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);

      let checked = 0;
      let maxOff = 0;
      for (let i = 0; i < pos.count; i++) {
        // the host corners this vertex is bound to, found by position
        const corner = (
          w: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        ) => {
          const q = new THREE.Vector3(w.getX(i), w.getY(i), w.getZ(i));
          for (let k = 0; k < hp.count; k++)
            if (
              q.distanceTo(new THREE.Vector3().fromBufferAttribute(hp, k)) <
              1e-5
            )
              return at(hostMoved, k);
          return null;
        };
        const P0 = corner(wa);
        const P1 = corner(wb);
        const P2 = corner(wc);
        if (!P0 || !P1 || !P2) continue;
        const n = new THREE.Vector3()
          .subVectors(P1, P0)
          .cross(new THREE.Vector3().subVectors(P2, P0))
          .normalize();
        const want = P0.clone()
          .multiplyScalar(wa.getW(i))
          .addScaledVector(P1, wb.getW(i))
          .addScaledVector(P2, 1 - wa.getW(i) - wb.getW(i))
          .addScaledVector(n, wc.getW(i));
        const off = at(moved, i).distanceTo(want);
        maxOff = Math.max(maxOff, off);
        checked++;
      }
      expect(checked, "no vertex resolved to host corners").toBeGreaterThan(4);
      expect(maxOff, "decal left its host's facet").toBeLessThan(1e-4);

      // …and it really moved, so the agreement above is not a seated tie.
      expect(at(moved, 0).distanceTo(at(rest, 0))).toBeGreaterThan(1);
    } finally {
      recipeChannel("assemble").value = 0;
    }
  });

  it("leaves an unbound (structure) mesh alone", () => {
    const { root, wedgeMesh } = scene();
    deriveFrames(root);
    // (c) the variant is keyed on the binding, and structure never gets one.
    for (const { name } of WRAP_ATTRS)
      expect(wedgeMesh.geometry.getAttribute(name)).toBeUndefined();
  });
});
