// PALETTE TRY-OUT picker — temporary exploration UI (2026-08-27), the runtime
// half of styles/palettes-tryout.css. Activated by `?palette` in the URL or a
// previously picked variant in localStorage; sets `data-palette` on <html> and
// persists it so the pick survives navigation. DELETE with the stylesheet once
// a direction is chosen.

const KEY = "palette-tryout";
const VARIANTS = ["current", "sharp", "ember", "field", "poster"] as const;

function apply(name: string): void {
  if (name === "current") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = name;
}

export function initPaletteTryout(): void {
  const stored = localStorage.getItem(KEY);
  const wanted = new URLSearchParams(location.search).has("palette");
  if (!stored && !wanted) return;
  if (stored) apply(stored);
  if (!wanted && stored === null) return;

  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;bottom:12px;left:12px;z-index:9999;display:flex;gap:4px;" +
    "padding:6px;border-radius:8px;background:var(--surface);border:1px solid var(--border);" +
    "font:11px/1 var(--font-mono);";
  for (const v of VARIANTS) {
    const b = document.createElement("button");
    b.textContent = v;
    b.style.cssText =
      "padding:4px 8px;border-radius:5px;border:1px solid var(--border);" +
      "background:var(--bg);color:var(--text);cursor:pointer;";
    const mark = () => {
      const on = (localStorage.getItem(KEY) ?? "current") === v;
      b.style.outline = on ? "2px solid var(--highlight)" : "none";
    };
    b.addEventListener("click", () => {
      localStorage.setItem(KEY, v);
      apply(v);
      for (const el of bar.querySelectorAll("button")) el.dispatchEvent(new Event("mark")); // prettier-ignore
    });
    b.addEventListener("mark", mark);
    mark();
    bar.appendChild(b);
  }
  document.body.appendChild(bar);
}
