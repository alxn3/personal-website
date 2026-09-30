import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { REVEAL_END, SKY_OUT_END, atFrac, rangeOf } from "../story";
import { SKY, dirOf } from "../../optics/sky";
import { SKY_SPIN_AXIS, rodrigues, starRho } from "../../optics/starfield";
import {
  TRAIL_LOOK,
  TRAIL_SWEEP_MAX,
  TRAIL_TAIL_FRACTION,
  buildTrailArcs,
  createStarTrails,
  trailDirAt,
} from "../../optics/star-trails";
import {
  AMBIENT_DECAY,
  AMBIENT_MAX,
  AMBIENT_SPIN_RATE,
  ENV_END,
  SPAN_P0,
  SPAN_P1,
  trailEnvAt,
  trailSweepAt,
} from "../trails";
import { flyRevealAt, skyOutAt } from "../fly";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

type V3 = [number, number, number];
const unit = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleTo = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const X: V3 = [1, 0, 0];

describe("the sky's spin", () => {
  it("the pole is a unit direction ON the view axis", () => {
    // a pole off the view axis would draw the trails as ellipses; the held fly
    // pose looks down world +X, so the axis IS the pole
    expect(unit(SKY_SPIN_AXIS)).toBeCloseTo(1, 12);
    expect(angleTo(SKY_SPIN_AXIS, X)).toBeCloseTo(0, 6);
    // exactly zero; `Math.abs` because −0 fails `toBe(0)`
    expect(Math.abs(SKY_SPIN_AXIS[1])).toBe(0);
    expect(Math.abs(SKY_SPIN_AXIS[2])).toBe(0);
  });

  it("keeps every star at a FIXED angle off the view axis — the circle law", () => {
    // so each trail projects to a circle centred on the frame
    for (const [az, alt] of [
      [0.3, 0.2],
      [-1.1, -0.5],
      [2.6, 0.9],
    ]) {
      const d = dirOf(az, alt);
      for (const th of [0.4, 1.6, TRAIL_SWEEP_MAX])
        expect(angleTo(rodrigues(d, SKY_SPIN_AXIS, th), X)).toBeCloseTo(angleTo(d, X), 10); // prettier-ignore
    }
  });

  it("is a real rotation: bit-exact at 0, the known quarter turn, length preserved", () => {
    // exact at angle 0, since cos 0 = 1 and sin 0 = 0
    for (const d of [X, [0, 1, 0], [0.3, -0.5, 0.81]] as V3[])
      expect(rodrigues(d, SKY_SPIN_AXIS, 0)).toEqual(d);
    const q = rodrigues(X, [0, 0, 1], Math.PI / 2);
    [0, 1, 0].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
    // about its own axis nothing moves (loose: acos is imprecise near 1)
    const onAxis = rodrigues([...SKY_SPIN_AXIS], SKY_SPIN_AXIS, 1.1);
    expect(angleTo(onAxis, SKY_SPIN_AXIS)).toBeCloseTo(0, 6);
    // every angle keeps the vector's length
    const v: V3 = [0.3, -0.5, 0.81];
    for (const ang of [0.1, 0.55, 2.0, -0.7])
      expect(unit(rodrigues(v, SKY_SPIN_AXIS, ang))).toBeCloseTo(unit(v), 12);
  });
});

