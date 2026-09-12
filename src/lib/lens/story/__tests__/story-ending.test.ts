import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { shippedModel, placeModel } from "./shipped-model";
import { buildPieceTable, liveDeformAt } from "../flow";
import { pieceField, pieceFields } from "../../ops/cpu";
import { sampleStory, applyStoryFraming, type StorySample } from "../camera";
import { storyStateAt } from "../state";
const poseAt = (p: number) => {
  const t = new THREE.Vector3();
  sampleStory(p, new THREE.Vector3(), new THREE.Vector3(), t);
  return { target: t.toArray() };
};
import { farFor, frameZoom, parkScaleFor } from "../../core/scene";
import {
  uFadeNear0,
  uFadeNear1,
  uFadeFar0,
  uFadeFar1,
  writeFadeBands,
} from "../../materials/depthfade";
import { STORY_R, atFrac, rangeOf, type Pose } from "../story";

// ============================================================================
// THE ENDING'S FRAME, MEASURED THROUGH THE REAL PROJECTION OVER THE REAL CLOUD.
//
// Three properties of the ending are about where the PIECES land on screen, and
// no law stated in p can see them:
//
//   · THE FLATTEN MUST NOT READ AS A ZOOM. Its pullback is paired with its fov,
//     so `|pos| · tan(fov/2)` is an identity; the FIGURE's projected radius is
//     the number the reader sees.
//   · THE HELD CLOUD MUST SIT INSIDE ITS OWN DEPTH-FADE BAND, or part of it is
//     drawn half-transparent.
//   · AND IT HAS TO FIT — on a phone the binding dimension is the WIDTH, which
//     core/scene's zoom law fixes at one frame half-height whatever the aspect.
//
// Every number comes off ops/cpu.ts's `pieceField` at `storyStateAt(p)`'s
// channels, over the shipped GLB's frames, projected by a real THREE camera
// `applyStoryFraming` has placed.
// ============================================================================

const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");
const gltf = shippedModel();
const { modelRadius } = placeModel(gltf);
const table = buildPieceTable(gltf);
const PIECE_NAMES = new Set(table.pieces.map((r) => r.name));

/** A LANDSCAPE and a PORTRAIT canvas: 16:9, and the phone the story is read on. */
const WIDE: [number, number] = [1440, 810];
const PHONE: [number, number] = [390, 844];

/** Every vertex of the deformed model at `p`, in world space, at a stride —
 *  these laws are about the SILHOUETTE, so they read the geometry itself rather
 *  than the piece frames' own probe points. */
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

/** …and one point per PIECE — its frame origin, deformed. The depth fade is a
 *  per-vertex ramp, but a piece is small against the band, so this is the
 *  reading that says whether a PIECE is ghosted. */
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

/** the camera core/scene would have at `p` on a `w`×`h` canvas */
function cameraAt(p: number, [w, h]: [number, number]) {
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const target = new THREE.Vector3();
  const sample = sampleStory(p, pos, up, target);
  return place(sample, pos, up, target, [w, h]);
}

/** …and the camera a POSE alone would give, with no flatten in it: the
 *  counterfactual the blend has to match. */
function poseCamera(pose: Pose, wh: [number, number]) {
  return place(
    {
      fov: pose.fov,
      xs: pose.xs,
      ys: pose.ys ?? 0,
      wide: pose.wide ?? 1,
      near: pose.near ?? 1,
      lift: pose.lift ?? 0.06,
    },
    new THREE.Vector3(...pose.pos).multiplyScalar(STORY_R),
    new THREE.Vector3(...pose.up),
    new THREE.Vector3(...(pose.target ?? [0, 0, 0])),
    wh,
  );
}

function place(
  sample: StorySample,
  pos: THREE.Vector3,
  up: THREE.Vector3,
  target: THREE.Vector3,
  [w, h]: [number, number],
) {
  const cam = new THREE.PerspectiveCamera(sample.fov, w / h, 0.1, 400);
  cam.zoom = frameZoom(w, h);
  up.normalize();
  applyStoryFraming(cam, sample, pos, up, target, w, h, parkScaleFor(w, h));
  cam.updateMatrixWorld(true);
  return cam;
}

