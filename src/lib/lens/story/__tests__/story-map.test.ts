import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { CAPTION_BANDS, RANGES, TOTAL_HOLD } from "../story";
import {
  STORY_SAMPLE_PS,
  STORY_WINDOWS,
  storyStateAt,
  type StoryState,
} from "../state";
import { CHANNEL_DEFAULTS } from "../../core/scene";

// ============================================================================
// THE STORY-MAP — src/lib/lens/STORY-MAP.md, rendered from storyStateAt and
// asserted byte-for-byte, so a duration or window change fails here with the
// new table in the diff.
//
// TO REGENERATE, after a deliberate change:
//   LENS_STORY_MAP=1 npx vitest run src/lib/lens/story/__tests__/story-map.test.ts
//
// The renderer below is pure presentation — every number comes out of
// storyStateAt; there is no second model of the story in this file.
// ============================================================================

const MAP_URL = new URL("../../STORY-MAP.md", import.meta.url);

const f = (v: number | null, d: number) => (v === null ? "—" : v.toFixed(d));

/** one fixed-width table, columns sized to their widest cell */
const table = (head: string[], rows: string[][]): string => {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padStart(w[i]))
      .join("  ")
      .trimEnd();
  return [
    line(head),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map(line),
  ].join("\n");
};

const sceneRows = () =>
  RANGES.map((r, i) => [
    String(i).padStart(2, "0"),
    r.scene.id,
    r.scene.title,
    r.p0.toFixed(4),
    r.p1.toFixed(4),
    r.scene.hold.toFixed(2),
    r.scene.transit.toFixed(4),
    [
      r.scene.rail ? "rail" : "",
      r.scene.camHold === undefined ? "" : `camHold ${r.scene.camHold}`,
    ]
      .filter(Boolean)
      .join(" "),
  ]);

const bandRows = () =>
  CAPTION_BANDS.map((b) => [
    b.id,
    b.a.toFixed(4),
    b.b.toFixed(4),
    b.final ? "final" : "",
  ]);

const windowRows = () =>
  [...STORY_WINDOWS]
    .sort((a, b) => a.p0 - b.p0 || a.p1 - b.p1)
    .map((w) => [
      w.name,
      w.p0.toFixed(4),
      w.p1.toFixed(4),
      (w.p1 - w.p0).toFixed(4),
    ]);

const STATE_HEAD = [
  "p",
  "scene",
  "local",
  "camX",
  "camY",
  "camZ",
  "tgtX",
  "tgtY",
  "tgtZ",
  "fov",
  "dolly",
  "roll",
  "turn",
  "tilt",
  "zoom",
  "focus",
  "aper",
  "expl",
  "asm",
  "peel",
  "inkFill",
  "inkMix",
  "body",
  "shell",
  "intr",
  "sweep",
  "iris",
];

const stateRow = (s: StoryState): string[] => [
  s.p.toFixed(4),
  s.scene.id,
  s.scene.local.toFixed(3),
  s.camera.pos[0].toFixed(2),
  s.camera.pos[1].toFixed(2),
  s.camera.pos[2].toFixed(2),
  s.camera.target[0].toFixed(2),
  s.camera.target[1].toFixed(2),
  s.camera.target[2].toFixed(2),
  s.camera.fov.toFixed(2),
  s.model.dollyX.toFixed(2),
  s.model.rollX.toFixed(3),
  s.model.turnY.toFixed(3),
  s.model.tiltZ.toFixed(3),
  f(s.channels.zoom, 3),
  f(s.channels.focus, 3),
  f(s.channels.aperture, 3),
  f(s.channels.explode, 3),
  f(s.channels.assemble, 3),
  f(s.channels.peel, 3),
  s.look.inkFill.toFixed(3),
  s.look.inkMix.toFixed(3),
  s.look.bodyFade.toFixed(3),
  s.look.shellFade.toFixed(3),
  s.look.interiorFade.toFixed(3),
  s.sky.trailSweep.toFixed(3),
  s.irisOwner,
];

