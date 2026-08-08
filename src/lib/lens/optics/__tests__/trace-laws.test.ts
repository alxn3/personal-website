import { describe, expect, it } from "vitest";
import { NUM } from "../../ops/algebra";
import {
  traceLens,
  AXIAL_ORDER,
  AXIAL_ORDER_REVERSED,
  type Vec3,
} from "../trace";
import { OPTICS_KNOBS, PRESCRIPTION } from "../prescription";

// THE LAWS. Each states ONE property the trace must satisfy for every ray in a
// probe grid — the properties a refactor of the intersect/refract internals is
// allowed to be checked against. The GOLDENS (trace-goldens.test.ts) are the
// separate safety net that a rewrite cannot satisfy by luck.
//
// Rays start OUTSIDE the glass for the golden/law grids (spec §3 defers the
// camera-inside-glass case), except law (f), which is the ONE law that exists
// because the fly-through camera IS inside the barrel.

const D = 0.015; // the dispersion default
const ORIGIN_Y = 120; // well in front of the front vertex (73mm)
const XS = [0, 1.5, 3, -6, 9, 12, 15, 20];
const TILTS = [0, 0.05, -0.2, 0.6, -0.9];

const unit = (dx: number): Vec3<number> => ({
  x: dx,
  y: -Math.sqrt(Math.max(0, 1 - dx * dx)),
  z: 0,
});
const at = (x: number): Vec3<number> => ({ x, y: ORIGIN_Y, z: 0 });

// --- the REVERSED direction of travel (laws (l)…(p)) -------------------------
// The fly-through dives sensor-to-sky, so its rays run rear→front: +Y in the
// gltf frame, from origins BELOW the rear vertex. Same probe idioms as above,
// mirrored: `unitUp` is `unit` with the y sign flipped, `below` is `at` with an
// origin the same margin behind the rear vertex that ORIGIN_Y sits ahead of the
// front one.
const REAR_Y = PRESCRIPTION[PRESCRIPTION.length - 1].rear.yMm;
const ORIGIN_Y_UP = REAR_Y - 47; // ≈ the 47mm ORIGIN_Y clears the front vertex by
const unitUp = (dx: number): Vec3<number> => ({
  x: dx,
  y: Math.sqrt(Math.max(0, 1 - dx * dx)),
  z: 0,
});
const below = (x: number): Vec3<number> => ({ x, y: ORIGIN_Y_UP, z: 0 });
const REV = AXIAL_ORDER_REVERSED;
const finite = (r: { dir: Vec3<number>; alive: number }) =>
  Number.isFinite(r.dir.x) &&
  Number.isFinite(r.dir.y) &&
  Number.isFinite(r.dir.z) &&
  Number.isFinite(r.alive);

/** The cemented interfaces, DERIVED the same way trace.ts derives them: a pair
 *  of consecutive elements whose rear/front vertices were clamped coincident. */
const cementedPairs = (): number[] => {
  const out: number[] = [];
  for (let k = 0; k + 1 < PRESCRIPTION.length; k++)
    if (PRESCRIPTION[k].rear.yMm === PRESCRIPTION[k + 1].front.yMm) out.push(k);
  return out;
};

