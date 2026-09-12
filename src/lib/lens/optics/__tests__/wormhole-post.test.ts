import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { STARFIELD_LOOK, throatAngle } from "../starfield";
import { RING_LOOK, ringSourceRadius } from "../wormhole-post";

// The Einstein ring is one feature drawn by two files: the sprites band by
// ANGLE about the exit axis (optics/starfield.ts), the post pass by RADII. They
// read as one ring only while the radius is the angle band's own projection —
// pinned here by projecting through a real three camera.
// The rest of the pass needs a GPU and is verified on the page.

/** The pass's radius metric, from a projected point: the aspect-corrected
 *  offset from the frame's centre in uv, in which the frame's half-height is
 *  exactly 0.5 whatever the aspect (optics/wormhole-post.ts's `r`). */
function radiusMetric(ndc: THREE.Vector3, aspect: number): number {
  const dx = (ndc.x * 0.5 + 0.5 - 0.5) * aspect;
  const dy = ndc.y * 0.5 + 0.5 - 0.5;
  return Math.hypot(dx, dy);
}

/** A camera on the dive's heading: origin, looking down world +X, +Y up, and
 *  carrying core/scene.ts's zoom law min(w, h)/h so the sweep projects through
 *  the projection the page really builds. */
function diveCamera(fov: number, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 400);
  cam.position.set(0, 0, 0);
  cam.up.set(0, 1, 0);
  cam.lookAt(1, 0, 0);
  cam.zoom = Math.min(aspect, 1);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

describe("wormhole post ring", () => {
  it("puts its band where the sprites' band projects, at any fov", () => {
    const g = STARFIELD_LOOK.ringCentreRad;
    // the two directions at exactly that angle off the exit axis: one lifted
    // along the camera's up, one swung across it. `throatAngle` is the
    // starfield's own measure, so this also pins the shared exit axis.
    const up: [number, number, number] = [Math.cos(g), Math.sin(g), 0];
    const across: [number, number, number] = [Math.cos(g), 0, Math.sin(g)];
    expect(throatAngle(up)).toBeCloseTo(g, 12);
    expect(throatAngle(across)).toBeCloseTo(g, 12);

    for (const fov of [70, 55, 42]) {
      for (const aspect of [16 / 9, 16 / 10, 1, 0.5, 390 / 844]) {
        const cam = diveCamera(fov, aspect);
        const want = ringSourceRadius(fov, cam.zoom);
        for (const dir of [up, across]) {
          const p = new THREE.Vector3(...dir).multiplyScalar(
            STARFIELD_LOOK.radius,
          );
          expect(radiusMetric(p.project(cam), aspect)).toBeCloseTo(want, 10);
        }
      }
    }
  });

  it("keeps the ring inside the frame's short side on any portrait viewport", () => {
    // Without the zoom term the band comes out 1/aspect too big and its circle
    // runs off the frame's sides; with it, the ring holds one fraction of the
    // short side at every portrait aspect.
    for (const [w, h] of [
      [390, 844],
      [360, 800],
      [430, 932],
      [768, 1024],
    ]) {
      const cam = diveCamera(70, w / h);
      const halfWidth = 0.5 * cam.aspect; // the metric's frame half-width
      expect(ringSourceRadius(70, cam.zoom)).toBeLessThan(halfWidth);
      expect(ringSourceRadius(70, cam.zoom) / halfWidth).toBeCloseTo(0.69, 2);
    }
  });

  it("grows with a narrowing frame", () => {
    // A closing frame magnifies what is drawn on it, so a band at a fixed ANGLE
    // moves outward as the fov comes back (the story hands 70° back to 42°
    // while the pass is still mounted).
    expect(ringSourceRadius(42)).toBeGreaterThan(ringSourceRadius(70));
    expect(ringSourceRadius(70)).toBeGreaterThan(0);
  });

  it("keeps the fold's mirror on the near side of the throat", () => {
    // The fold mirrors the source radius about the ring (2·rRing − rSrc), so a
    // half width ≥ 1 puts the band's far edge past 2·rRing where the mirrored
    // radius goes negative and the tap crosses the frame.
    expect(RING_LOOK.ringWidth).toBeLessThan(1);
    expect(RING_LOOK.ringWidth).toBeGreaterThan(0);
  });
});
