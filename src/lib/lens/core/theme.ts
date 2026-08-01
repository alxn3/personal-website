// Shared site-theme watcher for the lens pages. The theme is the `dark` class
// on <html> (set pre-paint by HtmlShell, toggled by the navbar / OS listener);
// the 3D scene follows it via SceneHandle.setTheme(light).

export const isLightTheme = () =>
  !document.documentElement.classList.contains("dark");

/**
 * Watch the `<html>` class for theme flips and call `cb(light)` on each ACTUAL
 * flip (the MutationObserver fires on any class change, so the last value is
 * tracked and unchanged themes are ignored). Does not call `cb` for the
 * initial theme — the scene self-detects that at creation.
 */
export function watchTheme(cb: (light: boolean) => void): void {
  let light = isLightTheme();
  new MutationObserver(() => {
    const l = isLightTheme();
    if (l === light) return;
    light = l;
    cb(l);
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