/** The figure's SCREEN RADIUS, in frame half-heights: the farthest the cloud
 *  reaches from the frame's centre once projected. ndc x is in half-WIDTHS, so
 *  it is put back into half-heights before the two are combined — the number is
 *  then the same reading at any viewport shape. */
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

/** the widest the cloud reaches across the frame, in half-widths: past 1 it is
 *  clipped left or right */
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
  // THE NO-POP LAW, ON THE FIGURE: at the park the projection is wholly
  // orthographic, and the same p with the row's own perspective pose is the
  // frame the reader would have had. The blend is a projection change only if
  // the two put the cloud at the same size — what the rewrap's TARGET buys.
  it("puts the cloud the same size on screen with the flatten and without", () => {
    const p = atFrac(rwR, 0.99);
    const cloud = cloudAt(p);
    for (const wh of [WIDE, PHONE]) {
      const flat = screenRadius(cloud, cameraAt(p, wh));
      const persp = screenRadius(cloud, poseCamera(rwR.scene.cam, wh));
      expect(sampleStory(p, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()).fov).toBeCloseTo(3, 9); // prettier-ignore
      expect(Math.abs(flat / persp - 1), `${wh[0]}x${wh[1]}`).toBeLessThan(
        0.02,
      );
    }
  });

  // …AND NO STEP GETTING THERE: nothing in the model moves across the rewrap,
  // so every change in the figure's size over the blend-in is the CAMERA's.
  // Sampled fine enough that a cut shows.
  it("never steps: the blend-in is one ramp on the figure's own size", () => {
    const open = atFrac(rwR, rwR.scene.orthoIn![0]);
    const cloud = cloudAt(open);
    let prev = screenRadius(cloud, cameraAt(open, WIDE));
    const first = prev;
    let worst = 0;
    for (let i = 1; i <= 120; i++) {
      const p = open + ((rwR.p1 - open) * i) / 120;
      const r = screenRadius(cloud, cameraAt(p, WIDE));
      worst = Math.max(worst, Math.abs(r - prev) / prev);
      prev = r;
    }
    expect(worst).toBeLessThan(0.01);
    // the ramp is the DOLLY's — the figure tightens as the camera pulls back,
    // and it is a walk, not a jump
    expect(prev).toBeLessThan(first);
    expect(prev).toBeGreaterThan(0.8 * first);
  });

  // THE SEAM. The flatten spans the scene boundary, so the rewrap's last frame
  // and the descent's first are one held frame — the cloud lands on the same
  // pixels or the boundary is a cut.
  it("hands the flat frame across the scene boundary unchanged", () => {
    const cloud = cloudAt(capR.p0);
    const before = screenRadius(cloud, cameraAt(rwR.p1 - 1e-9, WIDE));
    const after = screenRadius(cloud, cameraAt(capR.p0, WIDE));
    expect(after).toBeCloseTo(before, 9);
  });
});

describe("the ending's depth fade", () => {
  /** materials/depthfade.ts's own shader ramp, on the four planes the SHIPPED
   *  writer has just placed (core/scene.ts calls it with exactly these four
   *  arguments every frame) */
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

  /** every piece's drawn fade at `p`, through the shipped placement */
  function fades(p: number): number[] {
    const st = storyStateAt(p);
    const cam = cameraAt(p, WIDE);
    writeFadeBands(
      new THREE.Vector3().subVectors(
        cam.position,
        new THREE.Vector3(...poseAt(p).target),
      ),
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
    // the park: the whole figure is the subject, and none of it is ghosted —
    // the descent's own first frames are that same held frame
    for (const f of [0.95, 0.99]) {
      const park = fades(atFrac(rwR, f));
      expect(Math.min(...park), `rewrap ${f}`).toBeGreaterThan(0.5);
    }
    // …and through the descent NO PIECE THE READER CAN SEE goes under half.
    // The waiting cloud parks OFF the frame's sides by design, so the ghost
    // floor is a law about the pieces ON STAGE.
    const visible = (p: number): number[] => {
      const cam = cameraAt(p, WIDE);
      const pieces = piecesAt(p);
      const v = new THREE.Vector3();
      return fades(p).filter((_, i) => {
        v.copy(pieces[i]).project(cam);
        return Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05 && v.z < 1;
      });
    };
    expect(visible(atFrac(capR, 0.16)).filter((v) => v < 0.5)).toHaveLength(0);
    // The band dips mid-descent, where a single sample would miss it, so the
    // descent is scanned and floored.
    let worst = 1;
    let sampled = 0;
    for (let i = 0; i <= 64; i++) {
      const vis = visible(atFrac(capR, i / 100));
      if (!vis.length) continue;
      sampled++;
      worst = Math.min(worst, ...vis);
    }
    expect(sampled).toBeGreaterThan(50);
    expect(worst, "the descent's deepest visible ghost").toBeGreaterThan(0.5);
    // and by the time the pieces are home the fade is off entirely. 0.6, not
    // 0.5: the dispersal is a BUMP on the flight, so the cloud is still opened
    // out at a channel value the band reads as nearly home.
    expect(Math.min(...fades(atFrac(capR, 0.6)))).toBe(1);
  });
});

