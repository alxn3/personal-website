// The shipped model loaded in node, with real geometry and `deriveFrames` run
// over it, and the story camera framed as core/scene frames it: the fixtures
// the model-measuring story tests share.

import * as THREE from "three/webgpu";
import { deriveFrames } from "../../ops/frames";
import { isAccessory } from "../../core/parts";
import { stampWinkLanes } from "../../core/visibility";
import { frameZoom, parkScaleFor } from "../../core/scene";
import { applyStoryFraming, sampleStory, type StorySample } from "../camera";
import { MODEL, accessor, glb } from "../../core/__tests__/glb";

/** The shipped node graph with real geometry and no materials. */
export function shippedModel(): THREE.Object3D {
  const { json, bin } = glb(MODEL);
  const geos = json.meshes.map((m) => {
    const prim = m.primitives[0];
    const geo = new THREE.BufferGeometry();
    const pos = accessor(json, bin, prim.attributes.POSITION);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(
      new THREE.BufferAttribute(accessor(json, bin, prim.indices!), 1),
    );
    return geo;
  });
  const objs = json.nodes.map((n) => {
    const o =
      n.mesh !== undefined
        ? new THREE.Mesh(geos[n.mesh])
        : new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  json.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) objs[i].add(objs[c]);
  });
  const root = new THREE.Object3D();
  root.name = "lens";
  for (const i of json.scenes[0].nodes) root.add(objs[i]);
  deriveFrames(root);
  stampWinkLanes(root);
  return root;
}

/** Place the graph as core/scene.ts does (bore on +X, mm to world units,
 *  centred on the origin). Returns the bounding-sphere radius too. */
export function placeModel(gltfScene: THREE.Object3D): {
  modelGroup: THREE.Group;
  modelRadius: number;
} {
  const MODEL_SCALE = 0.05;
  const modelGroup = new THREE.Group();
  modelGroup.rotation.z = -Math.PI / 2;
  modelGroup.scale.setScalar(MODEL_SCALE);
  gltfScene.rotation.y = Math.PI / 2;
  modelGroup.add(gltfScene);
  modelGroup.updateWorldMatrix(true, true);
  const bbox = new THREE.Box3();
  const meshBox = new THREE.Box3();
  gltfScene.traverse((o) => {
    if (o instanceof THREE.Mesh && !isAccessory(o.name))
      bbox.union(meshBox.setFromObject(o));
  });
  modelGroup.position.sub(bbox.getCenter(new THREE.Vector3()));
  modelGroup.updateWorldMatrix(true, true);
  return {
    modelGroup,
    modelRadius: bbox.getBoundingSphere(new THREE.Sphere()).radius,
  };
}

/** The story camera's raw sample at p: the sample, orbit offset, up and target. */
export function storySampleAt(p: number) {
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const target = new THREE.Vector3();
  return { sample: sampleStory(p, pos, up, target), pos, up, target };
}

/** The camera core/scene frames from a story sample on a w×h canvas. */
export function framedCamera(
  sample: StorySample,
  pos: THREE.Vector3,
  up: THREE.Vector3,
  target: THREE.Vector3,
  [w, h]: [number, number],
  parkScale = parkScaleFor(w, h),
): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(sample.fov, w / h, 0.1, 400);
  cam.zoom = frameZoom(w, h);
  applyStoryFraming(cam, sample, pos, up, target, w, h, parkScale);
  cam.updateMatrixWorld(true);
  return cam;
}

/** The camera at story p on a w×h canvas; `over` replaces sample fields. */
export function storyCamera(
  p: number,
  wh: [number, number],
  parkScale?: number,
  over: Partial<StorySample> = {},
): THREE.PerspectiveCamera {
  const { sample, pos, up, target } = storySampleAt(p);
  return framedCamera({ ...sample, ...over }, pos, up, target, wh, parkScale);
}
