// Temporary palette picker for styles/palettes-tryout.css. Shown with
// `?palette` or once a variant is stored; sets `data-palette` on <html>.
// Delete together with the stylesheet once a palette is chosen.

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

  const bar = document.createElement("div");
  bar.className = "palette-tryout";
  bar.style.cssText =
    "position:fixed;bottom:12px;left:12px;z-index:9999;display:flex;gap:4px;" +
    "padding:6px;border-radius:8px;background:var(--surface);border:1px solid var(--border);" +
    "font:11px/1 var(--font-mono);";
  const marks: (() => void)[] = [];
  for (const v of VARIANTS) {
    const b = document.createElement("button");
    b.textContent = v;
    b.style.cssText =
      "padding:4px 8px;border-radius:5px;border:1px solid var(--border);" +
      "background:var(--bg);color:var(--text);cursor:pointer;";
    b.type = "button";
    // selection is a box-shadow so the outline stays free for the focus ring
    const mark = () => {
      const on = (localStorage.getItem(KEY) ?? "current") === v;
      b.setAttribute("aria-pressed", String(on));
      b.style.boxShadow = on ? "0 0 0 2px var(--highlight)" : "none";
    };
    b.addEventListener("click", () => {
      localStorage.setItem(KEY, v);
      apply(v);
      for (const m of marks) m();
    });
    marks.push(mark);
    mark();
    bar.appendChild(b);
  }
  document.body.appendChild(bar);
}
