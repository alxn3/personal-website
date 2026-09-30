import type { Alpine } from "alpinejs";
import { isDesktop } from "./constants";
import { initPaletteTryout } from "./palette-tryout";

// @astrojs/alpinejs entrypoint (wired in astro.config.ts)

const PANELS_KEY = "project-panels";

// Theme flip with a colour crossfade: `.theme-anim` (global.css) is on only
// until the transition ends.
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
  initPaletteTryout();
  // $isDesktop() for templates, same breakpoint as the JS
  Alpine.magic("isDesktop", () => isDesktop);

  Alpine.store("theme", {
    toggle() {
      flipTheme((root) => {
        const dark = root.classList.toggle("dark");
        localStorage.setItem("theme", dark ? "dark" : "light");
      });
    },
  });

  // An OS theme change wins and clears the stored choice. The initial class
  // is set pre-paint by HtmlShell.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      flipTheme((root) => {
        localStorage.removeItem("theme");
        root.classList.toggle("dark", e.matches);
      });
    });

  // Project-page sidebars, persisted on desktop only (mobile starts closed).
  // Must match the pre-paint applier in pages/projects/[...slug].astro.
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

  // /projects search: cards show while their data-search text matches `q`
  Alpine.data("projectSearch", () => ({
    q: "",
    root: null as HTMLElement | null,
    init() {
      this.root = this.$el;
    },
    matches(search: string) {
      const term = this.q.trim().toLowerCase();
      return term === "" || search.includes(term);
    },
    get visible() {
      const cards = this.root?.querySelectorAll<HTMLElement>("[data-search]");
      return [...(cards ?? [])].filter((el) =>
        this.matches(el.dataset.search ?? ""),
      ).length;
    },
  }));
};
