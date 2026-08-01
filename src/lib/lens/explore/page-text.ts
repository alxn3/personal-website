// Page-level TEXT layers for the /lens demo compositions — the "type-sandwich"
// scaffold. Owner's note: text should live ALONGSIDE the scenes so the two read
// as one thing — e.g. huge display type BEHIND the lens with a caption in front,
// the whole sandwich crossed by the demos' hard wipe line.
//
// Two page-owned layers (DOM in lens.astro, driven here — same pattern as
// page-wipe.ts): `back` sits between the wipe and the transparent canvas (the
// lens occludes it, so the sandwich reads); `front` sits above the canvas, under
// the panel. Both hidden when their spec is absent. The static typographic look
// lives in lens.astro's scoped <style>; this module writes ONLY what a spec
// overrides plus the per-frame transform/opacity, so scrubbing stays cheap.

export interface TextSpec {
  /** main line; `\n` splits into two lines (the nodes use `white-space: pre-line`). */
  text: string;
  /** optional smaller second line under the main text. */
  sub?: string;
  /** explicit color — demos coordinate this with their wipe colors. */
  color?: string;
  /** rem-ish scale factor multiplying the clamp() default (1 = default). */
  size?: number;
  /** 0..1 viewport-fraction anchor (default centered back, lower-third front). */
  x?: number;
  y?: number;
  align?: "left" | "center" | "right";
  /** 0..1, for demos to fade per-scrub (default 1). */
  opacity?: number;
  /** letter-spacing in em — big display type often wants tightening. */
  tracking?: number;
}

export interface PageTextCfg {
  /** HUGE display type BEHIND the canvas (in front of the wipe). */
  back?: TextSpec;
  /** caption-scale type ABOVE the canvas. */
  front?: TextSpec;
}

// Sensible per-layer anchor defaults: back centered, front in the lower third.
const BACK_DEFAULTS = { x: 0.5, y: 0.5, align: "center" as const };
const FRONT_DEFAULTS = { x: 0.5, y: 0.72, align: "center" as const };

const TX = { left: "0", center: "-50%", right: "-100%" } as const;

// Per-layer cache so each apply writes only the props that actually changed
// (textContent only when the string changes; transform/opacity per frame).
interface LayerCache {
  text?: string;
  sub?: string;
  color?: string;
  scale?: string;
  tracking?: string;
  opacity?: string;
  transform?: string;
  left?: string;
  textAlign?: string;
}

interface Layer {
  root: HTMLElement;
  main: HTMLElement;
  sub: HTMLElement;
  anchor: HTMLElement;
  defaults: typeof BACK_DEFAULTS;
  cache: LayerCache;
}

let back: Layer | null = null;
let front: Layer | null = null;
let resolved = false;

function makeLayer(id: string, defaults: typeof BACK_DEFAULTS): Layer | null {
  const root = document.getElementById(id);
  const main = root?.querySelector<HTMLElement>(".ptx-main");
  const sub = root?.querySelector<HTMLElement>(".ptx-sub");
  const anchor = root?.querySelector<HTMLElement>(".ptx-anchor");
  if (!root || !main || !sub || !anchor) return null;
  return { root, main, sub, anchor, defaults, cache: {} };
}

function resolve(): boolean {
  if (resolved) return Boolean(back && front);
  back ??= makeLayer("page-text-back", BACK_DEFAULTS);
  front ??= makeLayer("page-text-front", FRONT_DEFAULTS);
  resolved = true;
  return Boolean(back && front);
}

// Write a prop only when its resolved value differs from the cached one. `''`
// clears the inline override so the element falls back to the CSS default.
function set(
  cache: LayerCache,
  key: keyof LayerCache,
  value: string,
  write: (v: string) => void,
): void {
  if (cache[key] === value) return;
  cache[key] = value;
  write(value);
}

function applyLayer(layer: Layer, spec: TextSpec | undefined): void {
  const { root, main, sub, anchor, defaults, cache } = layer;
  if (!spec) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");

  set(cache, "text", spec.text, (v) => (main.textContent = v));
  set(cache, "sub", spec.sub ?? "", (v) => {
    sub.textContent = v;
    sub.classList.toggle("hidden", v === "");
  });
  set(cache, "color", spec.color ?? "", (v) => (root.style.color = v));
  set(cache, "scale", spec.size == null ? "" : String(spec.size), (v) =>
    root.style.setProperty("--ptx-scale", v),
  );
  set(
    cache,
    "tracking",
    spec.tracking == null ? "" : `${spec.tracking}em`,
    (v) => (root.style.letterSpacing = v),
  );
  set(
    cache,
    "opacity",
    String(spec.opacity ?? 1),
    (v) => (root.style.opacity = v),
  );

  const align = spec.align ?? defaults.align;
  set(cache, "textAlign", align, (v) => (anchor.style.textAlign = v));

  const x = spec.x ?? defaults.x;
  set(cache, "left", `${x * 100}%`, (v) => (anchor.style.left = v));

  // Per-frame motion rides the transform (compositor-friendly): the anchor's
  // top stays 0 and the y fraction lives in a vh translate, so demos driving y
  // never trigger layout.
  const y = spec.y ?? defaults.y;
  const transform = `translate(${TX[align]}, calc(${y * 100}vh - 50%))`;
  set(cache, "transform", transform, (v) => (anchor.style.transform = v));
}

/** Drive the page text layers from a config, or null to hide both. Cheap to
 *  call per frame — only changed style props are written. */
export function setPageText(cfg: PageTextCfg | null): void {
  if (!resolve() || !back || !front) return;
  applyLayer(back, cfg?.back);
  applyLayer(front, cfg?.front);
}
