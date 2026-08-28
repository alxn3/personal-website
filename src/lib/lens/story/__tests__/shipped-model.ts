// THE SHIPPED MODEL, READ AND FRAMED IN NODE — the fixture piece-flow.test.ts
// and story-ending.test.ts both measure against.
//
// The GLB's vertices are plain float32 accessors in the BIN chunk, so this
// slices them straight out and rebuilds the shipped node graph — names,
// parenting, transforms, positions and indices — then runs the real
// `deriveFrames` over it. That is the same measurement pass the browser runs at
// load, on the same bytes, so the roster here IS the browser's roster.

import { readFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { deriveFrames } from "../../ops/frames";
import { isAccessory } from "../../core/parts";

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
 *  5126 for POSITION and 5123 for indices; the other two are here so a re-export
 *  that widens an index buffer past 65535 reads correctly instead of silently
 *  mis-slicing the BIN chunk. */
const COMPONENT = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const PER_ELEMENT: Record<string, number> = { SCALAR: 1, VEC3: 3 };

/** One accessor as a typed array over the BIN chunk. The bytes are COPIED, not
 *  viewed: a bufferView's offset in the file need not be aligned to the
 *  component size, and a misaligned typed-array view over the shared buffer
 *  throws. Interleaved bufferViews (`byteStride`) would need a strided gather
 *  and these exports are tightly packed, so that case is refused loudly. */
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
  return root;
}

/** core/scene.ts's placement of that graph, so a mesh's `matrixWorld` maps its
 *  own local millimetres to the WORLD the story's camera is posed in: the bore
 *  onto +X, mm to world units, and the bare lens' visual centre recentred on
 *  the origin. Returns the measured bounding-sphere radius with it — the ruler
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
