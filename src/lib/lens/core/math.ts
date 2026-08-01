// Tiny math helpers shared by the lens modules (camera path, rig, cinematics,
// scene orchestration). Kept dependency-free so any module can import them.

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// one-sided fade band: rises in [a,a+f], holds, falls in [b-f,b]
export const band = (p: number, a: number, b: number, f = 0.04) =>
  Math.min(smoothstep(a, a + f, p), 1 - smoothstep(b - f, b, p));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const deg = (d: number) => (d * Math.PI) / 180; // degrees → radians
