import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { STARFIELD_LOOK, throatAngle } from "../starfield";
import { RING_LOOK, ringSourceRadius } from "../wormhole-post";

// THE EINSTEIN RING IS ONE FEATURE DRAWN BY TWO FILES — the sprites swing their
// streaks tangential inside a band of ANGLES about the exit axis
// (optics/starfield.ts), and this pass folds and smears the frame inside a band
// of RADII. They only read as one ring if the second band is the first one's
// own projection, which is why the radius is derived rather than authored. This
// file is the tripwire on that derivation: it projects a star direction at the
// band's angle through a real three camera and asks the post pass where it
// would put its ring.
//
// Everything else in the pass needs a GPU (it is a TSL graph over a render
// target) and is verified on the page.

/** The pass's radius metric, from a projected point: the aspect-corrected
 *  offset from the frame's centre in uv, in which the frame's half-height is
 *  exactly 0.5 whatever the aspect (optics/wormhole-post.ts's `r`). */
function radiusMetric(ndc: THREE.Vector3, aspect: number): number {
  const dx = (ndc.x * 0.5 + 0.5 - 0.5) * aspect;
  const dy = ndc.y * 0.5 + 0.5 - 0.5;
  return Math.hypot(dx, dy);
}

/** A camera parked on the dive's own heading: at the origin, looking down world
 *  +X (the exit axis both files stream toward), +Y up. */
function diveCamera(fov: number, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 400);
  cam.position.set(0, 0, 0);
  cam.up.set(0, 1, 0);
  cam.lookAt(1, 0, 0);
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
      for (const aspect of [16 / 9, 16 / 10, 1, 0.5]) {
        const cam = diveCamera(fov, aspect);
        const want = ringSourceRadius(fov);
        for (const dir of [up, across]) {
          const p = new THREE.Vector3(...dir).multiplyScalar(
            STARFIELD_LOOK.radius,
          );
          expect(radiusMetric(p.project(cam), aspect)).toBeCloseTo(want, 10);
        }
      }
    }
  });

  it("grows with a narrowing frame", () => {
    // A closing frame magnifies everything drawn on it, so the band the sprites
    // draw at a fixed ANGLE has to move outward as the fov comes back — the
    // story hands the dive's 70° back to the chain's 42° after the reveal
    // (story/fly.ts flyFovBackAt, over rewrap-local [0.25, 0.38] — a scene past
    // the sky's end), and the pass is mounted through all of it (the span runs
    // to rewrap-local 0.40). (Aspect-freeness is not restated here: the sweep
    // above proves it through a real projection, at four aspects.)
    expect(ringSourceRadius(42)).toBeGreaterThan(ringSourceRadius(70));
    expect(ringSourceRadius(70)).toBeGreaterThan(0);
  });

  it("keeps the fold's mirror on the near side of the throat", () => {
    // THE FOLD samples the source radius mirrored about the ring,
    // 2·rRing − rSrc, and the band is 0 outside rRing·(1 ± ringWidth). A half
    // width of 1 or more would put the far edge of the band past 2·rRing, where
    // the mirrored radius is negative and the tap crosses to the other side of
    // the frame — a hole, not a strata. See the fold's note in the shader.
    expect(RING_LOOK.ringWidth).toBeLessThan(1);
    expect(RING_LOOK.ringWidth).toBeGreaterThan(0);
  });
});
