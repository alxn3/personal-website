import type { Alpine } from "alpinejs";
import { isDesktop } from "./constants";

// @astrojs/alpinejs entrypoint (wired in astro.config.ts)

const PANELS_KEY = "project-panels";

// Theme flip with the ~350ms colour crossfade: `.theme-anim` enables the
// transition (global.css) and is removed once it completes.
let themeAnimT: number | undefined;
const flipTheme = (mutate: (root: HTMLElement) => void) => {
  const root = document.documentElement;
  root.classList.add("theme-anim");
  mutate(root);
  clearTimeout(themeAnimT);
  themeAnimT = window.setTimeout(
    () => root.classList.remove("theme-anim"),
    400,
  );
};

export default (Alpine: Alpine) => {
  // $isDesktop() — templates share the same breakpoint constant as this module
  Alpine.magic("isDesktop", () => isDesktop);

  Alpine.store("theme", {
    toggle() {
      flipTheme((root) => {
        const dark = root.classList.toggle("dark");
        localStorage.setItem("theme", dark ? "dark" : "light");
      });
    },
  });

  // An OS theme change always wins: apply it and drop the manual override so a
  // reload stays consistent. (The INITIAL class is set pre-paint by HtmlShell's
  // inline bootstrap; only this listener lives here.)
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      flipTheme((root) => {
        localStorage.removeItem("theme");
        root.classList.toggle("dark", e.matches);
      });
    });

  // Project-page sidebars: `projects` (the rail) and `description` (the
  // panel). Desktop-only persistence — mobile drawers always start closed.
  // MUST stay in sync with the pre-paint applier in pages/projects/[...slug].
  Alpine.data("projectPanels", () => {
    const desktop = isDesktop();
    let stored: { projects?: boolean; description?: boolean } | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    } catch {
      // corrupt state falls through to defaults
    }
    return {
      projects: desktop ? (stored?.projects ?? true) : false,
      description: desktop ? (stored?.description ?? true) : false,
      init() {
        this.$watch("projects", () => this.persist());
        this.$watch("description", () => this.persist());
      },
      persist() {
        if (isDesktop()) {
          localStorage.setItem(
            PANELS_KEY,
            JSON.stringify({
              projects: this.projects,
              description: this.description,
            }),
          );
        }
      },
    };
  });
};
