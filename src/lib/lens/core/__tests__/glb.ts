import { readFileSync } from "node:fs";

// The one .glb reader the tests share: the glTF JSON and BIN chunks, plus
// accessors as typed arrays.

export const MODEL = "public/models/lens_web_segmented.glb";
export const ACCESSORIES = "public/models/lens_web_accessories.glb";

export interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
  }[];
  meshes: {
    name?: string;
    primitives: { attributes: Record<string, number>; indices?: number }[];
  }[];
  materials?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
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

/** The glTF JSON and BIN chunks of a .glb. */
export function glb(path: string): { json: Gltf; bin: Buffer } {
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

/** Every node name in a .glb. */
export const glbNodeNames = (path: string): string[] =>
  glb(path).json.nodes.map((n) => n.name);

/** glTF `componentType` → the typed array that reads it. */
const COMPONENT = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const PER_ELEMENT: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
};

/** One accessor as a typed array, copied (offsets may be unaligned).
 *  Interleaved views are refused. */
export function accessor(json: Gltf, bin: Buffer, i: number) {
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
