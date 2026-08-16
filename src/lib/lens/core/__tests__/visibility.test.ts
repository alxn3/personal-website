import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { sweepVisibility, type VisibilityGates } from "../visibility";
import { isAccessory } from "../parts";

// THE DIRTY-FLAG LAW (perf batch): core/scene.ts no longer sweeps at every
// gate mutation site — writers mark `visibilityDirty` and tick() composes ONCE
// before the render. That deferral is only sound if the sweep is a pure
// function of the CURRENT gate state: no history, no state of its own, each
// gate an independent veto. These tests pin exactly that, on a miniature of
// the real tree shapes (top-level meshes, a hull child riding its host, an
// accessory subtree).

/** the real tree's shapes, in miniature */
function fixture() {
  const root = new THREE.Group();
  const glass = new THREE.Mesh(); // optical glass (isOpticalGlass matches)
  glass.name = "Element_04";
  const body = new THREE.Mesh(); // plain body piece
  body.name = "Barrel_Inner";
  const shell = new THREE.Mesh(); // shell-gate member (membership, not name)
  shell.name = "Shell_Seg1";
  const interior = new THREE.Mesh(); // interior-gate member
  interior.name = "Tube_Zoom";
  const hull = new THREE.Mesh(); // shading's inverted-hull pass: mesh UNDER mesh
  hull.name = "Barrel_Inner_hull";
  body.add(hull);
  const accRoot = new THREE.Group(); // accessory subtree — generic child name
  accRoot.name = "Acc_Hood";
  const accMesh = new THREE.Mesh();
  accMesh.name = "mesh_0";
  accRoot.add(accMesh);
  root.add(glass, body, shell, interior, accRoot);
  return { root, glass, body, shell, interior, hull, accMesh };
}

interface GateState {
  glassGone: Set<THREE.Mesh>;
  bodyFadedOut: boolean;
  shellGone: Set<THREE.Mesh>;
  interiorGone: Set<THREE.Mesh>;
}

const freshState = (): GateState => ({
  glassGone: new Set(),
  bodyFadedOut: false,
  shellGone: new Set(),
  interiorGone: new Set(),
});

/** the gates view core/scene.ts hands the sweep, over a plain state record */
const gatesOf = (s: GateState): VisibilityGates => ({
  underAccessory: (o) => {
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isAccessory(a.name)) return true;
    return false;
  },
  glassGone: s.glassGone,
  get bodyFadedOut() {
    return s.bodyFadedOut;
  },
  shellGone: s.shellGone,
  interiorGone: s.interiorGone,
});

describe("visibility sweep", () => {
  // Every gate is an independent veto and the composition is their AND — swept
  // over the full lattice of gate states, against a first-principles oracle.
  it("composes the gates as one AND, over every gate combination", () => {
    const f = fixture();
    const meshes = [f.glass, f.body, f.shell, f.interior];
    for (let bits = 0; bits < 1 << 4; bits++) {
      const s = freshState();
      s.bodyFadedOut = Boolean(bits & 1);
      if (bits & 2) s.shellGone.add(f.shell);
      if (bits & 4) s.interiorGone.add(f.interior);
      if (bits & 8) s.glassGone.add(f.glass);
      sweepVisibility(f.root, gatesOf(s));
      const oracle = (m: THREE.Mesh) => {
        const glass = m === f.glass;
        return (
          !s.glassGone.has(m) &&
          !(s.bodyFadedOut && !glass) &&
          !s.shellGone.has(m) &&
          !s.interiorGone.has(m)
        );
      };
      for (const m of meshes)
        expect(m.visible, `bits=${bits} mesh=${m.name}`).toBe(oracle(m));
    }
  });

  // THE deferral equivalence: a run that mutates gates N times and sweeps once
  // at the end lands on identical flags to a run that sweeps after every
  // mutation — for a deterministic pseudo-random walk of mutation sequences.
  // This is what makes coalescing passes behind a dirty flag a no-op.
  it("one deferred sweep ≡ a sweep after every mutation (state, not history)", () => {
    const eager = fixture();
    const lazy = fixture();
    const sE = freshState();
    const sL = freshState();
    let seed = 0x9e3779b9;
    const rnd = () => {
      // xorshift32 — deterministic, seedable, no Math.random flake
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const mutate = (f: ReturnType<typeof fixture>, s: GateState) => {
      const pick = Math.floor(rnd() * 4);
      const flip = <T>(set: Set<T>, v: T) =>
        set.has(v) ? set.delete(v) : set.add(v);
      if (pick === 0) s.bodyFadedOut = !s.bodyFadedOut;
      else if (pick === 1) flip(s.shellGone, f.shell);
      else if (pick === 2) flip(s.interiorGone, f.interior);
      else flip(s.glassGone, f.glass);
    };
    const flags = (f: ReturnType<typeof fixture>) =>
      [f.glass, f.body, f.shell, f.interior, f.hull, f.accMesh].map(
        (m) => m.visible,
      );
    for (let run = 0; run < 50; run++) {
      const steps = 1 + Math.floor(rnd() * 8);
      const savedSeed = seed;
      for (let k = 0; k < steps; k++) {
        mutate(eager, sE);
        sweepVisibility(eager.root, gatesOf(sE)); // sweep at every mutation…
      }
      seed = savedSeed; // replay the same walk on the lazy tree
      for (let k = 0; k < steps; k++) mutate(lazy, sL);
      sweepVisibility(lazy.root, gatesOf(sL)); // …vs ONE deferred sweep
      expect(flags(lazy), `run ${run}`).toEqual(flags(eager));
    }
  });

  // Accessories keep their own owner — the page's accessory choice writes those
  // flags, and the sweep must never touch them, whatever the other gates say.
  it("never writes accessory flags", () => {
    const f = fixture();
    const s = freshState();
    f.accMesh.visible = false; // a state some other owner chose
    sweepVisibility(f.root, gatesOf(s));
    expect(f.accMesh.visible).toBe(false); // untouched
    s.bodyFadedOut = true;
    sweepVisibility(f.root, gatesOf(s));
    expect(f.accMesh.visible).toBe(false); // still the owner's
  });

  // The inverted-hull child rides its host's flag — the sweep never writes it.
  it("never writes a mesh parented under a mesh", () => {
    const f = fixture();
    const s = freshState();
    f.hull.visible = false;
    s.bodyFadedOut = true; // would hide the host — the child flag still stays
    sweepVisibility(f.root, gatesOf(s));
    expect(f.body.visible).toBe(false);
    expect(f.hull.visible).toBe(false);
    s.bodyFadedOut = false;
    f.hull.visible = true;
    sweepVisibility(f.root, gatesOf(s));
    expect(f.hull.visible).toBe(true);
  });
});
