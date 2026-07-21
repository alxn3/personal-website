# CLAUDE.md

Astro 7 personal site: Tailwind v4, Alpine.js, three.js (WebGPU/TSL) lens viewer.

## Commands

- Dev server: `npx astro dev --port 4321` (daemonized; stop with `astro dev stop`). Not `npm run dev`.
- Before committing: `npm run format`; then `npm run format:check`, `npm run lint`, and `npx astro check --minimumSeverity hint` must all pass clean.
- Build: `npm run build`.

## Linting

- `eslint.config.mjs`: eslint-plugin-astro recommended, plus exactly one Tailwind rule registered directly — `tailwindcss/no-unnecessary-arbitrary-value` as error, the repo-side mirror of the editor's canonical-classes lint (`w-[26rem]` → `w-104`). `npm run lint:fix` auto-fixes. The tailwind plugin's recommended config is deliberately not used (it drags in ordering/naming rules that prettier and the site's own classes conflict with).

## Client-side JS conventions

- No `is:inline` scripts for logic — they skip bundling, minification, and typechecking. Client logic belongs in bundled `<script>` modules or the Alpine entrypoint.
- `src/lib/alpine.ts` is the `@astrojs/alpinejs` entrypoint: register every `Alpine.data()` component and `Alpine.store()` there. Data names must be valid JS identifiers (`projectPanels`) because Alpine evaluates `x-data` as a JS expression — kebab-case would parse as subtraction. Use kebab-case for localStorage keys and `data-*` attributes.
- The desktop breakpoint lives ONCE in `src/lib/constants.ts` (`DESKTOP_MEDIA`, mirroring Tailwind `lg`): JS imports it, Alpine templates use the `$isDesktop()` magic, and inline scripts receive it via `define:vars`. Never hard-code `64rem` in JS.
- The only permitted inline scripts are tiny pre-paint bootstraps that must run during HTML parse (bundled modules are deferred and would flash): the theme-class + `?embed` bootstrap in `HtmlShell.astro` and the panel-state applier in the project page. Keep them minimal; listeners and everything non-pre-paint go in `src/lib/alpine.ts`.

## No-flash UI state pattern

Alpine-driven panels (project page) bind a `data-open` attribute that Tailwind `data-[open=…]` / `in-data-[…]` variants style. SSR renders no attribute and the base classes encode the default state (desktop expanded, mobile hidden), so nothing flashes before Alpine boots. Persisted state (localStorage `project-panels`, desktop only — mobile drawers always start closed) is applied to the attributes by the pre-paint inline script and seeded into Alpine's `projectPanels` data; those two must stay in sync.

## Theme

- `html.dark` class, set pre-paint in `HtmlShell.astro`; explicit choice stored in localStorage `theme`; the OS-change listener (in `src/lib/alpine.ts`) wins and clears it.
- Toggle through `$store.theme.toggle()` (ThemeToggle.astro) — it adds `.theme-anim` for a ~350ms colour crossfade (rule in `global.css`), debounced inside `src/lib/alpine.ts`.
- Tokens live in `global.css`: warm cream/brown/olive palette, `--highlight` terracotta for emphasis; Tailwind utilities read the `--color-*` names.
- The 3D lens scene re-palettes through `SceneHandle.setTheme(light)`; pages watch the `<html>` `class` attribute with a MutationObserver.

## Layouts

- `HtmlShell` = document head/body + pre-paint bootstraps; `BaseLayout` = the standard chromed, contained page; `ProseLayout` = chromed narrow prose column; `ProjectLayout` = project app bar, no site chrome. No layout flags — a page needing a different arrangement composes `HtmlShell`/`Navbar`/`Footer` directly (the homepage and /lens do).
- Chrome-less embedding is opt-in via a `?embed` query param: HtmlShell's pre-paint script sets `data-embedded` on `<html>` and global.css hides header/footer under it. The project page iframes internal demos with `?embed`; omit the param to embed a page with full chrome.
- Iframe embeds: HtmlShell's pre-paint script sets `data-embedded` on `<html>` when `self !== top`; `global.css` hides `header`/`footer` under it, so an internal demo iframed on a project page shows no double chrome.

## Content

- Collections in `src/content.config.ts` (`z` imports from `astro/zod`, not the deprecated re-exports).
- Projects with a `url` (external URL or internal path like `/lens`) get demo pages at `/projects/<id>` via the `[...slug]` rest route, which renders the url in an iframe. A subfolder in the id (`demos/lens`) files it under a group header in the project rail — grouping logic in `src/lib/project-groups.ts`.
- Blog posts declare `projects: [<id>, …]` references; project pages render the reverse "Featured in" links.

## Homepage hero captions

- `.cap-*` classes in `index.astro`'s `<style>` are the house caption typography for scene-slotted content; the wrapper's placement/responsive rules live in `LensSceneContent.astro`. Slotted blocks are arbitrary markup — the house classes are optional.

## Lens 3D stack (`src/lib/lens-*`)

- `lens-scene` orchestrates; `lens-camera` (scroll-story camera path), `lens-rig` (mechanism drives), `lens-bloom` (TSL wedge-deform shader), `lens-shading` (render styles + per-theme palettes), `lens-cinematics` (rays/dust/caps), `lens-story` (scene table — single source of truth for pacing), `lens-depthfade`, `lens-model`, `lens-math`.
- Only `lens_web_*.glb` models ship; never add `lens_full.glb` to the repo.

## Workflow

- Stage changes; the owner reviews and commits (or asks for a drafted commit message). Don't commit unprompted.
- Scratch docs (`HANDOFF.md`, `BLOOM_TSL_PLAN.md`, `docs/superpowers/`) stay untracked unless asked.
- Prefer conventions and rationale here over meta-comments in code — code comments should state only constraints the code itself can't show.
