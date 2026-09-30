import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parkScaleFor } from "../../core/scene";

// Reads the caption components' CSS to check the phone layout's media query
// switches at the same aspect where parkScaleFor reaches zero.

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");
const CONTENT = read("../../../../components/LensSceneContent.astro");
const STORY = read("../../../../components/LensStory.astro");

/** the query every phone-layout block uses (copied by hand; Astro's scoped
 *  CSS has no custom media) */
const PHONE_MQ = "(max-width: 760px), (max-aspect-ratio: 4/5)";
/** narrow landscape window, where the park is still live */
const LANDSCAPE_MQ = "(max-width: 760px) and (min-aspect-ratio: 4/5)";

/** every `@media` block as { query, body }, by brace matching */
const mediaBlocks = (css: string): { query: string; body: string }[] => {
  const out: { query: string; body: string }[] = [];
  const re = /@media ([^{]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; depth > 0 && i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push({ query: m[1].trim(), body: css.slice(re.lastIndex, i - 1) });
  }
  return out;
};

const aspectOf = (mq: string): [number, number] => {
  const m = /aspect-ratio: (\d+)\/(\d+)/.exec(mq);
  if (!m) throw new Error(`no aspect in ${mq}`);
  return [Number(m[1]), Number(m[2])];
};

describe("phone caption layout", () => {
  it("switches exactly where parkScaleFor reaches zero", () => {
    const [w, h] = aspectOf(PHONE_MQ);
    // park off at the boundary, on just above it
    expect(parkScaleFor(w, h)).toBe(0);
    expect(parkScaleFor(w * 1.001, h)).toBeGreaterThan(0);
    expect(PHONE_MQ).toContain("max-aspect-ratio");
  });

  it("is the query on every caption-layout block, in both components", () => {
    const content = mediaBlocks(CONTENT).filter((b) => /760px/.test(b.query));
    expect(content.map((b) => b.query)).toEqual([PHONE_MQ, LANDSCAPE_MQ]);
    const story = mediaBlocks(STORY).filter((b) => /760px/.test(b.query));
    // the fade split and the .cap-* type; the #hud hide stays width-keyed
    const phone = story.filter((b) => b.query === PHONE_MQ);
    expect(phone).toHaveLength(2);
    expect(phone.some((b) => /animation-range/.test(b.body))).toBe(true);
    expect(phone.some((b) => /\.cap-title/.test(b.body))).toBe(true);
    for (const b of story)
      if (b.query !== PHONE_MQ) expect(b.body).not.toMatch(/cap-|hero-intro/);
  });

  it("keeps the 50% half-width only under the landscape-aspect guard", () => {
    const halves = CONTENT.match(/max-width:[^;{}]*50%/g) ?? [];
    expect(halves).toHaveLength(1);
    const guard = mediaBlocks(CONTENT).find((b) => b.query === LANDSCAPE_MQ);
    expect(guard?.body).toContain(halves[0]);
    expect(aspectOf(LANDSCAPE_MQ)).toEqual(aspectOf(PHONE_MQ));
    // portrait phones get the full column
    const phone = mediaBlocks(CONTENT).find((b) => b.query === PHONE_MQ);
    expect(phone?.body).toContain("max-width: min(88vw, 460px);");
  });
});
