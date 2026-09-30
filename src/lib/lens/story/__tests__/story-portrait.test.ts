import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  placeModel,
  shippedModel,
  storyCamera,
  storySampleAt,
} from "./shipped-model";
import { isAccessory } from "../../core/parts";
import { RANGES, atFrac, holdCentreOf, rangeOf } from "../story";

// On a phone the frame keeps the desktop's world width and grows tall, so
// poses push in (`Pose.near`) and shift (`Pose.lift`); landscape never sees
// either.

const gltf = shippedModel();
placeModel(gltf);
/** the seated lens's radius in the radial plane, world units */
const R = (() => {
  const bbox = new THREE.Box3();
  const mb = new THREE.Box3();
  gltf.traverse((o) => {
    if (o instanceof THREE.Mesh && !isAccessory(o.name))
      bbox.union(mb.setFromObject(o));
  });
  return Math.max(bbox.max.y - bbox.min.y, bbox.max.z - bbox.min.z) / 2;
})();

const WIDE: [number, number] = [1440, 900];
const PHONE: [number, number] = [390, 844];
const heroScene = rangeOf("hero");
const peelScene = rangeOf("peel");

const ndc = (v: THREE.Vector3, cam: THREE.Camera) => v.clone().project(cam);
/** the disc's projected height, in frame heights, and its top edge in frame
 *  heights from the top */
function disc(cam: THREE.Camera) {
  const top = ndc(new THREE.Vector3(0, R, 0), cam).y;
  const bot = ndc(new THREE.Vector3(0, -R, 0), cam).y;
  return { height: (top - bot) / 2, top: (1 - top) / 2 };
}
/** the core's projected width, in frame widths */
const coreWidth = (cam: THREE.Camera) =>
  (ndc(new THREE.Vector3(0, 0, R), cam).x -
    ndc(new THREE.Vector3(0, 0, -R), cam).x) /
  2;

/** mid-move, hold centre and near the end of a scene */
const readings = (r: (typeof RANGES)[number]) => [
  atFrac(r, r.scene.transit / 2),
  holdCentreOf(r),
  atFrac(r, 0.95),
];

describe("the portrait push-in and lift", () => {
  it("costs a LANDSCAPE frame nothing — `near` and `lift` gate on parkScale", () => {
    for (const r of RANGES)
      for (const p of readings(r)) {
        const real = storyCamera(p, WIDE, 1);
        const none = storyCamera(p, WIDE, 1, { near: 1, lift: 0 });
        const at = `${r.scene.id} ${p}`;
        expect(real.position.toArray(), at).toEqual(none.position.toArray());
        expect(real.fov, at).toBe(none.fov);
        expect(real.view!.offsetX, at).toBe(none.view!.offsetX);
        expect(real.view!.offsetY, at).toBe(none.view!.offsetY);
      }
  });

  it("fills a phone: the hero disc and the peel core are not specks", () => {
    for (const p of readings(heroScene))
      expect(disc(storyCamera(p, PHONE)).height, `hero ${p}`).toBeGreaterThan(
        0.28,
      );
    for (const f of [0.55, 0.8, 0.95])
      expect(coreWidth(storyCamera(atFrac(peelScene, f), PHONE)), `peel ${f}`).toBeGreaterThan(0.3); // prettier-ignore
  });

  it("drops the hero disc under the top-anchored intro type on a phone", () => {
    // the copy ends about 41 % down a 390×844 frame
    for (const f of [0.1, 0.5, 0.9, 1])
      expect(disc(storyCamera(atFrac(heroScene, f), PHONE)).top, `hero ${f}`).toBeGreaterThan(0.41); // prettier-ignore
  });

  it("is a size change only — the fov the cards' fit reads never moves", () => {
    // peelcards.ts sizes the cards from the fov at the authored distance, so
    // the cards scene must not push in and `near` must only move the camera
    expect(rangeOf("cards").scene.cam.near).toBeUndefined();
    for (const r of RANGES)
      for (const p of readings(r)) {
        const cam = storyCamera(p, PHONE);
        const pushed = storyCamera(p, PHONE, undefined, { near: 0.5 });
        const at = `${r.scene.id} ${p}`;
        expect(pushed.fov, at).toBe(cam.fov);
        expect(pushed.zoom, at).toBe(cam.zoom);
        expect(pushed.position.length(), at).toBeLessThan(cam.position.length()); // prettier-ignore
      }
  });

  it("holds the ending's phone laws with the bloom pushed in", () => {
    // the push-in arrives over the quarter-turn
    const bloomScene = rangeOf("capsOn");
    const s = (p: number) => storySampleAt(p).sample;
    expect(s(bloomScene.p0).near).toBe(1);
    expect(s(atFrac(bloomScene, 0.7)).near).toBe(bloomScene.scene.cam.near);
    expect(s(atFrac(bloomScene, 0.7)).lift).toBe(0);
  });
});