describe("trace laws", () => {
  it("(a) warpGain = 0 returns the input direction", () => {
    for (const x of XS)
      for (const dx of TILTS) {
        const d = unit(dx);
        const out = traceLens(NUM, at(x), d, 0, 0, 0, {
          warpGain: 0,
          focusCouple: 1,
        });
        // `mix(a, b, 0)` is `a` exactly and the trailing normalize divides a
        // unit vector by exactly 1, so this reproduces the input to the last
        // ulp. Asserted at 15 places rather than with `toBe`, because the
        // idempotent re-normalize is only PROVABLY exact where the squared
        // length is exactly 1 — and because ±0 would trip an identity compare.
        expect(out.dir.x).toBeCloseTo(d.x, 15);
        expect(out.dir.y).toBeCloseTo(d.y, 15);
        expect(out.dir.z).toBeCloseTo(d.z, 15);
      }
  });

  it("(b) focusCouple = 0 makes the focus channel a no-op", () => {
    for (const x of XS)
      for (const dx of TILTS) {
        const k = { warpGain: 1, focusCouple: 0 };
        const lo = traceLens(NUM, at(x), unit(dx), 0, 0, 0.3, k);
        const hi = traceLens(NUM, at(x), unit(dx), 0, 1, 0.3, k);
        expect(hi.dir).toEqual(lo.dir);
        expect(hi.alive).toBe(lo.alive);
      }
  });

  it("(c) alive is monotone non-increasing in the aperture channel", () => {
    for (const x of XS)
      for (const dx of TILTS) {
        let prev = 2;
        for (const a of [0, 0.25, 0.5, 0.75, 1]) {
          const v = traceLens(NUM, at(x), unit(dx), 0, 0, a).alive;
          expect(v, `x=${x} dx=${dx} a=${a}`).toBeLessThanOrEqual(prev);
          expect(v === 0 || v === 1).toBe(true);
          prev = v;
        }
      }
  });

  it("(d) never produces a NaN, grazing rays included", () => {
    let n = 0;
    for (let x = -24; x <= 24; x += 1.3)
      for (let dx = -0.999; dx <= 0.999; dx += 0.111)
        for (const f of [0, 0.5, 1])
          for (const a of [0, 0.3, 1])
            for (const s of [-D, 0, D]) {
              const r = traceLens(NUM, at(x), unit(dx), s, f, a);
              expect(finite(r), `x=${x} dx=${dx} f=${f} a=${a} s=${s}`).toBe(
                true,
              );
              n++;
            }
    expect(n).toBeGreaterThan(5000);
  });

  it("(e) is dispersion-symmetric for small offsets", () => {
    // The property is that R and B sit SYMMETRICALLY about G — no first-order
    // asymmetry in the ior offset. The central difference still carries the
    // honest SECOND-order term ½·f''·d², and against the measured table
    // f'' ≈ 4.9 at x = 3 (verified stable at d = 1e-4, 1e-5 and 1e-6, i.e. the
    // residual is exactly quadratic, so it is curvature and not asymmetry).
    // d = 1e-5 puts that term at ~2.5e-10, and the tolerance tightens to 1e-9
    // to keep 4× margin over it rather than banking the whole decade — the
    // sensitivity the smaller probe would otherwise have given away. (The
    // brief's d = 1e-4 put the same term at 2.5e-8, over even the old 1e-8
    // bound: a placeholder-table artefact, not a trace defect.)
    const d = 1e-5;
    for (const x of XS) {
      const g = traceLens(NUM, at(x), unit(0), 0, 0, 0);
      if (g.alive !== 1) continue;
      const r = traceLens(NUM, at(x), unit(0), -d, 0, 0);
      const b = traceLens(NUM, at(x), unit(0), d, 0, 0);
      for (const k of ["x", "y", "z"] as const)
        expect(Math.abs((r.dir[k] + b.dir[k]) / 2 - g.dir[k])).toBeLessThan(
          1e-9,
        );
    }
  });

  it("(f) keeps rays alive from an origin INSIDE the barrel", () => {
    // The fly-through parks the camera between elements (spec §5). Surfaces
    // BEHIND the origin must be skipped, not kill the ray — an interior origin
    // that reads `alive = 0` blacks out the whole sky mid-dive.
    //
    // The origins are DERIVED from the prescription (plan amendment 8), not
    // hardcoded: the midpoint of every real air gap wide enough to park a
    // camera in, plus one ahead of the front vertex and one behind the rear.
    // A re-measured table moves them with the glass instead of stranding one
    // inside an element.
    const GAP_MIN = 0.5;
    // `inside` = the origin sits inside the barrel, so some of the stack is
    // behind it and must be skipped rather than kill it. Those are the ones
    // this law is about. `traced` = glass still lies AHEAD of it, so the ray
    // must come back bent; the rear bracket has the whole stack behind it and
    // correctly leaves untouched.
    const origins: {
      y: number;
      where: string;
      inside: boolean;
      traced: boolean;
    }[] = [
      {
        y: PRESCRIPTION[0].front.yMm + 10,
        where: "10mm ahead of the front vertex",
        inside: false,
        traced: false,
      },
    ];
    for (let k = 0; k + 1 < PRESCRIPTION.length; k++) {
      const rear = PRESCRIPTION[k].rear.yMm;
      const front = PRESCRIPTION[k + 1].front.yMm;
      if (rear - front <= GAP_MIN) continue;
      origins.push({
        y: (rear + front) / 2,
        where: `gap ${PRESCRIPTION[k].id}→${PRESCRIPTION[k + 1].id}`,
        inside: true,
        traced: true,
      });
    }
    origins.push({
      y: PRESCRIPTION[PRESCRIPTION.length - 1].rear.yMm - 5,
      where: "5mm behind the rear vertex",
      inside: true,
      traced: false,
    });
    // Hardcoded on purpose: a tripwire on the DERIVATION above. If a re-measure
    // opens or closes a gap past the 0.5mm floor this count moves, and the new
    // origin set should be looked at rather than silently traced.
    expect(origins.filter((o) => o.inside).length, "interior origins").toBe(9);

    for (const { y, where, inside, traced } of origins) {
      const r = traceLens(NUM, { x: 0.4, y, z: 0 }, unit(0.08), 0, 0, 0);
      expect(finite(r), `origin y=${y} (${where})`).toBe(true);
      // The one BRACKET origin ahead of the glass is not an interior case and
      // is not asserted alive: from 10mm out, a 0.08rad ray entering 0.4mm off
      // axis reaches the stop plane at r = 5.913mm against irisMaxMm = 5.800,
      // so the IRIS vignettes it — measured optics doing their job, nothing to
      // do with the behind-origin skip. It stays in the grid as a finiteness
      // probe. (If the owner ever wants that field angle to survive, the knob
      // is IRIS.irisMaxMm, which plan amendment 7 capped at the neighbouring
      // glass — so it is the glass, not the door, that would have to move.)
      if (inside) expect(r.alive, `origin y=${y} (${where})`).toBe(1);
      // Alive because it was TRACED, not because it bypassed: a ray granted
      // the miss-the-lens bypass (law (k)) comes back with its input direction
      // untouched, which would satisfy `alive === 1` for the wrong reason and
      // hide a dead interior origin.
      if (traced)
        expect(r.dir, `origin y=${y} (${where}) was traced`).not.toEqual(
          unit(0.08),
        );
    }
  });

  it("(g) converges an off-axis parallel ray toward the axis", () => {
    // The lensmaker sign, and the emergent field flip the spec asks a law to
    // notice: a ray entering parallel to the axis at +x leaves with a NEGATIVE
    // x component (it is bent toward the axis and crosses it).
    const r = traceLens(NUM, at(3), unit(0), 0, 0, 0);
    expect(r.alive).toBe(1);
    expect(r.dir.x).toBeLessThan(0);
    const r2 = traceLens(NUM, at(-3), unit(0), 0, 0, 0);
    expect(r2.dir.x).toBeGreaterThan(0);
  });

  it("(h) an on-axis ray stays on-axis", () => {
    const r = traceLens(NUM, at(0), unit(0), 0, 0, 0);
    expect(r.alive).toBe(1);
    expect(r.dir.x).toBeCloseTo(0, 15);
    expect(r.dir.y).toBeCloseTo(-1, 15);
    expect(r.dir.z).toBeCloseTo(0, 15);
  });

  it("(i) ships knob defaults matching the knob table", () => {
    // NOT evidence that traceLens imports OPTICS_KNOBS — its defaults are
    // LITERALS in the signature (`{ warpGain: 1, focusCouple: 1 }`), because a
    // default parameter cannot be a live uniform and the TSL backend binds
    // these to uniforms instead. This is the TRIPWIRE that catches the two
    // drifting apart: retune OPTICS_KNOBS.warpGain or .focusCouple and it
    // fails, which is the prompt to pass the knobs explicitly at the call site
    // (optics/warp.ts) rather than to edit the literals.
    const withDefaults = traceLens(NUM, at(3), unit(0), 0, 0, 0);
    const explicit = traceLens(NUM, at(3), unit(0), 0, 0, 0, {
      warpGain: OPTICS_KNOBS.warpGain,
      focusCouple: OPTICS_KNOBS.focusCouple,
    });
    expect(withDefaults.dir).toEqual(explicit.dir);
  });

  it("(j) omits both surfaces of every cemented pair, and only those", () => {
    // THE TRIPWIRE for plan amendment 8. AXIAL_ORDER drops a cemented pair's
    // two coincident surfaces because equal index on both sides makes the
    // interface optically NOTHING — the only reason that is sound is that the
    // two elements carry the SAME `ior`.
    //
    // IF THIS FAILS: an owner look-tune has given a cemented pair different
    // indices. The interface is then a real refraction and dropping it is a
    // physics error — re-add interface handling to trace.ts (a single surface
    // at the shared plane with eta = n_k / n_{k+1}) rather than relaxing this.
    const pairs = cementedPairs();
    expect(pairs.length, "cemented pairs derived from the table").toBe(3);
    for (const k of pairs)
      expect(
        PRESCRIPTION[k].ior,
        `${PRESCRIPTION[k].id}/${PRESCRIPTION[k + 1].id} cemented interface index`,
      ).toBe(PRESCRIPTION[k + 1].ior);

    // 13 elements × 2 surfaces − 2 per cemented pair + 1 iris stop.
    const expected = PRESCRIPTION.length * 2 - pairs.length * 2 + 1;
    expect(expected).toBe(21);
    expect(AXIAL_ORDER.length, "surfaces in the unrolled trace").toBe(21);
    expect(AXIAL_ORDER.filter((s) => s.stop === 1)).toHaveLength(1);

    // The omitted surfaces are exactly the cemented ones: no entry sits at a
    // cemented interface plane, and every other surface plane is present.
    const cementedY = new Set(pairs.map((k) => PRESCRIPTION[k].rear.yMm));
    for (const s of AXIAL_ORDER)
      if (!s.stop)
        expect(cementedY.has(s.yMm), `surface at y=${s.yMm} is cemented`).toBe(
          false,
        );
  });

  it("(k) passes a ray that misses the front element through UNWARPED", () => {
    // Plan amendment 9 — the law the amendment calls (j); (j) was already the
    // cemented tripwire here, so it lands as (k).
    //
    // A ray outside the FIRST surface's clear aperture never entered the glass.
    // It flies around the barrel and must see the sky untouched: killing it
    // blacks out the whole background AROUND the lens, not just the lens. So
    // this is the warpGain-identity law again, but earned by geometry instead
    // of by a knob — and it must hold at EVERY focus and aperture, because a
    // ray that missed the glass cannot care what the glass is doing.
    const OUTSIDE = 30; // vs Element_01's 18.21mm clear semi-diameter
    expect(OUTSIDE).toBeGreaterThan(PRESCRIPTION[0].front.apertureMm);
    // Tilts chosen to stay outside the front aperture all the way to the
    // vertex: 0 arrives at exactly 30 and positive tilts lean further out.
    // NEGATIVE tilts converge toward the axis and are deliberately excluded —
    // -0.2 lands at r = 18.87 against the 18.21mm aperture, a 3.6% margin that
    // a benign re-measure could erase, turning this law into a flake.
    for (const dx of [0, 0.05, 0.6])
      for (const f of [0, 1])
        for (const a of [0, 1]) {
          const d = unit(dx);
          const r = traceLens(NUM, at(OUTSIDE), d, 0, f, a);
          const at_ = `dx=${dx} focus=${f} aperture=${a}`;
          expect(r.alive, at_).toBe(1);
          // Exact to the last ulp, same idiom and same reason as law (a).
          expect(r.dir.x, at_).toBeCloseTo(d.x, 15);
          expect(r.dir.y, at_).toBeCloseTo(d.y, 15);
          expect(r.dir.z, at_).toBeCloseTo(d.z, 15);
        }

    // The bypass must NOT leak into rays that do enter the glass: an on-axis
    // ray is still traced (law (h) pins where it lands), and a ray the IRIS
    // stops down onto is still killed — that is vignetting inside the glass
    // path, which stays black.
    expect(traceLens(NUM, at(0), unit(0), 0, 0, 0).alive).toBe(1);
    expect(traceLens(NUM, at(3), unit(0), 0, 0, 1).alive).toBe(0);
  });

  // --- REVERSED TRAVEL (AXIAL_ORDER_REVERSED) -------------------------------
  // The fly-through runs sensor-to-sky, so the warp it mounts builds the SAME
  // trace against the reversed table. These re-state the laws that are about
  // the trace itself (identity, finiteness, on-axis, interior origins, bypass)
  // for that direction, since the reversed table is a second unroll and nothing
  // above exercises it. Note the reversed direction has NO goldens yet — the
  // forward 270 remain the only byte-level net.

  it("(l) warpGain = 0 returns the input direction, reversed", () => {
    for (const x of XS)
      for (const dx of TILTS) {
        const d = unitUp(dx);
        const out = traceLens(
          NUM,
          below(x),
          d,
          0,
          0,
          0,
          { warpGain: 0, focusCouple: 1 },
          REV,
        );
        // Exact for the same reason as law (a): the gain-0 mix returns the
        // input and the trailing normalize divides a unit vector by 1.
        expect(out.dir.x).toBeCloseTo(d.x, 15);
        expect(out.dir.y).toBeCloseTo(d.y, 15);
        expect(out.dir.z).toBeCloseTo(d.z, 15);
      }
  });

  it("(m) never produces a NaN travelling the other way", () => {
    // Law (d)'s grid, mirrored: origins below the rear vertex, rays pointing up.
    let n = 0;
    for (let x = -24; x <= 24; x += 1.3)
      for (let dx = -0.999; dx <= 0.999; dx += 0.111)
        for (const f of [0, 0.5, 1])
          for (const a of [0, 0.3, 1])
            for (const s of [-D, 0, D]) {
              const r = traceLens(
                NUM,
                below(x),
                unitUp(dx),
                s,
                f,
                a,
                undefined,
                REV,
              );
              expect(finite(r), `x=${x} dx=${dx} f=${f} a=${a} s=${s}`).toBe(
                true,
              );
              n++;
            }
    expect(n).toBeGreaterThan(5000);
  });

  it("(n) an on-axis ray stays on-axis, reversed", () => {
    const r = traceLens(NUM, below(0), unitUp(0), 0, 0, 0, undefined, REV);
    expect(r.alive).toBe(1);
    expect(r.dir.x).toBeCloseTo(0, 15);
    expect(r.dir.y).toBeCloseTo(1, 15);
    expect(r.dir.z).toBeCloseTo(0, 15);
  });

  it("(o) keeps rays alive from an origin INSIDE the barrel, reversed", () => {
    // Law (f) for the dive that actually flies this table. Same DERIVED origins
    // — the midpoint of every air gap wide enough to park a camera in — but the
    // camera is now looking the other way, so every surface behind it is a
    // surface the FORWARD table put in front of it. The behind-origin skip has
    // to work in both directions or the sky blacks out mid-dive.
    const GAP_MIN = 0.5;
    const gaps: { y: number; where: string }[] = [];
    for (let k = 0; k + 1 < PRESCRIPTION.length; k++) {
      const rear = PRESCRIPTION[k].rear.yMm;
      const front = PRESCRIPTION[k + 1].front.yMm;
      if (rear - front <= GAP_MIN) continue;
      gaps.push({
        y: (rear + front) / 2,
        where: `gap ${PRESCRIPTION[k].id}→${PRESCRIPTION[k + 1].id}`,
      });
    }
    // The same tripwire on the derivation law (f) carries: 8 parkable air gaps
    // (law (f)'s 9 interior origins are these plus its rear bracket).
    expect(gaps.length, "parkable air gaps").toBe(8);
    // Plus the bracket BEHIND the rear vertex, which is interior for an upward
    // ray in the way the 10mm-ahead-of-front bracket is for a downward one: the
    // whole stack is ahead of it, so it must come back traced and alive.
    const origins = [
      ...gaps.map((g) => ({ ...g, traced: true })),
      {
        y: PRESCRIPTION[PRESCRIPTION.length - 1].rear.yMm - 5,
        where: "5mm behind the rear vertex",
        traced: true,
      },
    ];
    for (const { y, where, traced } of origins) {
      const d = unitUp(0.08);
      const r = traceLens(NUM, { x: 0.4, y, z: 0 }, d, 0, 0, 0, undefined, REV);
      expect(finite(r), `origin y=${y} (${where})`).toBe(true);
      expect(r.alive, `origin y=${y} (${where})`).toBe(1);
      // Alive because it was TRACED, not because it took the bypass — the same
      // distinction law (f) draws.
      if (traced)
        expect(r.dir, `origin y=${y} (${where}) was traced`).not.toEqual(d);
    }
  });

  it("(p) passes a reversed ray that misses the glass through UNWARPED", () => {
    // Law (k) from the other end. The first surface a rising ray meets is the
    // REAR-most one, whose clear semi-diameter is far smaller than the front
    // element's — so 30mm off axis is comfortably around the barrel either way.
    const OUTSIDE = 30;
    expect(OUTSIDE).toBeGreaterThan(REV[0].apertureMm);
    for (const dx of [0, 0.05, 0.6])
      for (const f of [0, 1])
        for (const a of [0, 1]) {
          const d = unitUp(dx);
          const r = traceLens(NUM, below(OUTSIDE), d, 0, f, a, undefined, REV);
          const at_ = `dx=${dx} focus=${f} aperture=${a}`;
          expect(r.alive, at_).toBe(1);
          expect(r.dir.x, at_).toBeCloseTo(d.x, 15);
          expect(r.dir.y, at_).toBeCloseTo(d.y, 15);
          expect(r.dir.z, at_).toBeCloseTo(d.z, 15);
        }
  });
});