describe("the trail arc law", () => {
  const d = dirOf(0.2, -0.1);

  it("runs from the star (s = 0, bit-exact) back to where the turn started (s = 1)", () => {
    for (const theta of [0, 0.2, TRAIL_SWEEP_MAX])
      // bit-exact, so the arc's head sits exactly on the star's disc
      expect(trailDirAt(d, theta, theta, 0)).toEqual(
        rodrigues(d, SKY_SPIN_AXIS, theta),
      );
    expect(TRAIL_TAIL_FRACTION).toBe(1);
    for (const theta of [0.1, 0.3, TRAIL_SWEEP_MAX]) {
      const tail = trailDirAt(d, theta, theta, 1);
      d.forEach((v, i) => expect(tail[i]).toBeCloseTo(v, 12));
    }
  });

  it("sweeps monotonically backward along the arc", () => {
    const theta = TRAIL_SWEEP_MAX;
    const head = trailDirAt(d, theta, theta, 0);
    let prev = 0;
    for (let i = 1; i <= TRAIL_LOOK.segments; i++) {
      const a = angleTo(trailDirAt(d, theta, theta, i / TRAIL_LOOK.segments), head); // prettier-ignore
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it("draws nothing anywhere when the sky has not turned", () => {
    for (const s of [0, 0.5, 1]) expect(trailDirAt(d, 0, 0, s)).toEqual(d);
  });
});

describe("the arcs", () => {
  const arcs = buildTrailArcs(SKY.stars);

  it("gives EVERY star an arc, in catalog order, all unit directions", () => {
    expect(arcs.length).toBe(SKY.stars.length);
    for (const [i, a] of arcs.entries()) {
      const s = SKY.stars[i];
      expect(unit(a.dir)).toBeCloseTo(1, 10);
      expect(a.dir, `arc ${i} is star ${i}`).toEqual(dirOf(s.az, s.alt));
      expect(a.tint, `arc ${i} tint`).toBe(s.tint);
    }
  });

  it("carries its own star's ink, and is never sub-pixel thin", () => {
    for (const [i, a] of arcs.entries()) {
      expect(a.half, `arc ${i} half`).toBeGreaterThanOrEqual(TRAIL_LOOK.minHalfRad); // prettier-ignore
      expect(a.ink, `arc ${i} ink`).toBeGreaterThan(0);
      // never brighter than its star
      expect(a.ink, `arc ${i} ink`).toBeLessThanOrEqual(SKY.stars[i].ink ?? 1);
    }
    // a bright star: width from its disc radius, full ink
    const bright = arcs[3]; // the catalog's brightest, mag 3.1
    expect(SKY.stars[3].mag).toBe(3.1);
    expect(bright.half).toBeCloseTo(TRAIL_LOOK.widthK * starRho(3.1), 12);
    expect(bright.ink).toBe(1);
    // the faintest star: faint ink, from its star
    const faintStar = SKY.stars.reduce((a, b) => (b.mag < a.mag ? b : a));
    const faintInk = faintStar.ink ?? 1;
    expect(faintInk).toBeLessThan(0.4);
    const dim = buildTrailArcs([faintStar])[0];
    expect(dim.ink).toBeLessThan(faintInk);
    // an arc widened to the floor is dimmed to compensate
    expect(dim.half).toBe(TRAIL_LOOK.minHalfRad);
    expect(dim.half * (dim.ink / faintInk)).toBeCloseTo(
      TRAIL_LOOK.widthK * starRho(faintStar.mag),
      12,
    );
    expect(dim.half * dim.ink).toBeLessThan(TRAIL_LOOK.minHalfRad);
    // a few bright arcs over many faint ones
    const at = (t: number) => arcs.filter((a) => a.ink >= t).length;
    expect(at(0.9)).toBeLessThan(arcs.length * 0.04);
    expect(at(0.6)).toBeLessThan(arcs.length * 0.1);
    expect(at(0.6)).toBeGreaterThan(at(0.9) * 2);
    expect(at(0.3)).toBeGreaterThan(at(0.6) * 4);
  });
});

describe("the arcs' geometry", () => {
  // One template ribbon of `segments` quads, instanced once per star.
  const mesh = createStarTrails({ light: false }).object as THREE.Mesh;
  const geo = mesh.geometry as THREE.InstancedBufferGeometry;
  const RUNGS = TRAIL_LOOK.segments + 1;
  const n = SKY.stars.length;
  const attr = (name: string) =>
    geo.getAttribute(name) as THREE.BufferAttribute;

  it("draws one instance of a template that carries the arc's PARAMETERS and nothing else", () => {
    expect(geo.isInstancedBufferGeometry).toBe(true);
    expect(geo.instanceCount).toBe(n);
    expect(geo.getIndex()!.count).toBe(TRAIL_LOOK.segments * 6);
    const pos = attr("position");
    expect(pos.count).toBe(RUNGS * 2);
    expect(pos instanceof THREE.InstancedBufferAttribute).toBe(false);
    for (let r = 0; r < RUNGS; r++)
      for (const k of [0, 1]) {
        expect(pos.getX(r * 2 + k), `rung ${r} side`).toBe(k === 0 ? -1 : 1);
        expect(pos.getY(r * 2 + k), `rung ${r} s`).toBe(Math.fround(r / TRAIL_LOOK.segments)); // prettier-ignore
      }
  });

  it("everything per-STAR is an instance attribute, in catalog order", () => {
    const arcs = buildTrailArcs(SKY.stars);
    for (const name of ["aDir", "aHalf", "aInk", "aTint"]) {
      expect(attr(name) instanceof THREE.InstancedBufferAttribute, name).toBe(true); // prettier-ignore
      expect(attr(name).count, name).toBe(n);
    }
    const aDir = attr("aDir");
    for (const i of [0, 3, 17, n - 1]) {
      const a = arcs[i];
      expect([aDir.getX(i), aDir.getY(i), aDir.getZ(i)]).toEqual(a.dir.map(Math.fround)); // prettier-ignore
      expect(attr("aHalf").getX(i)).toBe(Math.fround(a.half));
      expect(attr("aInk").getX(i)).toBe(Math.fround(a.ink));
      expect(attr("aTint").getX(i)).toBe(Math.fround(a.tint[0]));
    }
  });

  it("states its own bounding sphere — the whole sky — and fits in tens of KB", () => {
    // set explicitly, since `position` holds parameters, not places
    expect(geo.boundingSphere!.radius).toBe(TRAIL_LOOK.radius);
    expect(geo.boundingSphere!.center.length()).toBe(0);
    expect(mesh.frustumCulled).toBe(false);
    let bytes = geo.getIndex()!.array.byteLength;
    for (const a of Object.values(geo.attributes))
      bytes += (a as THREE.BufferAttribute).array.byteLength;
    expect(bytes).toBeLessThan(64 * 1024);
    // under a hundredth of a pre-expanded per-star buffer
    expect(bytes).toBeLessThan(n * RUNGS * 2 * 44 * 0.01);
  });
});

describe("the trails driver's laws", () => {
  it("the sweep holds at zero until local 0.25, then runs monotonely to the max at SKY_OUT_END", () => {
    // around half a revolution
    expect(TRAIL_SWEEP_MAX).toBeGreaterThan(2.6);
    expect(TRAIL_SWEEP_MAX).toBeLessThan(3.7);
    // the constellation lines fade over trails-local [0, 0.25] on unrotated
    // directions, so the sky may not turn until they are gone
    for (const p of [
      tR.p0 - 0.05,
      rangeOf("constellations").p1,
      ...[0, 0.05, 0.1, 0.2, 0.22, 0.25].map((f) => atFrac(tR, f)),
    ])
      // prettier-ignore
      expect(trailSweepAt(p), `p ${p}`).toBe(0);
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      const v = trailSweepAt(atFrac(tR, i / 40));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(trailSweepAt(atFrac(tR, 0.5))).toBeGreaterThan(0);
    // the turn only completes at SKY_OUT_END, past the reveal's end
    expect(trailSweepAt(atFrac(tR, 0.9))).toBeLessThan(TRAIL_SWEEP_MAX * 0.75);
    expect(trailSweepAt(tR.p1)).toBeLessThan(TRAIL_SWEEP_MAX * 0.85);
    expect(trailSweepAt(REVEAL_END)).toBeLessThan(TRAIL_SWEEP_MAX);
    expect(trailSweepAt(SKY_OUT_END)).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
    expect(trailSweepAt(atFrac(rwR, 0.5))).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
  });

  it("the sky is STILL TURNING when the last arc goes out", () => {
    expect(trailEnvAt(ENV_END)).toBe(0);
    const rate = (p: number) =>
      (trailSweepAt(p + 1e-5) - trailSweepAt(p)) / 1e-5;
    // near its mid-scene rate as the arcs vanish
    expect(rate(ENV_END)).toBeGreaterThan(0.8 * rate(atFrac(tR, 0.6)));
    // and still turning for every frame an arc is drawn
    expect(ENV_END).toBeLessThan(SKY_OUT_END);
  });

  // The arcs stay on screen well into the lens's reveal.
  it("keeps BOTH figures on screen across a long shared stretch", () => {
    // when the shell is fully drawn, the arcs are still at a third or more…
    const top = atFrac(rwR, 0.16);
    expect(flyRevealAt(top)).toBe(1);
    expect(trailEnvAt(top)).toBeGreaterThan(1 / 3);
    // …and still visible a little later
    expect(trailEnvAt(atFrac(rwR, 0.2))).toBeGreaterThan(0.15);
    // the sky outlives the collapse
    expect(skyOutAt(REVEAL_END)).toBeGreaterThan(0);
  });

  it("the envelope rises inside trails and dies into the reveal", () => {
    // 0 everywhere before the chapter, including the whole dive
    for (const p of [
      rangeOf("flythrough").p0,
      atFrac(rangeOf("constellations"), 0.5),
      tR.p0,
      atFrac(tR, 0.02),
    ])
      // prettier-ignore
      expect(trailEnvAt(p), `p ${p}`).toBe(0);
    // full from early trails through the top of rewrap
    for (const p of [
      atFrac(tR, 0.12),
      atFrac(tR, 0.9),
      rwR.p0,
      atFrac(rwR, 0.02),
    ])
      // prettier-ignore
      expect(trailEnvAt(p), `p ${p}`).toBeCloseTo(1, 12);
    // still alive over the reveal…
    expect(trailEnvAt(atFrac(rwR, 0.18))).toBeGreaterThan(0);
    // …and gone before the star discs finish fading
    expect(skyOutAt(ENV_END)).toBeGreaterThan(0);
    for (const p of [atFrac(rwR, 0.5), rangeOf("capsOn").p0])
      expect(trailEnvAt(p), `p ${p}`).toBe(0);
  });

  it("the drift is small, capped, and given back in a few seconds", () => {
    // ten seconds parked adds well under a fifth of the turn
    expect(AMBIENT_SPIN_RATE * 10).toBeLessThan(TRAIL_SWEEP_MAX * 0.25);
    expect(AMBIENT_DECAY).toBeGreaterThan(AMBIENT_SPIN_RATE);
    // 0.25 rad is about 14°
    expect(AMBIENT_MAX).toBeGreaterThan(0);
    expect(AMBIENT_MAX).toBeLessThan(0.25);
    // unwinds from the cap in under 5 s
    expect(AMBIENT_MAX / AMBIENT_DECAY).toBeLessThan(5);
  });
});

describe("the arcs' attach window", () => {
  // exported for story/cost.ts
  it("pads the driven span at both ends", () => {
    expect(SPAN_P0).toBeLessThan(tR.p0);
    expect(SPAN_P1).toBeGreaterThan(ENV_END);
    // the same pad on each edge, with the envelope 0 at both
    expect(tR.p0 - SPAN_P0).toBeCloseTo(SPAN_P1 - ENV_END, 12);
    expect(trailEnvAt(SPAN_P0)).toBe(0);
    expect(trailEnvAt(SPAN_P1)).toBe(0);
  });
});
