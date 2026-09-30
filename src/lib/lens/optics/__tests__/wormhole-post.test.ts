import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { STARFIELD_LOOK, throatAngle } from "../starfield";
import { RING_LOOK, ringSourceRadius } from "../wormhole-post";

// The ring is drawn by the starfield (as an angle off the exit axis) and by the
// post pass (as a screen radius); these check the two line up.

/** Post-pass radius from the frame centre, aspect-corrected (half-height 0.5). */
function radiusMetric(ndc: THREE.Vector3, aspect: number): number {
  const dx = (ndc.x * 0.5 + 0.5 - 0.5) * aspect;
  const dy = ndc.y * 0.5 + 0.5 - 0.5;
  return Math.hypot(dx, dy);
}

/** A camera at the origin looking down +X, with the scene's zoom = min(aspect, 1). */
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
    // two directions at that angle off the exit axis: one up, one across
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
    expect(ringSourceRadius(42)).toBeGreaterThan(ringSourceRadius(70));
    expect(ringSourceRadius(70)).toBeGreaterThan(0);
  });

  it("keeps the fold's mirror on the near side of the throat", () => {
    // a half width ≥ 1 would make the mirrored radius (2·rRing − r) negative
    expect(RING_LOOK.ringWidth).toBeLessThan(1);
    expect(RING_LOOK.ringWidth).toBeGreaterThan(0);
  });
});
