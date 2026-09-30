// Small dependency-free math helpers.

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Default width of band()'s rise and fall ramps. */
export const BAND_FEATHER = 0.04;

/** 0→1 over [a, a+f], holds 1, then 1→0 over [b-f, b]. */
export const band = (p: number, a: number, b: number, f = BAND_FEATHER) =>
  Math.min(smoothstep(a, a + f, p), 1 - smoothstep(b - f, b, p));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const deg = (d: number) => (d * Math.PI) / 180; // degrees → radians

/** Seeded 32-bit LCG returning values in [0, 1). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