describe("the ending on a phone", () => {
  // PORTRAIT IS THE BINDING CASE: core/scene drives zoom from min(w,h)/h, so a
  // portrait frame is exactly ONE half-height wide however narrow the screen
  // is, and the held spread is clipped unless the pose says how much frame it
  // needs (`Pose.wide`).
  it("holds the whole spread inside the frame, sides included", () => {
    for (const f of [0.6, 0.8, 0.95]) {
      const p = atFrac(rwR, f);
      expect(maxNdcX(cloudAt(p), cameraAt(p, PHONE)), `rewrap ${f}`).toBeLessThan(1); // prettier-ignore
    }
    // …then the descent INVERTS the law: from the turn on, the waiting cloud
    // parks OFF the frame and the pieces arrive from out of view. Pinned as an
    // overflow so a framing retune cannot put the parked cloud back on stage.
    for (const f of [0.3, 0.44]) {
      const p = atFrac(capR, f);
      expect(maxNdcX(cloudAt(p), cameraAt(p, PHONE)), `capsOn ${f}`).toBeGreaterThan(1); // prettier-ignore
    }
    // …while the LANDED lens — the rock's and the bloom's subject — fits
    // whole, sides included, on the same frame
    for (const f of [0.7, 0.94]) {
      const p = atFrac(capR, f);
      expect(maxNdcX(cloudAt(p), cameraAt(p, PHONE)), `capsOn ${f}`).toBeLessThan(1); // prettier-ignore
    }
  });

  // THE PULL-BACK CAN OUTRUN THE FAR PLANE: the flatten parks the camera ten
  // times its own reach out and the portrait reach multiplies that again, so
  // core/scene raises the plane to follow (`farFor`).
  it("keeps the flat park inside its own far plane", () => {
    const p = atFrac(rwR, 0.95);
    const cloud = cloudAt(p);
    for (const wh of [WIDE, PHONE]) {
      const cam = cameraAt(p, wh);
      const far = farFor(cam.position.length(), modelRadius);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      let deepest = 0;
      for (const w of cloud)
        deepest = Math.max(deepest, w.clone().sub(cam.position).dot(fwd));
      expect(deepest, `${wh[0]}x${wh[1]}`).toBeLessThan(far);
    }
  });

  it("costs a LANDSCAPE frame nothing — the reach is portrait's alone", () => {
    // 16:9 is wider than anything the ending asks for, so the pose is used
    // exactly as authored.
    for (const f of [0.5, 0.95]) {
      const p = atFrac(rwR, f);
      const pos = new THREE.Vector3();
      const target = new THREE.Vector3();
      const sample = sampleStory(p, pos, new THREE.Vector3(), target);
      expect(sample.wide).toBeLessThan(WIDE[0] / WIDE[1]);
      // the camera sits at target + the pose's own offset, unscaled
      expect(cameraAt(p, WIDE).position.distanceTo(target.add(pos))).toBeCloseTo(0, 9); // prettier-ignore
    }
    // the bloom's own frame is untouched at every shape: the reach is handed
    // back over the descent's turn, before the flower opens
    expect(
      sampleStory(atFrac(capR, 0.5), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()).wide, // prettier-ignore
    ).toBe(1);
  });
});
