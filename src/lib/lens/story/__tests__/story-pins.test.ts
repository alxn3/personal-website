import { describe, expect, it } from "vitest";
import { fakeScene, installHeroDom } from "./fake-scene";
import { bandOf, holdCentreOf, rangeOf } from "../story";

// The pins (LensPin.astro) are projected and moved only while they can show:
// inside their scene's caption band, and not display:none (phones).

const TRACK = 11_000;
const VIEW = 1000;
const dom = installHeroDom({
  scrollY: 0,
  trackHeight: TRACK,
  innerHeight: VIEW,
  pins: [
    { beat: "internals", track: "Shown" },
    { beat: "internals", track: "Phone", display: "none" },
  ],
});
const fake = fakeScene();
const { startHeroStory } = await import("../hero-driver");
startHeroStory(fake.scene);

/** scroll to p, then run the frame callbacks; returns the nodes projected */
const frameAt = (p: number) => {
  dom.scroll(p * (TRACK - VIEW));
  const asked: string[] = [];
  const project = (node: string, out: { x: number; y: number }) => {
    asked.push(node);
    out.x = 100 + p;
    out.y = 200;
    return out;
  };
  for (const cb of fake.frameCbs) cb(project, 16);
  return asked;
};

describe("the pins", () => {
  const band = bandOf("internals");

  it("project nothing outside their scene's band", () => {
    for (const p of [0, band.a - 1e-4, band.b + 1e-4, 1])
      expect(frameAt(p), `p ${p}`).toEqual([]);
    expect(dom.pins[0].style.transform).toBeUndefined();
  });

  it("follow their node inside it; a display:none pin never projects", () => {
    const p = holdCentreOf(rangeOf("internals"));
    expect(frameAt(p)).toEqual(["Shown"]);
    expect(dom.pins[0].style.transform).toBe(
      `translate(${Math.round((100 + p) * 10) / 10}px, 200px)`,
    );
    expect(dom.pins[1].style.transform).toBeUndefined();
  });
});
