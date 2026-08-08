import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { AUTHORED_COUNT, SKY, THROAT_ALT, THROAT_AZ, dirOf } from "../sky";
import {
  STARFIELD_LOOK,
  buildLineQuads,
  buildStarQuads,
  createStarfield,
  ringWeight,
  starRho,
  streakOf,
  throatAngle,
} from "../starfield";

// The drawn starfield's PURE half: the catalog → quad packing, and the
// great-circle streak basis the vertex graph stretches each quad along. The
// shader itself needs a GPU and is verified in the demo.
//
// Nothing here touches optics/sky.ts's bake — that path still ships behind
// `?tracesky` and keeps its own tests.

const THROAT = dirOf(THROAT_AZ, THROAT_ALT);
const dot = (a: number[], b: number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("starfield", () => {
  it("(a) aims every streak along the great circle toward the throat", () => {
    for (const [i, s] of SKY.stars.entries()) {
      const d = dirOf(s.az, s.alt);
      const { tan, len } = streakOf(d);
      if (len === 0) continue; // on the axis, or too close to it to streak
      // a unit tangent…
      expect(Math.hypot(...tan), `star ${i} |tan|`).toBeCloseTo(1, 12);
      // …perpendicular to the star (a great-circle tangent AT the star)…
      expect(dot(tan, d), `star ${i} tan·dir`).toBeCloseTo(0, 12);
      // …leaning toward the throat, never away from it.
      expect(dot(tan, THROAT), `star ${i} tan·throat`).toBeGreaterThan(0);
    }
  });

  it("(b) grows the streak with the angle to the throat, and never past it", () => {
    // sampled along one meridian: γ runs 0 → π as az does
    let prev = -1;
    for (const az of [0.2, 0.6, 1.0, 1.6, 2.2, 2.8, 3.1]) {
      const { len } = streakOf(dirOf(az, 0));
      expect(len).toBeGreaterThan(prev);
      expect(len, `az ${az} never overshoots the throat`).toBeLessThanOrEqual(
        az + 1e-12,
      );
      prev = len;
    }
    expect(streakOf(dirOf(3.14159, 0)).len).toBeCloseTo(
      STARFIELD_LOOK.streakLenRad,
      3,
    );
  });

  it("(c) leaves a star ON the exit axis with no streak at all", () => {
    // no unique great circle joins a star to itself
    expect(streakOf(THROAT)).toEqual({ tan: [0, 0, 0], len: 0 });
    // and the antipode is a degenerate tangent too
    expect(streakOf([-1, 0, 0]).len).toBe(0);
    // near the axis the length collapses under streakMinLenRad and is dropped
    expect(streakOf(dirOf(0.01, 0)).len).toBe(0);
  });

  it("(d) packs one quad per star, four corners covering [-1,1]²", () => {
    const q = buildStarQuads(SKY.stars);
    const n = SKY.stars.length;
    expect(q.position.length).toBe(n * 4 * 3);
    expect(q.dir.length).toBe(n * 4 * 3);
    expect(q.tan.length).toBe(n * 4 * 3);
    expect(q.rho.length).toBe(n * 4);
    expect(q.len.length).toBe(n * 4);
    expect(q.index.length).toBe(n * 6);
    // every index addresses a real vertex
    for (const i of q.index) expect(i).toBeLessThan(n * 4);
    // the four corners of star 0 are the four sign combinations, once each
    const corners = new Set<string>();
    for (let c = 0; c < 4; c++)
      corners.add(`${q.position[c * 3]},${q.position[c * 3 + 1]}`);
    expect(corners).toEqual(new Set(["-1,-1", "1,-1", "1,1", "-1,1"]));
  });

  it("(e) repeats each star's own direction, radius and streak on all four corners", () => {
    const q = buildStarQuads(SKY.stars);
    for (const [s, star] of SKY.stars.entries()) {
      const d = dirOf(star.az, star.alt);
      const streak = streakOf(d);
      const rho = starRho(star.mag);
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        // float32 storage — 6 places is all the attribute buffer carries
        expect(q.rho[v], `star ${s} rho`).toBeCloseTo(rho, 6);
        expect(q.len[v], `star ${s} len`).toBeCloseTo(streak.len, 6);
        for (let k = 0; k < 3; k++) {
          expect(q.dir[v * 3 + k], `star ${s} dir[${k}]`).toBeCloseTo(d[k], 6);
          expect(q.tan[v * 3 + k], `star ${s} tan[${k}]`).toBeCloseTo(
            streak.tan[k],
            6,
          );
        }
      }
    }
  });

  it("(e2) bands the ring: peak at the centre, smooth 0 at both edges, calm axis", () => {
    const c = STARFIELD_LOOK.ringCentreRad;
    const hw = STARFIELD_LOOK.ringHalfWidthRad;
    // 1 at the centre, exactly 0 at and beyond both edges
    expect(ringWeight(c)).toBe(1);
    expect(ringWeight(c - hw)).toBe(0);
    expect(ringWeight(c + hw)).toBe(0);
    expect(ringWeight(c - hw - 0.2)).toBe(0);
    expect(ringWeight(c + hw + 0.9)).toBe(0);
    // THE CALM CENTRE: nothing on or near the exit axis swings tangential
    expect(ringWeight(0)).toBe(0);
    expect(c - hw, "the band must clear the axis").toBeGreaterThan(0);
    // …and the far field keeps its radial streaks
    expect(ringWeight(Math.PI)).toBe(0);
    // symmetric, monotone on each side, and no edge to see (slope → 0 there)
    for (let i = 1; i < 20; i++) {
      const d = (hw * i) / 20;
      expect(ringWeight(c - d)).toBeCloseTo(ringWeight(c + d), 12);
      expect(ringWeight(c + d)).toBeLessThan(ringWeight(c + d - hw / 20));
    }
    const eps = hw / 1000;
    expect(ringWeight(c + hw - eps)).toBeLessThan(1e-4);
    expect(ringWeight(c - hw + eps)).toBeLessThan(1e-4);
  });

  it("(e3) bakes the band weight per star, from the angle to the throat", () => {
    const q = buildStarQuads(SKY.stars);
    let inBand = 0;
    for (const [s, star] of SKY.stars.entries()) {
      const w = ringWeight(throatAngle(dirOf(star.az, star.alt)));
      if (w > 0) inBand++;
      for (let c = 0; c < 4; c++)
        expect(q.ring[s * 4 + c], `star ${s} ring`).toBeCloseTo(w, 6);
    }
    // the authored sky must actually HAVE stars in the band, or the ring is a
    // shader that draws nothing
    expect(inBand).toBeGreaterThan(0);
    // the throat itself is on the axis: γ = 0, weight 0
    expect(throatAngle(THROAT as [number, number, number])).toBeCloseTo(0, 12);
    expect(throatAngle([-THROAT[0], -THROAT[1], -THROAT[2]])).toBeCloseTo(
      Math.PI,
      6,
    );
  });

  it("(f) sizes discs by magnitude, monotonically", () => {
    expect(starRho(1)).toBeCloseTo(STARFIELD_LOOK.starRhoRad, 12);
    expect(starRho(3)).toBeGreaterThan(starRho(2));
    expect(starRho(2)).toBeGreaterThan(starRho(1));
    expect(starRho(0.5)).toBeLessThan(starRho(1));
  });

  it("(f2) draws the generated background clearly UNDER the authored stars", () => {
    // The deep-field contract: the background is texture, the authored table is
    // shape. If the exponent ever flattens far enough to close that gap the
    // finale goes back to reading as one undifferentiated sheet of dots.
    const authored = SKY.stars.slice(0, AUTHORED_COUNT);
    const bg = SKY.stars.slice(AUTHORED_COUNT);
    const median = (stars: typeof bg) =>
      stars.map((s) => starRho(s.mag)).sort((p, q) => p - q)[
        Math.floor(stars.length / 2)
      ];
    expect(median(bg)).toBeLessThan(median(authored) * 0.5);
    // and the hierarchy across the whole catalog is wide, not flat
    expect(starRho(3.1) / starRho(0.3)).toBeGreaterThan(6);
  });

  it("(g) draws EVERY authored constellation line — no seam to skip", () => {
    // the bake drops any stroke straddling equirect u = 0/1 (optics/sky.ts);
    // directions have no seam, so the drawn path owes one quad per pair.
    const pairs = SKY.constellations.reduce((n, c) => n + c.lines.length, 0);
    const l = buildLineQuads(SKY.constellations, SKY.stars);
    expect(l.position.length).toBe(pairs * 4 * 3);
    expect(l.index.length).toBe(pairs * 6);
    for (const i of l.index) expect(i).toBeLessThan(pairs * 4);
    // side ∈ {−1, +1}, end ∈ {0, 1}, and each corner appears exactly once
    const seen = new Set<string>();
    for (let c = 0; c < 4; c++)
      seen.add(`${l.position[c * 3]},${l.position[c * 3 + 1]}`);
    expect(seen).toEqual(new Set(["-1,0", "1,0", "1,1", "-1,1"]));
  });

  it("(h) puts each stroke's endpoints on its two stars' directions", () => {
    const l = buildLineQuads(SKY.constellations, SKY.stars);
    const pairs = SKY.constellations.flatMap((c) => c.lines);
    for (const [s, [ia, ib]] of pairs.entries()) {
      const da = dirOf(SKY.stars[ia].az, SKY.stars[ia].alt);
      const db = dirOf(SKY.stars[ib].az, SKY.stars[ib].alt);
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        for (let k = 0; k < 3; k++) {
          expect(l.a[v * 3 + k]).toBeCloseTo(da[k], 6);
          expect(l.b[v * 3 + k]).toBeCloseTo(db[k], 6);
        }
      }
    }
  });

  // THE LAW THE WHOLE FEATURE HANGS ON. three r185 feeds a transmissive
  // fragment from a copy of the framebuffer taken after the OPAQUE pass and
  // before the transparent one, so a mark in the transparent list cannot be
  // seen through the thirteen glass elements the dive flies down. The split is
  // decided by ONE predicate, transcribed here from three r185
  // src/renderers/common/RenderList.js:312-322.
  it("(i) keeps every mark in the OPAQUE list, blended, and never occluding", () => {
    const field = createStarfield(false);
    const mats: THREE.Material[] = [];
    field.object.traverse((o) => {
      if (o instanceof THREE.Mesh) mats.push(o.material as THREE.Material);
    });
    expect(mats.length).toBe(2); // the discs and the strokes, one draw each
    for (const raw of mats) {
      const m = raw as THREE.Material & {
        transmission?: number;
        transmissionNode?: { isNode?: boolean } | null;
        backdropNode?: { isNode?: boolean } | null;
      };
      const goesTransparent =
        m.transparent === true ||
        (m.transmission ?? 0) > 0 ||
        m.transmissionNode?.isNode === true ||
        m.backdropNode?.isNode === true;
      expect(goesTransparent, "must land in the opaque list").toBe(false);
      // …and still blend, or the feathered rim would be a hard chip. Both
      // backends apply a blend state whenever blending !== NormalBlending,
      // whatever `transparent` says (WebGPUPipelineUtils.js:104).
      expect(m.blending).toBe(THREE.CustomBlending);
      expect(m.blendSrc).toBe(THREE.SrcAlphaFactor);
      expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
      // the alpha channel accumulates rather than mixing — a soft rim must not
      // punch a hole through the alpha canvas to the page
      expect(m.blendSrcAlpha).toBe(THREE.OneFactor);
      expect(m.blendDstAlpha).toBe(THREE.OneMinusSrcAlphaFactor);
      // NodeBuilder.isOpaque() (nodes/core/NodeBuilder.js:519-525) must come
      // back FALSE, or three assigns alpha = 1 and every disc is a square.
      const builderOpaque =
        m.transparent === false &&
        m.blending === THREE.NormalBlending &&
        m.alphaToCoverage === false;
      expect(builderOpaque, "alpha must reach the blend").toBe(false);
      // the farthest thing in the scene: occluded by everything, occluding none
      expect(m.depthWrite).toBe(false);
      expect(m.depthTest).toBe(true);
    }
    field.dispose();
  });
});
