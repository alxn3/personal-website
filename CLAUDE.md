# CLAUDE.md

Astro 7 personal site: Tailwind v4, Alpine.js, three.js (WebGPU/TSL) lens viewer.

## Commands

- Dev server: `npx astro dev --port 4321` (daemonized; `astro dev stop` stops it), not `npm run dev`. Restart it after moving, renaming or deleting files: its Vite graph goes stale and serves a mix of old and new modules while builds stay clean.
- Tests: `npm test` (default tier, ~4 s); `npm run test:structural` (loads the GLBs); `npm run test:all` (both).
- Generated files: `src/lib/lens/STORY-MAP.md` (byte-pinned), `STORY-COST.md` and `PIECE-FLOW.md`. Rewrite them with `npm run lens:regen`; never hand-edit.
- Before committing: `npm run format`, then `npm run format:check`, `npm run lint`, `npx astro check --minimumSeverity hint` and `npm test` must pass clean.
- Build: `npm run build`.

## Linting

`eslint.config.mjs`: eslint-plugin-astro recommended plus three Tailwind rules as errors: `no-unnecessary-arbitrary-value` (`w-[26rem]` → `w-104`), `no-contradicting-classname`, `enforces-shorthand`. `npm run lint:fix` auto-fixes. The Tailwind plugin's recommended config is off (its ordering rules conflict with prettier).

## Client-side JS

- No `is:inline` scripts for logic (they skip bundling and typechecking). The only inline scripts are pre-paint bootstraps: the theme class + `html.js` + `?embed` script in `HtmlShell.astro`, and the panel-state applier on the project page. `html.js` gates JS-only hidden states, so a no-JS page shows everything.
- `src/lib/alpine.ts` is the `@astrojs/alpinejs` entrypoint; every `Alpine.data()` and `Alpine.store()` registers there. Data names are JS identifiers (`projectPanels`); localStorage keys and `data-*` attributes are kebab-case.
- The desktop breakpoint lives once in `src/lib/constants.ts` (`DESKTOP_MEDIA`, Tailwind `lg`): JS imports it, Alpine templates use `$isDesktop()`, inline scripts get it via `define:vars`. Never hard-code `64rem`.

## No-flash UI state

Project-page panels bind a `data-open` attribute styled with Tailwind `data-[open=…]` / `in-data-[…]` variants. SSR renders no attribute and the base classes encode the default (desktop open, mobile closed), so nothing flashes before Alpine boots. Saved state (localStorage `project-panels`, desktop only) is applied by the pre-paint script and read by `projectPanels`; the two must stay in sync.

## Theme

- `html.dark` is set pre-paint in `HtmlShell.astro`; an explicit choice is stored in localStorage `theme`. The OS-change listener in `src/lib/alpine.ts` wins and clears it.
- `$store.theme.toggle()` (ThemeToggle.astro) adds `.theme-anim` for a ~350ms colour crossfade (rule in `global.css`).
- Tokens live in `global.css`; Tailwind utilities read the `--color-*` names.
- `src/styles/palettes-tryout.css` + `src/lib/palette-tryout.ts` are a temporary palette picker (`?palette`), to be deleted once a palette is chosen.
- The lens scene re-palettes via `SceneHandle.setTheme(light)`; pages call `watchTheme` (a MutationObserver on `<html>`'s class).

## Layouts

- `HtmlShell` = head/body + pre-paint bootstraps; `BaseLayout` = chromed, contained page; `ProseLayout` = chromed prose column; `ProjectLayout` = project app bar, no site chrome. No layout flags: a page needing another arrangement composes `HtmlShell`/`Navbar`/`Footer` directly (the homepage and /lens do).
- `?embed` hides the site header and footer (`data-embedded` on `<html>`, rule in `global.css`). The project page iframes internal demos with it.

## Content

- Collections are in `src/content.config.ts` (`z` from `astro/zod`).
- A project with a `url` (external, or an internal path like `/lens`) gets a demo page at `/projects/<id>` that iframes the url. A subfolder in the id (`demos/lens`) groups it in the project rail (`src/lib/project-groups.ts`).
- Blog posts declare `projects: [<id>, …]`; project pages show the reverse "Featured in" links.

## Homepage hero

- `src/components/LensStory.astro` holds the hero (captions, pins, boot); the story table is `src/lib/lens/story/story.ts`. Its `.cap-*` classes are the caption typography; placement lives in `LensSceneContent.astro`.
- Captions are layout, not animation: each captioned scene renders a band (its slice of the scroll track, from `CAPTION_BANDS`) with a sticky caption inside, faded by a CSS `view()` timeline. `src/lib/cap-fades.ts` is the IntersectionObserver fallback. Captions work without the 3D scene; the driver never writes their opacity.

## Lens 3D stack (`src/lib/lens/`)

- `ops/` (motion system), `story/` (story table, envelopes, camera, hero driver, per-scene riders), `materials/`, `core/` (scene, channel registry, model, parts), `optics/` (sky, starfield, fly-through, wormhole post), `dev/` (dev-only tools). Pages import only the `index.ts` barrel.
- **Start at `src/lib/lens/README.md`** for what to touch for each change. `docs/lens-principles.md` holds the design rules; `docs/lens-backlog.md` the open items.
- Only `lens_web_*.glb` models ship; never add `lens_full.glb`.

## Workflow

- Stage changes; the owner reviews and commits. Don't commit unprompted.
- Comments say what the code does in 1-2 lines and keep only constraints the code can't show: no owner attribution, "verified" notes, history, measurements or rationale essays. Deleting such blocks on touch is correct.
