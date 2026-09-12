# CLAUDE.md

Astro 7 personal site: Tailwind v4, Alpine.js, three.js (WebGPU/TSL) lens viewer.

## Commands

- Dev server: `npx astro dev --port 4321` (daemonized; stop with `astro dev stop`). Not `npm run dev`. Restart it after moving/renaming/deleting files: the daemon's Vite graph goes stale and serves a mix of old and new modules (broken styling, a stale component, an import that throws) while builds stay clean.
- Tests: `npm test` (the default tier, ~4 s); `npm run test:structural` loads the GLB instruments; `npm run test:all` runs both. `src/lib/lens/STORY-MAP.md` is generated and byte-pinned; `STORY-COST.md` and `PIECE-FLOW.md` are generated instruments. `npm run lens:regen` rewrites all three — never hand-edit them.
- Before committing: `npm run format`; then `npm run format:check`, `npm run lint`, `npx astro check --minimumSeverity hint` and `npm test` must pass clean.
- Build: `npm run build`.

## Linting

`eslint.config.mjs`: eslint-plugin-astro recommended plus three Tailwind rules registered directly as errors — `no-unnecessary-arbitrary-value` (`w-[26rem]` → `w-104`), `no-contradicting-classname`, `enforces-shorthand`; `npm run lint:fix` auto-fixes. The tailwind plugin's recommended config is not used (its ordering/naming rules conflict with prettier and the site's classes).

## Client-side JS

- No `is:inline` scripts for logic — they skip bundling, minification and typechecking. The only inline scripts are the pre-paint bootstraps that must run during HTML parse: the theme-class + `?embed` bootstrap in `HtmlShell.astro` and the panel-state applier in the project page. Everything else goes in bundled `<script>` modules or `src/lib/alpine.ts`.
- `src/lib/alpine.ts` is the `@astrojs/alpinejs` entrypoint: every `Alpine.data()` and `Alpine.store()` registers there. Data names are JS identifiers (`projectPanels`) because `x-data` is evaluated as a JS expression; localStorage keys and `data-*` attributes are kebab-case.
- The desktop breakpoint lives once in `src/lib/constants.ts` (`DESKTOP_MEDIA`, mirroring Tailwind `lg`): JS imports it, Alpine templates use `$isDesktop()`, inline scripts receive it via `define:vars`. Never hard-code `64rem`.

## No-flash UI state

Alpine-driven panels (project page) bind a `data-open` attribute styled by Tailwind `data-[open=…]` / `in-data-[…]` variants. SSR renders no attribute and the base classes encode the default state (desktop expanded, mobile hidden), so nothing flashes before Alpine boots. Persisted state (localStorage `project-panels`, desktop only — mobile drawers start closed) is applied to the attributes by the pre-paint script and seeded into Alpine's `projectPanels`; the two must stay in sync.

## Theme

- `html.dark`, set pre-paint in `HtmlShell.astro`; explicit choice in localStorage `theme`; the OS-change listener in `src/lib/alpine.ts` wins and clears it.
- `$store.theme.toggle()` (ThemeToggle.astro) adds `.theme-anim` for a ~350ms crossfade (rule in `global.css`), debounced in `src/lib/alpine.ts`.
- Tokens live in `global.css` (warm cream/brown/olive, `--highlight` terracotta); Tailwind utilities read the `--color-*` names.
- The lens scene re-palettes through `SceneHandle.setTheme(light)`; pages watch `<html>`'s `class` with a MutationObserver.

## Layouts

- `HtmlShell` = head/body + pre-paint bootstraps; `BaseLayout` = chromed, contained page; `ProseLayout` = chromed narrow prose column; `ProjectLayout` = project app bar, no site chrome. No layout flags — a page needing another arrangement composes `HtmlShell`/`Navbar`/`Footer` directly (the homepage and /lens do).
- `?embed` makes a page chrome-less: HtmlShell's pre-paint script sets `data-embedded` on `<html>` and global.css hides header/footer under it. The project page iframes internal demos with it.

## Content

- Collections in `src/content.config.ts` (`z` from `astro/zod`).
- A project with a `url` (external, or an internal path like `/lens`) gets a demo page at `/projects/<id>` via the `[...slug]` route, which renders the url in an iframe. A subfolder in the id (`demos/lens`) groups it in the project rail (`src/lib/project-groups.ts`).
- Blog posts declare `projects: [<id>, …]`; project pages render the reverse "Featured in" links.

## Homepage hero

- `src/components/LensStory.astro` holds the hero (captions, pins, boot); the story table is `src/lib/lens/story/story.ts`. `.cap-*` classes in LensStory are the house caption typography; placement rules live in `LensSceneContent.astro`.
- Caption visibility is layout, not animation: each captioned scene renders a band (its slice of the scroll track, from `CAPTION_BANDS`) with a `position: sticky` caption inside, faded by a CSS `view()` timeline (`src/lib/cap-fades.ts` is the IntersectionObserver fallback). Captions work whether or not the 3D scene boots; the driver never writes their opacity.

## Lens 3D stack (`src/lib/lens/`)

- `ops/` (the motion system), `story/` (story table, envelopes, camera, hero driver, per-scene riders), `materials/`, `core/` (scene orchestrator + channel registry, model, parts), `optics/` (sky, starfield, fly-through math, wormhole post), `dev/` (dev-only instruments). Pages import only the `index.ts` barrel. **Start at `src/lib/lens/README.md`** for the change-X → touch-Y map. `docs/lens-principles.md` holds the standing design laws; `docs/lens-backlog.md` the open items.
- Only `lens_web_*.glb` models ship; never add `lens_full.glb`.

## Workflow

- Stage changes; the owner reviews and commits. Don't commit unprompted.
- Comments state only constraints the code can't show, 1-2 lines on what the code does: no owner attribution, "verified" notes, change history, measurements or rationale essays. Deleting such blocks on touch is correct.
