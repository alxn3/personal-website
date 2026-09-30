// Dev only, dynamically imported. Checks the loaded GLBs against what the code
// assumes (part names, counts, frames) and logs violations; never throws.
// Must run after ops/frames' deriveFrames.
import * as THREE from "three/webgpu";
import { MECHANISM_PARTS } from "../ops/mechanism";
import { SHELL_ADOPT, frameOf, type DerivedFrames } from "../ops/frames";
import { isAccessory, isGlassElement, isSegWedge } from "../core/parts";
import type { LensModel } from "../core/model";

/** Every node the code addresses by name. */
const REQUIRED_PARTS: readonly string[] = [
  ...MECHANISM_PARTS,
  ...Object.keys(SHELL_ADOPT),
  ...Object.values(SHELL_ADOPT).flat(),
];
/** The accessories GLB's parts, as the code names them. */
const ACCESSORY_PARTS = [
  "Acc_Hood",
  "Acc_Filter_Glass",
  "Acc_Filter_Ring",
  "Acc_CapFront",
  "Acc_CapRear",
] as const;
/** Expected number of optical glass meshes. */
const GLASS_ELEMENT_MESHES = 13;
/** Minimum explode-ladder group count; fewer means part groups went missing. */
const LADDER_GROUPS_MIN = 20;
/** How many offenders to name before summarizing. */
const NAME_CAP = 8;

const named = (names: string[]): string =>
  names.length <= NAME_CAP
    ? names.join(", ")
    : `${names.slice(0, NAME_CAP).join(", ")} … (+${names.length - NAME_CAP} more)`;

function bodyViolations(root: THREE.Object3D, frames: DerivedFrames): string[] {
  const v: string[] = [];
  const names = new Set<string>();
  let wedges = 0;
  let glass = 0;
  root.traverse((o) => {
    names.add(o.name);
    if (!(o instanceof THREE.Mesh)) return;
    if (isSegWedge(o.name)) wedges++;
    if (isGlassElement(o.name)) glass++;
  });

  for (const part of REQUIRED_PARTS)
    if (!names.has(part)) v.push(`part missing from GLB: ${part}`);

  if (wedges === 0)
    v.push("no _SegN shell wedges — the recipes have no sheets to fly");
  if (glass !== GLASS_ELEMENT_MESHES)
    v.push(
      `optical glass: ${glass} Element_* meshes (expected ${GLASS_ELEMENT_MESHES})`,
    );
  if (frames.ladderRungs.size < LADDER_GROUPS_MIN)
    v.push(
      `derived explode ladder has ${frames.ladderRungs.size} group(s) (expected ≥ ${LADDER_GROUPS_MIN}) — whole part groups went missing`,
    );
  return v;
}

/** True if this node or an ancestor is an accessory root (`Acc_*`). */
function underAccessory(o: THREE.Object3D): boolean {
  for (let a: THREE.Object3D | null = o; a; a = a.parent)
    if (isAccessory(a.name)) return true;
  return false;
}

/** Every mesh under `root` (minus `skip`) must carry a frame with span > 0. */
function frameScan(
  root: THREE.Object3D,
  skip: (o: THREE.Object3D) => boolean,
): string[] {
  const v: string[] = [];
  const unframed: string[] = [];
  const badSpan: string[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry?.getAttribute("position"))
      return;
    if (skip(o)) return;
    const name = o.name || "(unnamed)";
    const f = frameOf(o.geometry);
    if (!f) {
      unframed.push(name);
      return;
    }
    if (!(f.span > 0)) badSpan.push(`${name} (span ${f.span})`);
  });
  if (unframed.length)
    v.push(
      `${unframed.length} mesh(es) carry no derived frame: ${named(unframed)}`,
    );
  if (badSpan.length)
    v.push(
      `${badSpan.length} frame(s) with non-positive span: ${named(badSpan)}`,
    );
  return v;
}

function report(scope: string, v: string[]): void {
  if (v.length === 0) return;
  console.error(
    `[lens] model contract: ${v.length} violation(s) (${scope}) — the GLB has drifted from the code's assumptions:`,
  );
  for (const line of v) console.error(`[lens]   ${line}`);
}

/** Check the body now and the accessories once they have loaded. */
export function reportModelContract(
  model: LensModel & { hasAccessories: boolean },
  frames: DerivedFrames,
): void {
  report("body", [
    ...bodyViolations(model.scene, frames),
    // Accessories are checked separately once their own frames are derived.
    ...frameScan(model.scene, underAccessory),
  ]);
  if (!model.hasAccessories) return;
  void model.accessoriesReady.then(() => {
    const missing = ACCESSORY_PARTS.filter(
      (n) => !model.scene.getObjectByName(n),
    );
    // core/scene has framed the accessories by the time this runs.
    const roots = ACCESSORY_PARTS.map((n) => model.scene.getObjectByName(n));
    report("accessories", [
      ...missing.map((n) => `accessory missing: ${n}`),
      ...roots.flatMap((r) => (r ? frameScan(r, () => false) : [])),
    ]);
  });
}
