// THE SHIPPED MODEL, READ AND FRAMED IN NODE — the fixture piece-flow.test.ts
// and story-ending.test.ts measure against. Slices the BIN chunk's accessors,
// rebuilds the shipped node graph and runs the real `deriveFrames` over it, so
// the roster here is the browser's roster on the same bytes.

import { readFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { deriveFrames } from "../../ops/frames";
import { isAccessory } from "../../core/parts";
import { stampWinkLanes } from "../../core/visibility";

const MODEL = "public/models/lens_web_segmented.glb";

interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews: {
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
  scenes: { nodes: number[] }[];
}

/** The glTF JSON chunk and the BIN chunk of a .glb — ops/__tests__'s idiom,
 *  keeping the binary this time. */
function glb(path: string): { json: Gltf; bin: Buffer } {
  const buf = readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  return { json: json!, bin };
}

/** glTF `componentType` → the typed array that reads it. The shipped files use
 *  5126/5123; the other two keep a widened index buffer readable. */
const COMPONENT = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const PER_ELEMENT: Record<string, number> = { SCALAR: 1, VEC3: 3 };

/** One accessor as a typed array over the BIN chunk. The bytes are COPIED, not
 *  viewed: a bufferView offset need not be component-aligned and a misaligned
 *  view throws. Interleaved bufferViews are refused loudly. */
function accessor(json: Gltf, bin: Buffer, i: number) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const Ctor = COMPONENT[a.componentType as keyof typeof COMPONENT];
  if (!Ctor) throw new Error(`accessor ${i}: componentType ${a.componentType}`);
  if (bv.byteStride !== undefined)
    throw new Error(`accessor ${i}: interleaved bufferView is not supported`);
  const n = a.count * PER_ELEMENT[a.type];
  const at = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const bytes = new Uint8Array(
    bin.subarray(at, at + n * Ctor.BYTES_PER_ELEMENT),
  );
  return new Ctor(bytes.buffer);
}

/** The shipped node graph with REAL geometry — the browser's scene, minus the
 *  materials nothing here reads. */
export function shippedModel(): THREE.Object3D {
  const { json, bin } = glb(MODEL);
  const geos = json.meshes.map((m) => {
    const prim = m.primitives[0];
    const geo = new THREE.BufferGeometry();
    const pos = accessor(json, bin, prim.attributes.POSITION);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(
      new THREE.BufferAttribute(accessor(json, bin, prim.indices), 1),
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

/** core/scene.ts's placement of that graph — bore onto +X, mm to world units,
 *  visual centre on the origin — so a mesh's `matrixWorld` maps local
 *  millimetres to the story camera's world. Returns the bounding-sphere radius
 *  the depth-fade band is written in. */
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
