import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { fakeScene, installHeroDom } from "./fake-scene";
import { atFrac, holdCentreOf, rangeOf, windowEdges } from "../story";
import { ROSE_PULSE } from "../envelopes";
import { createInternalsAmbient, internalsEnvAt } from "../internals";
import { createPeelCards, CARDS_IN_SPAN, MOUNT_LO } from "../peelcards";
import { createStoryConstellations } from "../constellations";
import { createStoryTrails, AMBIENT_MAX, AMBIENT_SPIN_RATE } from "../trails";
import { createStoryPetals, SPAN_P0 as PETALS_P0 } from "../petals";

// A rider's evaluate returns true only when it moved something visible on its
// own clock; that return decides whether an idle page keeps rendering.

installHeroDom({ scrollY: 0 });

const zR = rangeOf("zoom");
const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");
const coR = rangeOf("constellations");
const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
const [ROSE_P0] = windowEdges(ROSE_PULSE.rise);

/** the rider's answer parked at p: evaluate twice, return the second */
const parked = (f: ReturnType<typeof fakeScene>, p: number, dt = 16) => {
  f.evaluate(p, dt);
  return f.evaluate(p, dt);
};

describe("internals", () => {
  it("is live only while an envelope is open", () => {
    const f = fakeScene();
    createInternalsAmbient(f.scene);
    const idle = [0, cdR.p0, atFrac(cdR, 0.1), atFrac(inR, 0.97), inR.p1, 1];
    for (const p of idle) {
      const env = internalsEnvAt(p);
      expect(env.rack + env.breath, `env at ${p}`).toBe(0);
      expect(parked(f, p), `parked at ${p}`).toBe(false);
    }
    for (const p of [atFrac(cdR, 0.5), holdCentreOf(inR), atFrac(inR, 0.7)])
      expect(parked(f, p), `parked at ${p}`).toBe(true);
  });
});

describe("the card field", () => {
  it("is live only while a card is drawn — not for the mounted, empty sphere", () => {
    const f = fakeScene();
    createPeelCards(f.scene);
    // the whole zoom scene and the peel up to the first fade: nothing drawn
    for (const p of [0, holdCentreOf(zR), peR.p0, atFrac(peR, 0.5), MOUNT_LO])
      expect(parked(f, p), `parked at ${p}`).toBe(false);
    // the field is mounted at MOUNT_LO all the same
    expect(f.modelOverlays.size).toBe(1);
    expect(CARDS_IN_SPAN[0]).toBeGreaterThan(MOUNT_LO);
    for (const p of [atFrac(cdR, 0.05), holdCentreOf(cdR), atFrac(cdR, 0.6)])
      expect(parked(f, p), `parked at ${p}`).toBe(true);
    // every card has left before the scene's end: still mounted, not live
    expect(parked(f, atFrac(cdR, 0.995))).toBe(false);
    expect(f.modelOverlays.size).toBe(1);
  });
});

describe("the sky's ink", () => {
  it("is live while strokes draw, and asleep on the held quote", () => {
    const f = fakeScene();
    createStoryConstellations(f.scene);
    expect(parked(f, 0)).toBe(false);
    expect(parked(f, holdCentreOf(coR))).toBe(true);
    // only the static quote through the trails
    for (const p of [atFrac(tR, 0.3), atFrac(tR, 0.5), atFrac(tR, 0.8)])
      expect(parked(f, p), `parked at ${p}`).toBe(false);
    expect(parked(f, atFrac(rwR, 0.5))).toBe(false);
  });

  it("asks for a frame while the starfield it rides is not yet mounted", () => {
    const f = fakeScene();
    f.starfieldMounted = false;
    createStoryConstellations(f.scene);
    expect(parked(f, holdCentreOf(coR))).toBe(true);
    expect(f.skyChildren.size).toBe(0);
    f.starfieldMounted = true;
    expect(parked(f, holdCentreOf(coR))).toBe(true);
    expect(f.skyChildren.size).toBe(1);
  });
});

describe("the trails", () => {
  it("is live while the drift turns, and asleep once the drift is capped", () => {
    const f = fakeScene();
    createStoryTrails(f.scene);
    const p = holdCentreOf(tR);
    expect(parked(f, p, 100)).toBe(true);
    // the drift stops at AMBIENT_MAX radians
    const capMs = (1000 * AMBIENT_MAX) / AMBIENT_SPIN_RATE;
    for (let t = 0; t < capMs + 1000; t += 100) f.evaluate(p, 100);
    expect(f.evaluate(p, 100)).toBe(false);
    // outside the trails the drift unwinds to 0, then the field is still
    for (let t = 0; t < 3000; t += 100) f.evaluate(0, 100);
    expect(f.evaluate(0, 100)).toBe(false);
  });
});

describe("the petals", () => {
  it("is live only while petals are drawn — not on the mounted pad", () => {
    const f = fakeScene();
    createStoryPetals(f.scene);
    for (const p of [0, holdCentreOf(rwR), PETALS_P0, ROSE_P0])
      expect(parked(f, p), `parked at ${p}`).toBe(false);
    // mounted all the same
    expect(f.overlays.size).toBe(1);
    for (const p of [atFrac(rangeOf("capsOn"), 0.9), 1])
      expect(parked(f, p), `parked at ${p}`).toBe(true);
  });

  it("never writes the dust — that is the driver's law", () => {
    const f = fakeScene();
    createStoryPetals(f.scene);
    for (const p of [0, PETALS_P0 - 1e-6, PETALS_P0, 1, 0.5]) f.evaluate(p);
    expect(f.calls).not.toContain("setDust");
  });
});

describe("zero-opacity sky ink", () => {
  /** a fake whose starfield is a real parent, as core/scene.ts's is */
  const skyScene = () => {
    const sky = new THREE.Group();
    const f = fakeScene({
      starfieldAttach: (o: THREE.Object3D) => (sky.add(o), true),
      starfieldDetach: (o: THREE.Object3D) => void o.removeFromParent(),
    });
    return { f, sky };
  };

  it("trails: not drawn while attached at zero opacity; visible unattached", () => {
    const { f, sky } = skyScene();
    createStoryTrails(f.scene);
    f.evaluate(holdCentreOf(tR));
    const arcs = sky.children[0];
    expect(arcs.visible).toBe(true);
    // inside the attach pad, before the arcs fade in
    f.evaluate(tR.p0);
    expect(arcs.parent).toBe(sky);
    expect(arcs.visible).toBe(false);
    // detached: visible again, so the warm draw reaches it
    f.evaluate(0);
    expect(arcs.parent).toBe(null);
    expect(arcs.visible).toBe(true);
  });

  it("constellations: only the quote is drawn behind it; all visible unattached", () => {
    const { f, sky } = skyScene();
    createStoryConstellations(f.scene);
    f.evaluate(holdCentreOf(coR));
    const group = sky.children[0];
    const meshes = group.children;
    expect(meshes.every((m) => m.visible)).toBe(true);
    // only the quote shows through the trails
    f.evaluate(atFrac(tR, 0.5));
    const shown = meshes.filter((m) => m.visible).map((m) => m.name);
    expect(shown).toEqual(["Lens_SkyQuote"]);
    f.evaluate(0);
    expect(group.parent).toBe(null);
    expect(meshes.every((m) => m.visible)).toBe(true);
  });
});
