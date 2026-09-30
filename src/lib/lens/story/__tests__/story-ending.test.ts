import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  framedCamera,
  placeModel,
  shippedModel,
  storyCamera,
  storySampleAt,
} from "./shipped-model";
import { buildPieceTable, liveDeformAt } from "../flow";
import { pieceField, pieceFields } from "../../ops/cpu";
import { storyStateAt } from "../state";
import { farFor } from "../../core/scene";
import {
  uFadeNear0,
  uFadeNear1,
  uFadeFar0,
  uFadeFar1,
  writeFadeBands,
} from "../../materials/depthfade";
import { STORY_R, atFrac, rangeOf, type Pose } from "../story";

// The ending's frame, measured by projecting the shipped model's deformed
// pieces through the real story camera: the flatten must not read as a zoom,
// the cloud must sit inside its depth-fade band, and it must fit a phone.

const rewrapScene = rangeOf("rewrap");
const bloomScene = rangeOf("capsOn");
const gltf = shippedModel();
const { modelRadius } = placeModel(gltf);
const table = buildPieceTable(gltf);
const PIECE_NAMES = new Set(table.pieces.map((r) => r.name));

/** A 16:9 landscape canvas and a phone portrait one. */
const WIDE: [number, number] = [1440, 810];
const PHONE: [number, number] = [390, 844];

/** Every `stride`th vertex of the deformed model at `p`, in world space. */
function cloudAt(p: number, stride = 11): THREE.Vector3[] {
  const live = liveDeformAt(p);
  const dolly = storyStateAt(p).model.dollyX;
  const out: THREE.Vector3[] = [];
  const d: [number, number, number] = [0, 0, 0];
  gltf.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !PIECE_NAMES.has(o.name)) return;
    const pos = o.geometry.getAttribute("position");
    const fields = pieceFields(o.geometry, live);
    if (!pos || !fields) return;
    for (let i = 0; i < pos.count; i += stride) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      fields(i)(x, y, z, d);
      const w = new THREE.Vector3(x + d[0], y + d[1], z + d[2]).applyMatrix4(
        o.matrixWorld,
      );
      w.x += dolly;
      out.push(w);
    }
  });
  return out;
}

/** Each piece's deformed frame origin at `p`, in world space. */
function piecesAt(p: number): THREE.Vector3[] {
  const live = liveDeformAt(p);
  const dolly = storyStateAt(p).model.dollyX;
  const d: [number, number, number] = [0, 0, 0];
  return table.pieces.map((row) => {
    const l = row.lanes;
    const o: [number, number, number] = [
      l.R * Math.cos(l.t0),
      (l.yMin + l.yMax) * 0.5,
      l.R * Math.sin(l.t0),
    ];
    pieceField(l, live)(o[0], o[1], o[2], d);
    const w = new THREE.Vector3(o[0] + d[0], o[1] + d[1], o[2] + d[2]);
    w.applyMatrix4(gltf.getObjectByName(row.name)!.matrixWorld);
    w.x += dolly;
    return w;
  });
}

/** The camera a pose alone would give, with no flatten. */
function poseCamera(pose: Pose, wh: [number, number]) {
  return framedCamera(
    {
      fov: pose.fov,
      xs: pose.xs,
      ys: pose.ys ?? 0,
      wide: pose.wide ?? 1,
      near: pose.near ?? 1,
      lift: pose.lift ?? 0.06,
    },
    new THREE.Vector3(...pose.pos).multiplyScalar(STORY_R),
    new THREE.Vector3(...pose.up).normalize(),
    new THREE.Vector3(...(pose.target ?? [0, 0, 0])),
    wh,
  );
}

/** The cloud's projected radius from the frame centre, in frame half-heights
 *  (ndc x is rescaled from half-widths). */
function screenRadius(cloud: THREE.Vector3[], cam: THREE.PerspectiveCamera) {
  const frameW = cam.aspect / cam.zoom;
  let r = 0;
  const v = new THREE.Vector3();
  for (const w of cloud) {
    v.copy(w).project(cam);
    r = Math.max(r, Math.hypot(v.x * frameW, v.y));
  }
  return r;
}

/** How far across the frame the cloud reaches, in half-widths (> 1 = clipped). */
function maxNdcX(cloud: THREE.Vector3[], cam: THREE.PerspectiveCamera) {
  let x = 0;
  const v = new THREE.Vector3();
  for (const w of cloud) {
    v.copy(w).project(cam);
    if (v.z < 1) x = Math.max(x, Math.abs(v.x));
  }
  return x;
}

describe("the ending's flat frame", () => {
  // flat and perspective must put the cloud at the same size on screen
  it("puts the cloud the same size on screen with the flatten and without", () => {
    const p = atFrac(rewrapScene, 0.99);
    const cloud = cloudAt(p);
    expect(storySampleAt(p).sample.fov).toBeCloseTo(3, 9);
    for (const wh of [WIDE, PHONE]) {
      const flat = screenRadius(cloud, storyCamera(p, wh));
      const persp = screenRadius(cloud, poseCamera(rewrapScene.scene.cam, wh));
      expect(Math.abs(flat / persp - 1), `${wh[0]}x${wh[1]}`).toBeLessThan(
        0.02,
      );
    }
  });

  // the model is still across the rewrap, so any size change is the camera's
  it("never steps: the blend-in is one ramp on the figure's own size", () => {
    const open = atFrac(rewrapScene, rewrapScene.scene.orthoIn![0]);
    const cloud = cloudAt(open);
    let prev = screenRadius(cloud, storyCamera(open, WIDE));
    const first = prev;
    let worst = 0;
    for (let i = 1; i <= 120; i++) {
      const p = open + ((rewrapScene.p1 - open) * i) / 120;
      const r = screenRadius(cloud, storyCamera(p, WIDE));
      worst = Math.max(worst, Math.abs(r - prev) / prev);
      prev = r;
    }
    expect(worst).toBeLessThan(0.01);
    // the cloud shrinks gradually as the camera pulls back
    expect(prev).toBeLessThan(first);
    expect(prev).toBeGreaterThan(0.8 * first);
  });

  // the flat frame spans the scene boundary without a cut
  it("hands the flat frame across the scene boundary unchanged", () => {
    const cloud = cloudAt(bloomScene.p0);
    const before = screenRadius(
      cloud,
      storyCamera(rewrapScene.p1 - 1e-9, WIDE),
    );
    const after = screenRadius(cloud, storyCamera(bloomScene.p0, WIDE));
    expect(after).toBeCloseTo(before, 9);
  });
});

