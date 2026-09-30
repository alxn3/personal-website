import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  DECAL_BAND,
  EXTRA_BAND,
  REST_BAND,
  SHELL_FEATHER,
  WINK_WIDTH,
  makeWinkScatter,
  packWink,
  stampWinkLanes,
  sweepVisibility,
  unpackWink,
  winkGone,
  winkOpacity,
} from "../visibility";
import { isPeelExtra, isPeelTube } from "../parts";
import { WINK_NONE } from "../../ops/frames";

// scene.ts only re-runs the sweep when something changed, which is correct only
// if the sweep depends on the current gate state alone. Checked on a small tree.

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

const freshState = () => ({
  glassGone: new Set<THREE.Mesh>(),
  bodyFadedOut: false,
  shellGone: new Set<THREE.Mesh>(),
  interiorGone: new Set<THREE.Mesh>(),
});

describe("visibility sweep", () => {
  // visible = no gate hides it, over every combination of gate states
  it("composes the gates as one AND, over every gate combination", () => {
    const f = fixture();
    const meshes = [f.glass, f.body, f.shell, f.interior];
    for (let bits = 0; bits < 1 << 4; bits++) {
      const s = freshState();
      s.bodyFadedOut = Boolean(bits & 1);
      if (bits & 2) s.shellGone.add(f.shell);
      if (bits & 4) s.interiorGone.add(f.interior);
      if (bits & 8) s.glassGone.add(f.glass);
      sweepVisibility(f.root, s);
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

  it("never writes accessory flags", () => {
    const f = fixture();
    const s = freshState();
    f.accMesh.visible = false; // a state some other owner chose
    sweepVisibility(f.root, s);
    expect(f.accMesh.visible).toBe(false); // untouched
    s.bodyFadedOut = true;
    sweepVisibility(f.root, s);
    expect(f.accMesh.visible).toBe(false); // still the owner's
  });

  it("never writes a mesh parented under a mesh", () => {
    const f = fixture();
    const s = freshState();
    f.hull.visible = false;
    s.bodyFadedOut = true; // would hide the host — the child flag still stays
    sweepVisibility(f.root, s);
    expect(f.body.visible).toBe(false);
    expect(f.hull.visible).toBe(false);
    s.bodyFadedOut = false;
    f.hull.visible = true;
    sweepVisibility(f.root, s);
    expect(f.hull.visible).toBe(true);
  });
});

// The per-piece dissolve: exactly 1 at the threshold and exactly 0 at
// threshold - WINK_WIDTH.
describe("the wink's dissolve", () => {
  const TS = [WINK_WIDTH, 0.3, 0.5, 0.62, 0.7, SHELL_FEATHER - 1e-6];

  it("is exactly 1 at and above the threshold, exactly 0 at and below t − w", () => {
    for (const t of TS) {
      for (const lvl of [t, t + 1e-9, 1]) expect(winkOpacity(t, lvl), `t ${t} level ${lvl}`).toBe(1); // prettier-ignore
      for (const lvl of [t - WINK_WIDTH, t - WINK_WIDTH - 1e-9, 0])
        expect(winkOpacity(t, lvl), `t ${t} level ${lvl}`).toBe(0);
      const mid = winkOpacity(t, t - WINK_WIDTH / 2);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
      // monotone in the level
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const v = winkOpacity(t, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("is gone exactly where the opacity reaches 0 — the visibility cut's edge", () => {
    for (const t of TS) {
      expect(winkGone(t, t - WINK_WIDTH)).toBe(true);
      expect(winkGone(t, t - WINK_WIDTH + 1e-9)).toBe(false);
      expect(winkOpacity(t, t - WINK_WIDTH + 1e-9)).toBeGreaterThan(0);
    }
  });

  it("floors every band at WINK_WIDTH, so level 0 takes the last piece exactly", () => {
    const wink = makeWinkScatter();
    const names = [
      ...Array.from({ length: 30 }, (_, i) => `Barrel_Base_Seg${i}`),
      ...Array.from({ length: 12 }, (_, i) => `DecalT_Label${i}`),
      ...Array.from({ length: 12 }, (_, i) => `Baffle_Front_Seg${i}`),
      ...Array.from({ length: 12 }, (_, i) => `Cam_Barrel_Seg${i}`),
      ...Array.from({ length: 12 }, (_, i) => `Baffle_G2_Seg${i}`),
    ];
    expect(names.some(isPeelExtra), "a baffle name is in the roster").toBe(true); // prettier-ignore
    expect(names.some(isPeelTube), "a tube name is in the roster").toBe(true);
    let governed = 0;
    for (const n of names) {
      const w = wink(n);
      if (!w) continue;
      governed++;
      expect(w.threshold, n).toBeGreaterThanOrEqual(WINK_WIDTH);
      expect(w.threshold, n).toBeLessThan(SHELL_FEATHER);
      expect(winkOpacity(w.threshold, 0), `${n} at level 0`).toBe(0);
      expect(winkOpacity(w.threshold, 1), `${n} at level 1`).toBe(1);
    }
    expect(governed).toBeGreaterThan(40);
  });

  it("orders the casts: decals above baffles above wedges; tubes above the rest", () => {
    expect(SHELL_FEATHER).toBeGreaterThan(DECAL_BAND);
    expect(DECAL_BAND).toBeGreaterThan(EXTRA_BAND);
    expect(EXTRA_BAND).toBeGreaterThan(WINK_WIDTH);
    expect(REST_BAND).toBeGreaterThan(WINK_WIDTH);
    const wink = makeWinkScatter();
    const t = (n: string) => wink(n)!.threshold;
    expect(t("DecalT_Brand")).toBeGreaterThanOrEqual(DECAL_BAND);
    expect(t("Baffle_Front_Seg0")).toBeGreaterThanOrEqual(EXTRA_BAND);
    expect(t("Baffle_Front_Seg0")).toBeLessThan(DECAL_BAND);
    expect(t("Barrel_Base_Seg0")).toBeLessThan(EXTRA_BAND);
  });

  it("packs the lane round-trip, and WINK_NONE to no gate", () => {
    for (const w of [
      { channel: "shell", threshold: 0.31 },
      { channel: "interior", threshold: 0.74 },
    ] as const) {
      const back = unpackWink(packWink(w))!;
      expect(back.channel).toBe(w.channel);
      expect(back.threshold).toBeCloseTo(w.threshold, 12);
    }
    expect(unpackWink(packWink(null))).toBeNull();
    expect(packWink(null)).toBe(WINK_NONE);
    // an ungoverned lane reads as whole at every level
    expect(winkOpacity(WINK_NONE, 0)).toBe(1);
  });

  it("stamps every framed top-level mesh's lane from one scatter in traversal order", () => {
    const framed = (name: string) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry());
      m.name = name;
      m.geometry.setAttribute("_opY", new THREE.BufferAttribute(new Float32Array(3 * 4).fill(WINK_NONE), 4)); // prettier-ignore
      return m;
    };
    const root = new THREE.Group();
    const wedge0 = framed("Barrel_Base_Seg0");
    const decal = framed("DecalT_Brand");
    const tube = framed("Cam_Barrel_Seg0");
    const kept = framed("Element_01");
    const wedge1 = framed("Barrel_Base_Seg1");
    const hull = framed("Barrel_Base_Seg1_hull"); // a mesh under a mesh: skipped
    wedge1.add(hull);
    const bare = new THREE.Mesh(new THREE.BufferGeometry()); // governed, unframed
    bare.name = "Band_Mid_Seg0";
    root.add(wedge0, decal, tube, kept, wedge1, bare);
    const map = stampWinkLanes(root);
    const lane = (m: THREE.Mesh, i = 0) =>
      m.geometry.getAttribute("_opY").getW(i);
    const fresh = makeWinkScatter();
    // returned thresholds are the float32 values the attribute holds
    const asLane = (n: string) => Math.fround(packWink(fresh(n)));
    for (const m of [wedge0, decal, tube, kept, wedge1]) {
      const l = asLane(m.name);
      expect(lane(m), m.name).toBe(l);
      expect(lane(m, 2), `${m.name} every vertex`).toBe(l);
      expect(map.get(m) ?? null, `${m.name} in the map`).toEqual(unpackWink(l));
    }
    // an unframed mesh still gets a threshold, just no attribute
    expect(map.get(bare)).toEqual(unpackWink(asLane(bare.name)));
    expect(lane(hull)).toBe(WINK_NONE);
    expect(map.has(hull)).toBe(false);
    expect(lane(kept)).toBe(WINK_NONE);
    expect(lane(wedge0)).not.toBe(lane(wedge1));
  });
});