const openRows = (states: StoryState[]) =>
  states.map((s) => [
    s.p.toFixed(4),
    s.windows.length
      ? s.windows.map((w) => `${w.name} ${w.f.toFixed(2)}`).join(", ")
      : "—",
  ]);

function render(): string {
  const states = STORY_SAMPLE_PS.map((p) => storyStateAt(p));
  return `<!-- GENERATED — do not edit by hand. See story/__tests__/story-map.test.ts. -->

# STORY-MAP

Pose, channels and open windows at every scene, band and window edge, rendered
from \`story/state.ts\`'s \`storyStateAt(p)\`. These are the AUTHORED values at
\`p\`: the live frame eases \`story\` toward them, the internals rack and the
card orbit run on phase clocks, and \`—\` means the value is not a function of
\`p\` alone. Regenerate (the test pins the file byte-for-byte):

    LENS_STORY_MAP=1 npx vitest run src/lib/lens/story/__tests__/story-map.test.ts

Track: ${RANGES.length} scenes, ${TOTAL_HOLD.toFixed(2)} screenfuls of hold.

## Scenes

\`\`\`text
${table(
  ["scn", "id", "title", "p0", "p1", "hold", "transit", "flags"],
  sceneRows(),
)}
\`\`\`

## Caption bands

Each scene's range padded by \`CAPTION_PAD\`; the final band runs to the track
end. \`--beat-visibility\` is \`band(p, a, b)\`.

\`\`\`text
${table(["band", "a", "b", "flags"], bandRows())}
\`\`\`

## Windows

Every ramp whose edges its owning module exports, in absolute story \`p\`.

\`\`\`text
${table(["window", "p0", "p1", "width"], windowRows())}
\`\`\`

## State at every edge

One row per scene edge, caption-band edge and window edge. \`camX/Y/Z\` is the
orbit OFFSET from \`tgtX/Y/Z\` (the camera sits at their sum). \`roll\` is
radians about the optical axis, \`turn\` radians about world +Y, \`tilt\` the
rock's other half; \`sweep\` is the sky's turn in radians; \`iris\` is who owns
focus/aperture there.

\`\`\`text
${table(STATE_HEAD, states.map(stateRow))}
\`\`\`

## Which windows are open

\`\`\`text
${table(["p", "windows containing p (fraction through)"], openRows(states))}
\`\`\`
`;
}

describe("STORY-MAP", () => {
  it("matches the checked-in map", () => {
    const rendered = render();
    if (process.env.LENS_STORY_MAP) writeFileSync(MAP_URL, rendered);
    expect(
      readFileSync(MAP_URL, "utf8"),
      "src/lib/lens/STORY-MAP.md is stale — regenerate with LENS_STORY_MAP=1 and review the diff",
    ).toBe(rendered);
  });

  it("regenerates to itself — the render is a pure function of the story", () => {
    // a Date, a Math.random or an insertion-ordered Set in the table shows here
    expect(render()).toBe(render());
  });
});

describe("the state module's coverage", () => {
  it("reports every channel in the registry", () => {
    // a channel added to CHANNEL_REGISTRY must appear in the map too
    expect(Object.keys(storyStateAt(0.5).channels).sort()).toEqual(
      Object.keys(CHANNEL_DEFAULTS).sort(),
    );
  });

  it("samples every edge the story is built from", () => {
    for (const r of RANGES) {
      expect(STORY_SAMPLE_PS).toContain(r.p0);
      expect(STORY_SAMPLE_PS).toContain(r.p1);
    }
    for (const w of STORY_WINDOWS) {
      expect(STORY_SAMPLE_PS, `${w.name} p0`).toContain(w.p0);
      expect(STORY_SAMPLE_PS, `${w.name} p1`).toContain(w.p1);
    }
    // sorted, deduped, inside the track
    for (let i = 1; i < STORY_SAMPLE_PS.length; i++)
      expect(STORY_SAMPLE_PS[i]).toBeGreaterThan(STORY_SAMPLE_PS[i - 1]);
    expect(STORY_SAMPLE_PS[0]).toBe(0);
    expect(STORY_SAMPLE_PS[STORY_SAMPLE_PS.length - 1]).toBe(1);
  });
});