describe("the ending's depth fade", () => {
  /** materials/depthfade.ts's shader ramp, on the planes writeFadeBands set */
  const drawnFade = (viewZ: number) => {
    const ramp = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    return (
      ramp(uFadeNear0.value, uFadeNear1.value, viewZ) *
      (1 - ramp(uFadeFar0.value, uFadeFar1.value, viewZ))
    );
  };

  /** every piece's drawn fade at `p` */
  function fades(p: number): number[] {
    const st = storyStateAt(p);
    const cam = storyCamera(p, WIDE);
    writeFadeBands(
      new THREE.Vector3().subVectors(cam.position, storySampleAt(p).target),
      st.model.dollyX,
      modelRadius,
      Math.max(st.channels.explode, st.channels.assemble),
    );
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    return piecesAt(p).map((w) =>
      drawnFade(w.clone().sub(cam.position).dot(fwd)),
    );
  }

  it("keeps the held cloud inside its own band — the spread is the band's width", () => {
    // at the park nothing is ghosted
    for (const f of [0.95, 0.99]) {
      const park = fades(atFrac(rewrapScene, f));
      expect(Math.min(...park), `rewrap ${f}`).toBeGreaterThan(0.5);
    }
    // through the descent no on-screen piece fades below half (the waiting
    // cloud parks off-screen by design)
    const visible = (p: number): number[] => {
      const cam = storyCamera(p, WIDE);
      const pieces = piecesAt(p);
      const v = new THREE.Vector3();
      return fades(p).filter((_, i) => {
        v.copy(pieces[i]).project(cam);
        return Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 && v.z < 1;
      });
    };
    expect(
      visible(atFrac(bloomScene, 0.16)).filter((v) => v < 0.5),
    ).toHaveLength(0);
    // scan the descent, since the band dips mid-way
    let worst = 1;
    let sampled = 0;
    for (let i = 0; i <= 64; i++) {
      const vis = visible(atFrac(bloomScene, i / 100));
      if (!vis.length) continue;
      sampled++;
      worst = Math.min(worst, ...vis);
    }
    expect(sampled).toBeGreaterThan(50);
    expect(worst, "the descent's deepest visible ghost").toBeGreaterThan(0.5);
    // once the pieces are home the fade is off entirely
    expect(Math.min(...fades(atFrac(bloomScene, 0.6)))).toBe(1);
  });
});

describe("the ending on a phone", () => {
  // a portrait frame is one half-height wide, so Pose.wide must fit the spread
  it("holds the whole spread inside the frame, sides included", () => {
    for (const f of [0.6, 0.8, 0.95]) {
      const p = atFrac(rewrapScene, f);
      expect(maxNdcX(cloudAt(p), storyCamera(p, PHONE)), `rewrap ${f}`).toBeLessThan(1); // prettier-ignore
    }
    // from the turn on, the waiting cloud parks off-screen
    for (const f of [0.3, 0.44]) {
      const p = atFrac(bloomScene, f);
      expect(maxNdcX(cloudAt(p), storyCamera(p, PHONE)), `capsOn ${f}`).toBeGreaterThan(1); // prettier-ignore
    }
    // while the landed lens fits whole
    for (const f of [0.7, 0.94]) {
      const p = atFrac(bloomScene, f);
      expect(maxNdcX(cloudAt(p), storyCamera(p, PHONE)), `capsOn ${f}`).toBeLessThan(1); // prettier-ignore
    }
  });

  // the flat pull-back is far out, so farFor must raise the far plane
  it("keeps the flat park inside its own far plane", () => {
    const p = atFrac(rewrapScene, 0.95);
    const cloud = cloudAt(p);
    for (const wh of [WIDE, PHONE]) {
      const cam = storyCamera(p, wh);
      const far = farFor(cam.position.length(), modelRadius);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      let deepest = 0;
      for (const w of cloud)
        deepest = Math.max(deepest, w.clone().sub(cam.position).dot(fwd));
      expect(deepest, `${wh[0]}x${wh[1]}`).toBeLessThan(far);
    }
  });

  it("costs a LANDSCAPE frame nothing — the reach is portrait's alone", () => {
    // 16:9 is wider than the ending needs, so the pose is used as authored
    for (const f of [0.5, 0.95]) {
      const p = atFrac(rewrapScene, f);
      const { sample, pos, target } = storySampleAt(p);
      expect(sample.wide).toBeLessThan(WIDE[0] / WIDE[1]);
      expect(storyCamera(p, WIDE).position.distanceTo(target.add(pos))).toBeCloseTo(0, 9); // prettier-ignore
    }
    // the bloom's frame never pulls back
    expect(storySampleAt(atFrac(bloomScene, 0.5)).sample.wide).toBe(1);
  });
});
