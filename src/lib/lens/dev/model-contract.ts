// Dev only — dynamically imported. A model-contract tripwire: assert at load
// every structural assumption the code makes about the GLBs. Report-only —
// violations are console.error'd, never thrown. The required-name list is
// derived from the two code-side tables that address parts by name
// (MECHANISM_PARTS and SHELL_ADOPT).
//
// Ordering: run after ops/frames deriveFrames — the second half of the contract
// reads the frame attributes that pass stamps.
import * as THREE from "three/webgpu";
import { MECHANISM_PARTS } from "../ops/mechanism";
import { SHELL_ADOPT, frameOf, type DerivedFrames } from "../ops/frames";
import { isAccessory, isGlassElement, isSegWedge } from "../core/parts";
import type { LensModel } from "../core/model";

/** Every node the code addresses by name: the mechanism's own parts plus the
 *  hosts and features of the shell-adoption map. */
const REQUIRED_PARTS: readonly string[] = [
  ...MECHANISM_PARTS,
  ...Object.keys(SHELL_ADOPT),
  ...Object.values(SHELL_ADOPT).flat(),
];
/** The accessories GLB's five parts (model.ts FRONT_ACCESSORIES + rear cap —
 *  cinematics and the accessory toggles address them by these names). */
const ACCESSORY_PARTS = [
  "Acc_Hood",
  "Acc_Filter_Glass",
  "Acc_Filter_Ring",
  "Acc_CapFront",
  "Acc_CapRear",
] as const;
/** A changed count means the optics grouping (isolate, refraction ray path) no
 *  longer matches. */
const GLASS_ELEMENT_MESHES = 13;
/** Floor on the derived explode ladder's group count, so a re-export that
 *  drops whole part families shows up as a count collapse. Kept well below the
 *  live count so ordinary consolidation does not trip it. */
const LADDER_GROUPS_MIN = 20;
/** Cap on how many same-kind offenders get named before the report
 *  summarizes. */
const NAME_CAP = 8;

const named = (names: string[]): string =>
  names.length <= NAME_CAP
    ? names.join(", ")
    : `${names.slice(0, NAME_CAP).join(", ")} … (+${names.length - NAME_CAP} more)`;

function bodyViolations(root: THREE.Object3D): string[] {
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
  return v;
}

/** True if this node — or anything above it — is an accessory root (`Acc_*`).
 *  The accessories merge into the body's scene graph, so only the ancestor walk
 *  can tell them apart (their sub-meshes carry generic names). */
function underAccessory(o: THREE.Object3D): boolean {
  for (let a: THREE.Object3D | null = o; a; a = a.parent)
    if (isAccessory(a.name)) return true;
  return false;
}

/** The per-mesh half of the frame check, over whatever scope is handed in.
 *  `skip` drops meshes this scope is not responsible for. */
function frameScan(
  root: THREE.Object3D,
  skip: (o: THREE.Object3D) => boolean,
): string[] {
  const v: string[] = [];
  const unframed: string[] = [];
  const badSpan: string[] = [];
  root.traverse((o) => {
    // deriveFrames' own precondition: no position attribute, nothing to measure
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

/** The derived half of the contract: every renderable mesh must carry a frame,
 *  the sector span the sheet ops normalize theta over must be positive (a zero
 *  span is a NaN source), and the ladder must still have a ladder's worth of
 *  groups. R is not checked — frames.ts floors it at R_MIN. */
function frameViolations(
  root: THREE.Object3D,
  frames: DerivedFrames,
): string[] {
  // Accessories are not this scope's business: they merge into the scene graph
  // before their own scoped deriveFrames pass, so checking here would race and
  // read them as unframed. The accessory scope below checks them off the same
  // promise, with its handler registered later than scene.ts's.
  const v: string[] = frameScan(root, underAccessory);
  if (frames.ladderRungs.size < LADDER_GROUPS_MIN)
    v.push(
      `derived explode ladder has ${frames.ladderRungs.size} group(s) (expected ≥ ${LADDER_GROUPS_MIN}) — whole part groups went missing`,
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

/** Run the tripwire on a loaded, framed model: the body immediately, the
 *  accessories once their background load lands. `frames` is passed through
 *  rather than re-read off a dev probe. */
export function reportModelContract(
  model: LensModel,
  frames: DerivedFrames,
): void {
  report("body", [
    ...bodyViolations(model.scene),
    ...frameViolations(model.scene, frames),
  ]);
  // A load that never asked for the accessories GLB has no accessory scope to
  // check — the parts are legitimately absent.
  if (!model.hasAccessories) return;
  void model.accessoriesReady.then(() => {
    const missing = ACCESSORY_PARTS.filter(
      (n) => !model.scene.getObjectByName(n),
    );
    // The frame half of the accessory contract: core/scene's own handler has
    // run by now, so an unframed accessory mesh is a real derivation failure.
    const roots = ACCESSORY_PARTS.map((n) => model.scene.getObjectByName(n));
    report("accessories", [
      ...missing.map((n) => `accessory missing: ${n}`),
      ...roots.flatMap((r) => (r ? frameScan(r, () => false) : [])),
    ]);
  });
}
