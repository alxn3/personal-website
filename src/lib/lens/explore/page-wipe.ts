// Page-level HARD wipe backdrop for the /lens demo compositions. Owner's note:
// the reveal is a PAGE element BEHIND the transparent WebGPU canvas, with a HARD
// line (no feather). The DOM lives in lens.astro; this drives it. Two stacked full-viewport layers:
// `below` paints the whole viewport, `above` is clipped to the region above the
// tilted line, so the line reads as a hard boundary between the two colors.

export interface PageWipeCfg {
  /** 0..1 line height: 0 = line at the bottom (the `above` color fills the
   *  viewport), 1 = line at the top (the `below` color fills it). */
  p: number;
  /** line tilt in degrees (+ dips the right side of the line). */
  skewDeg: number;
  /** color below the line (the seated side). */
  below: string;
  /** color above the line. */
  above: string;
}

let root: HTMLElement | null = null;
let belowEl: HTMLElement | null = null;
let aboveEl: HTMLElement | null = null;

function resolve(): boolean {
  root ??= document.getElementById("page-wipe");
  belowEl ??= document.getElementById("page-wipe-below");
  aboveEl ??= document.getElementById("page-wipe-above");
  return Boolean(root && belowEl && aboveEl);
}

/** Drive the page wipe from a config, or null to hide it and restore the normal
 *  page background. Recomputes the clip polygon from the live viewport size, so
 *  callers re-invoke per frame (the demo eases p itself). */
export function setPageWipe(cfg: PageWipeCfg | null): void {
  if (!resolve() || !root || !belowEl || !aboveEl) return;
  if (!cfg) {
    root.classList.add("hidden");
    return;
  }
  root.classList.remove("hidden");
  belowEl.style.background = cfg.below;
  aboveEl.style.background = cfg.above;

  // The line pivots about the viewport CENTRE; skewDeg is a true visual angle,
  // so convert its slope (px/px) into a %-of-height rise across the x range.
  // The x range is extended past 0..100% so the tilt never leaks a corner.
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  const slope = Math.tan((cfg.skewDeg * Math.PI) / 180);
  const yc = (1 - cfg.p) * 100; // line centre, % of height (bottom→top as p→1)
  const XL = -50;
  const XR = 150;
  const dy = (xPct: number) => ((slope * (((xPct - 50) / 100) * w)) / h) * 100;
  const yL = yc + dy(XL);
  const yR = yc + dy(XR);
  aboveEl.style.clipPath = `polygon(${XL}% 0%, ${XR}% 0%, ${XR}% ${yR}%, ${XL}% ${yL}%)`;
}
