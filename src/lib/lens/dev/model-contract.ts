// ============================================================================
// Model-contract tripwire (dev-only): assert at load every structural
// assumption the code makes about the GLBs, so a lens_work re-export that
// breaks one fails LOUDLY at boot instead of surfacing weeks later as a
// silent no-op, a mis-styled part, or a NaN. Report-only: violations are
// console.error'd, never thrown — a broken contract should scream, not brick
// the bench. Wired from core/scene.ts behind import.meta.env.DEV.
//
// The required-name list is DERIVED from the two code-side tables that address
// parts BY NAME — the mechanism's drive table (ops/mechanism MECHANISM_PARTS)
// and the bolted-hardware adoption map (ops/frames SHELL_ADOPT). If the code
// stops needing a name, the tripwire fails loudly and gets updated: the safe
// drift direction, unlike a silently incomplete hand-list. Nothing about the
// explode ladder is listed any more — it is DERIVED from geometry (frames.ts),
// so there is no authored tier table left to keep honest.
//
// ORDERING: run this AFTER ops/frames deriveFrames (core/scene.ts's
// prepareModelMaterials) — the second half of the contract reads the frame
// attributes that pass stamps.
// ============================================================================
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
/** parts.ts documents "the 13 lens elements" — a changed count means the
 *  optics grouping (isolate, refraction ray path) no longer matches. */
const GLASS_ELEMENT_MESHES = 13;
/** Floor on the DERIVED explode ladder's group count. Nothing here re-authors
 *  the tier names (that is exactly the hand-list frames.ts replaced) — it only
 *  asserts the derivation still found a ladder's worth of them. A re-export that
 *  drops whole part groups (a renamed prefix, a collapsed hierarchy) shows up as
 *  a COUNT collapse long before it shows up as a visibly wrong explode.
 *
 *  2026-08-12, lens_work MIGRATION STEP 5: the shipped body derives 26 groups,
 *  down from 31 — five parts were re-parented onto the hosts they are fastened
 *  to (PCB_Components → PCB_Rear, Mount_Contacts → Mount_ContactShelf, the three
 *  screw sets → Mount_Bayonet) and now ride those rungs. The floor moves 25 → 20
 *  rather than to 25 again: a floor one below the count fails on the next
 *  intended merge, and this tripwire is for a COLLAPSE (a whole family losing
 *  its names), not for the model's ordinary consolidation. 20 still catches
 *  anything that halves the ladder. The derivation is measured against the
 *  actual file in ops/__tests__/frames.test.ts, which is where an exact count
 *  belongs. */
const LADDER_GROUPS_MIN = 20;
/** Cap on how many same-kind offenders get named before the report summarizes:
 *  a systematic break (a whole pass that didn't run) would otherwise print one
 *  line per mesh and bury everything else. */
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
 *  The accessories MERGE into the body's scene graph, so a body-scope traversal
 *  reaches them; only the ancestor walk can tell them apart (an accessory's
 *  sub-meshes carry generic names). */
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

/** The DERIVED half of the contract: after ops/frames has measured the model,
 *  every renderable mesh must carry a frame, the sector span the sheet ops
 *  normalize theta over must be positive, and the derived explode ladder must
 *  still have a ladder's worth of groups. A zero span is a NaN source for every
 *  op that normalizes over it — detected once at boot instead of guarded per op.
 *
 *  R (the radius every cylindrical op normalizes over) is NOT checked: frames.ts
 *  floors it at R_MIN on the way out, so a `R > 0` branch here is unreachable by
 *  construction — the guard belongs at the derivation, and it is there. */
function frameViolations(
  root: THREE.Object3D,
  frames: DerivedFrames,
): string[] {
  // ACCESSORIES ARE NOT THIS SCOPE'S BUSINESS — and checking them here is a
  // RACE. They load in the background and merge into the same scene graph, then
  // get their own scoped deriveFrames + material pass (core/scene.ts's
  // accessoriesReady handler, which re-runs deriveFrames and unified.integrate).
  // This report runs off a DYNAMIC IMPORT, so its
  // resolution can land after the merge but before that pass, and every
  // accessory mesh would then read as "carries no derived frame" — a false
  // alarm on a healthy model. The accessory scope below checks them instead: it
  // runs off the SAME promise, and its handler is registered strictly later
  // than scene.ts's (which is registered synchronously at init), so the frame
  // pass has provably run by then.
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

/** Run the tripwire on a loaded, FRAMED model: the body immediately, the
 *  accessories once their background load lands (accessoriesReady must be the
 *  never-rejecting handle — scene.ts's caught version). `frames` is deriveFrames'
 *  own return value, passed through rather than re-read off window.__lensOps —
 *  the contract must not depend on a dev probe existing. */
export function reportModelContract(
  model: LensModel,
  frames: DerivedFrames,
): void {
  report("body", [
    ...bodyViolations(model.scene),
    ...frameViolations(model.scene, frames),
  ]);
  // A load that never asked for the accessories GLB (the hero) has no accessory
  // scope to check — the parts are legitimately absent.
  if (!model.hasAccessories) return;
  void model.accessoriesReady.then(() => {
    const missing = ACCESSORY_PARTS.filter(
      (n) => !model.scene.getObjectByName(n),
    );
    // The frame half of the accessory contract, deferred to here for the
    // ordering reason in frameViolations: by now core/scene's own
    // accessoriesReady handler has run each accessory root through deriveFrames
    // and folded it into the merged material (unified.integrate), so an unframed
    // accessory mesh is a real derivation failure.
    const roots = ACCESSORY_PARTS.map((n) => model.scene.getObjectByName(n));
    report("accessories", [
      ...missing.map((n) => `accessory missing: ${n}`),
      ...roots.flatMap((r) => (r ? frameScan(r, () => false) : [])),
    ]);
  });
}
