import * as THREE from "three/webgpu";
import {
  hasBloom,
  seatRankOf,
  addShellBloomAttributes,
  gatherShellBloom,
  uBloom,
  uUnwrap,
  uRewrap,
  uRewrapOn,
  uCurl,
  uShear,
  uCardify,
  BLOOM_DILATION,
  REWRAP_STAGGER,
  REWRAP_WINDOW,
} from "../materials/bloom";
import {
  uHelix,
  uAssemble,
  uRollout,
  uAssembleDepth,
  assembleFlightState,
} from "../materials/formation";
import { uGenie, updateGenieFrame } from "../materials/genie";
import { deg, smoothstep } from "./math";
import { isRigExempt, isSegWedge } from "./parts";

// ============================================================================
// The mechanism rig: everything that MOVES parts of the lens model — zoom,
// focus, aperture, and the exploded teardown. The constants follow
// lens_work/lens_mechanism.md (the animation contract written against the real
// Blender model), not an invented approximation. Object names are the API (do
// not rename); the group empties (Optics_G2..G5, Iris_Housing, Barrel_Inner)
// are the drive targets, and their child elements and iris blades ride along,
// so zoom/focus/explode compose additively on shared nodes.
// ============================================================================

// --- lens_mechanism.md §1: zoom (18 -> 50mm), one shared eased `t` ----------
// MEASURED by the owner from photo IMG_5368: the zoom marks sit at
// 0/16.2/30.8/44.9/76.6° from "18" (non-uniform cam — 35->50 is the long
// stretch), so a full-zoom throw of -76.6° lands "50" on the index. Supersedes
// the earlier -46° uniform-spacing estimate. Cam_Barrel is pinned 1:1 to it.
const ZOOM_RING_THROW_RAD = deg(-76.6);
const ZOOM_MM: Record<string, number> = {
  Barrel_Inner: 26, // MEASURED
  Optics_G2: 17,
  Optics_G3: 11,
  Iris_Housing: 14, // keeps the stop between G2/G3; blades ride as children
};

// --- lens_mechanism.md §2: focus (by-wire; ∞ -> ~0.12m) ---------------------
// Only Element_12 (L4) moves, riding Optics_G4_Focus — a flat ±1.5mm exactly as
// the Blender rig drives it (rig_lens.py: '1.5*f'), NEVER amplified. (A web-only
// ×12 explode gain was tried to make the slide read from a distance; the owner
// reverted it 2026-07-16 — it overshot wildly at max focus. The subtle 1.5mm
// slide is authentic; the ring turn and the lead screw's ~1.4 revs carry the
// visible motion.) One-directional from the neutral rest pose so 0 = infinity.
const FOCUS_RING_THROW_RAD = deg(60); // by-wire: any mapping is authentic
const FOCUS_MM: Record<string, number> = {
  Optics_G4_Focus: 1.5,
};
// lens_mechanism.md §2: the STM lead screw spins 327.3°/mm (=360/1.1 pitch) of
// element travel — ~1.36 revs over the real ±1.5mm throw. Its origin is on the
// optical axis, so it's spun about its own axis via a pivot at the screw center.
const FOCUS_SCREW_DEG_PER_MM = 327.3;

// --- lens_mechanism.md §3: aperture (f/2.8 -> f/22) -------------------------
const IRIS_CLOSE_DEG = 25.3; // build_iris.py's calibrated sweep; never exceed ~30
// lens_mechanism.md §3b: the internals-v2 aperture chain — pinion -> toothed lug
// -> cam plate -> grooves -> blade pins. Both parts rotate about the optical axis
// on the SAME eased-aperture law as the blades: e = 0.4a + 0.6a² (a = aperture).
// The actuator gear turns opposite (its gear ratio to the plate lug) and further.
const IRIS_CAMPLATE_DEG = 12;
const IRIS_ACTUATORGEAR_DEG = -92;

// --- lens_mechanism.md §4: exploded view — the owner-approved TIER ladder ----
// ORDERING and GROUPING are the art direction (full-reveal review, 2026-07-10):
// the interleave of glass and structure so nothing passes through anything, and
// which parts travel TOGETHER (one tier = one shared rung). DISTANCES are derived —
// uniform steps, the outermost tier pinned to the approved extreme. The two REACH
// anchors below are the ONLY authored distances in the ladder. Targets group
// EMPTIES for the optics (not their elements) so zoom/focus compose with explode.
// Mount hardware (screws/bores/notch/contacts/shelf) is NOT listed: it is seated
// on the bayonet shell (SHELL_FEATURES) and rides its rung. Chassis_Fixed is the
// anchor (0); Barrel_Base + Band_Mid are welded to it (ONE metal part per
// build_exterior.py / rig_lens.py) and stay unlisted so they ride it as a unit
// instead of splintering.
const EXPLODE_REACH_REAR = 70; // mm — approved rearmost extent (Mount_Bayonet)
const EXPLODE_REACH_FRONT = 95; // mm — approved frontmost extent (Barrel_Inner)

// Each tier is a group of parts that travel together (identical rung), ordered
// nearest-anchor → outermost. This ordering + grouping IS the art direction.
const EXPLODE_TIERS_REAR: readonly string[][] = [
  ["Optics_G5"],
  ["Cam_RearTube"], // segmented shell — between Baffle_Rear and Optics_G5
  ["Baffle_Rear"],
  ["Shim_Ring_0", "Shim_Ring_1"],
  ["PCB_Rear", "PCB_Components"], // one board + its parts — travel together
  ["Mount_EncoderStrip"],
  ["Mount_ChassisPlate"], // segmented shell — blooms in-shader, this is its axial rung
  ["Mount_BrassRing"],
  ["Mount_Bayonet"],
];
const EXPLODE_TIERS_FRONT: readonly string[][] = [
  ["Optics_G4_Focus"],
  ["Focus_LeadScrew", "Ring_Focus"], // focus cluster reads together (screw applied in update())
  ["Optics_G3"],
  ["Iris_Housing"], // blades ride
  ["Ring_Zoom"],
  ["Cam_OpticsCage"], // segmented shell — between Ring_Zoom and Cam_LightTrap
  ["Cam_LightTrap"],
  ["Cam_Barrel"],
  ["Optics_G2"],
  ["Barrel_Inner"], // carries Element_01/02 (+ their extra local fan below)
];

// rung(part) = direction × REACH × (tierIndex+1)/tierCount — uniform steps with
// the outermost tier landing exactly on the approved extreme.
const tierRungs = (
  tiers: readonly string[][],
  direction: number,
  reach: number,
): Record<string, number> => {
  const rungs: Record<string, number> = {};
  tiers.forEach((tier, i) => {
    const rung = (direction * reach * (i + 1)) / tiers.length;
    for (const name of tier) rungs[name] = rung;
  });
  return rungs;
};
const EXPLODE_RUNGS: Record<string, number> = {
  ...tierRungs(EXPLODE_TIERS_REAR, -1, EXPLODE_REACH_REAR),
  ...tierRungs(EXPLODE_TIERS_FRONT, 1, EXPLODE_REACH_FRONT),
};
// The lead screw is the one genuinely-loose (pivoted) part: it shares FRONT tier 2
// with Ring_Focus so its axial rung derives from the same table, but it is applied
// in update() alongside its pivot/radial expansion, NOT as a posRider — so it is
// split out of the posRider rung map.
const SCREW_EXPLODE_MM = EXPLODE_RUNGS.Focus_LeadScrew;
const EXPLODE_MM: Record<string, number> = Object.fromEntries(
  Object.entries(EXPLODE_RUNGS).filter(([n]) => n !== "Focus_LeadScrew"),
);
// The ladder's optional extra fan for the front elements, LOCAL on Barrel_Inner
// (doc: "optionally fan Element_01/02 a further +6/+12"). One authored step; the
// two elements index off it (E02 = 1× step, E01 = 2×).
const FRONT_FAN_STEP = 6;
const FRONT_FAN_MM: Record<string, number> = {
  Element_02: 1 * FRONT_FAN_STEP,
  Element_01: 2 * FRONT_FAN_STEP,
};
// Radial explode is handled ENTIRELY in-shader (materials/bloom's uK dilation +
// uSeparate per-piece slide). There used to be an additional object-space radial
// scale on the posRider shells (RING_SCALE) layered on top — removed: it double-
// exploded only SOME shells (posRiders flew ~3× further than the chassis/PCB
// shells), stretched every ring's tube cross-section into an oval, ballooned the
// iris blades, and forced a counter-scale hack on the front glass. One system,
// uniform rates, true cross-sections.
// Loose parts (only the off-axis focus lead screw now) expand radially IN PROPORTION
// to their radius — the same proportional rate as the shader's uK dilation — so the
// screw opens up with the shells instead of outrunning or lagging them. That's why
// the rate IS materials/bloom's dilation constant, not a lookalike number.
const LOOSE_EXPAND = BLOOM_DILATION;
// ONE gain scales the whole ladder ("scale it by the scrub") — relative art
// direction is preserved while the full spread fits the web framing; sized so the
// complete glass column (E01 riding the barrel head → E13) stays inside the
// light-path scene's frame, portrait included.
const EXPLODE_AXIAL_GAIN = 0.4;

// Non-segmented features that live in their OWN mesh but are bolted to a
// segmented shell (mount hardware on the bayonet; the focus motor + guide rods
// on the fixed chassis) aren't part of the shell that blooms in-shader. Left
// alone they'd fall through to the loose-parts pass and get flung off the axis —
// detaching from the shell they belong to.
const SHELL_FEATURES: Record<string, string[]> = {
  Mount_Bayonet: [
    "Mount_Screws",
    "Mount_FlangeScrews",
    "Mount_ScrewBores",
    "Mount_Notch",
    "Mount_ContactShelf",
    "Mount_Contacts",
  ],
  Chassis_Fixed: ["Focus_Motor", "Focus_GuideRods"],
};

/**
 * Seat each shell-mounted feature: give it its shell's wedge bloom attributes
 * and reparent it under that shell, so it dilates/twists in lock-step and stays
 * SEATED as the shell fans open. MUST run before applyBloom() so these meshes
 * pick up the bloom node material too.
 */
export function seatShellFeatures(gltfScene: THREE.Object3D): void {
  for (const [shellName, features] of Object.entries(SHELL_FEATURES)) {
    const shell = gltfScene.getObjectByName(shellName);
    if (!shell) continue;
    const { centers, R } = gatherShellBloom(shell);
    for (const nm of features) {
      const feature = gltfScene.getObjectByName(nm);
      if (!feature) continue;
      feature.traverse((o) => {
        if (o instanceof THREE.Mesh)
          addShellBloomAttributes(o.geometry, centers, R);
      });
      shell.attach(feature); // ride the shell's explode transform (preserves world)
    }
  }
}

/** One frame's mechanism inputs. All are the EASED 0..1 values (tick owns the
 *  easing, and `zoom` additionally arrives pre-smoothstepped — the ONE shared
 *  zoom ease, applied in core/scene). */
export interface RigDrive {
  zoom: number;
  focus: number;
  aperture: number;
  explode: number;
  unwrap: number;
  /** `rewrap`/`rewrapOn` drive the layer-by-layer reassembly: with rewrapOn
   *  engaged, each part seats on its own staggered timeline as rewrap scrubs
   *  0→1 (shader shells by radius rank; the axial ladder here by rung size). */
  rewrap: number;
  rewrapOn: number;
  curl: number;
  shear: number;
  /** Independent helix-assemble spread: 0 = seated, 1 = fully spread formation.
   *  Only bloom-carrying wedge/decal pieces fly; the shader owns the per-wedge
   *  stagger + snap (materials/formation uHelix). Zero contribution at 0. */
  helix: number;
  /** Independent ops-built reassembly spread: 0 = seated, 1 = fully disassembled.
   *  A second formation preset (materials/formation uAssemble), the A/B alternative to
   *  the rewrap reassembly. Zero contribution at 0. */
  assemble: number;
  /** Independent rolling-contact unroll: 0 = seated, 1 = rolled out flat. A
   *  shader-only formation preset (materials/formation uRollout). Zero at 0. */
  rollout: number;
  /** Cardify morph: 0 = untouched, 1 = unwrapped sheets squared into photo
   *  cards. Shader-only (materials/bloom uCardify); bit-exact at 0. */
  cardify: number;
  /** Genie minimize: 0 = rest, 1 = the whole model funneled into the dock
   *  target. Shader-only (materials/genie uGenie); bit-exact at 0. */
  genie: number;
}

export interface LensRig {
  /** Drive every mechanism for one frame (see RigDrive for input semantics). */
  update(drive: RigDrive): void;
}

/**
 * Resolve every driven node and build the per-frame mechanism drive. Call AFTER
 * seatShellFeatures + applyBloom and after the model is recentred (the lead-screw
 * pivot math reads world positions).
 */
export function createRig(gltfScene: THREE.Object3D): LensRig {
  // Node lookups (undefined if lens_work hasn't modeled that part yet — every
  // use site guards for it).
  const node = (name: string) => gltfScene.getObjectByName(name);

  const ringZoom = node("Ring_Zoom");
  const ringFocus = node("Ring_Focus");
  // The helical cam barrel is pinned 1:1 to the zoom ring (rotates with it); it
  // reads as the internal mechanism turning as the teardown fans the shells apart.
  const camBarrel = node("Cam_Barrel");
  // Iris_Housing is a segmented shell (it blooms in-shader), so it is NOT flung
  // whole — its zoom axial motion (posRiders) is kept, and the blades ride the
  // housing and stay revealed on the axis.
  const irisBlades: THREE.Object3D[] = [];
  for (let i = 1; i <= 7; i++) {
    const blade = node(`Iris_Blade_${String(i).padStart(2, "0")}`);
    // Blade overlap/z-fight is solved IN THE MODEL: each blade is baked with a
    // 0.5° tilt about its pivot's radial axis (build_iris.py B.4 — a JS z-ladder
    // was tried and rejected; it reads wrong from the back). Nothing to do here.
    if (blade) irisBlades.push(blade);
  }
  // Iris drive parts (internals-v2): they ride Iris_Housing's zoom/explode via the
  // hierarchy (children of it) and match the /^Iris_/ loose-parts exemption, so
  // they're never flung — only their aperture rotation is driven here, exactly
  // like the blades. undefined if lens_work hasn't modeled them.
  const irisCamPlate = node("Iris_CamPlate");
  const irisActuatorGear = node("Iris_ActuatorGear");

  // The front glass (Element_01/02) rides Barrel_Inner (zoom extension + the
  // barrel's +95 explode rung); the ladder's optional LOCAL fan spreads the two
  // elements a further +12/+6 out of the barrel head so they read individually.
  const frontGlass = Object.entries(FRONT_FAN_MM)
    .map(([n, fan]) => ({ obj: node(n), fan }))
    .filter((e): e is { obj: THREE.Object3D; fan: number } => Boolean(e.obj))
    .map((e) => ({ obj: e.obj, fan: e.fan, basePos: e.obj.position.clone() }));
  // The front elements ride Barrel_Inner, so they seat on ITS rank. Resolved once —
  // seatRankOf walks geometry and must never run per frame.
  const barrelInner = node("Barrel_Inner");
  const frontRank = barrelInner ? seatRankOf(barrelInner) : 1;

  // Every node driven by a position channel, with its contribution from each
  // of the three additive sources. Resolved once here; summed each frame.
  const posNames = new Set([
    ...Object.keys(ZOOM_MM),
    ...Object.keys(FOCUS_MM),
    ...Object.keys(EXPLODE_MM),
  ]);
  const posRiders = [...posNames]
    .map((name) => ({ obj: node(name), name }))
    .filter((e): e is { obj: THREE.Object3D; name: string } => Boolean(e.obj))
    .map(({ obj, name }) => ({
      obj,
      zoom: ZOOM_MM[name] ?? 0,
      focus: FOCUS_MM[name] ?? 0,
      explode: EXPLODE_MM[name] ?? 0,
      // Seat rank on the SHADER's radius-order law (materials/bloom seatRankOf),
      // not on this part's ladder rung: the rung says how FAR it travels, which is
      // a different question from WHEN it seats. Sharing one law is what keeps a
      // solid and its own shell's wedges on the same beat.
      seatRank: seatRankOf(obj),
    }));

  // Loose non-glass parts not driven by any rig or shell. Almost everything now
  // rides a shell (mount hardware → bayonet, motor/rods → chassis) and blooms with
  // it; the only remaining loose part is the off-axis focus lead screw. On explode
  // each expands radially in proportion to its radius (see update()), opening up
  // at the shells' rate rather than being flung clear. `spin` opts a part into
  // the explode tumble — false for the screw pivot, whose rotation.y is owned by
  // the focus drive (the screw's authentic "unthreading" motion IS that spin).
  const looseParts: {
    obj: THREE.Object3D;
    base: THREE.Vector3;
    spin: boolean;
  }[] = [];
  const worldC = new THREE.Vector3();

  // Focus lead screw: an off-axis rod. Wrap it in a pivot at its own centre so it
  // can spin about ITS OWN axis with focus rather than orbiting the lens; the
  // pivot itself expands radially on explode like the other loose parts.
  const screwPivot = (() => {
    const screw = node("Focus_LeadScrew");
    if (!screw) return null;
    new THREE.Box3().setFromObject(screw).getCenter(worldC);
    const c = gltfScene.worldToLocal(worldC.clone()); // screw axis in model space
    const pivot = new THREE.Group();
    pivot.name = "Focus_LeadScrew_Pivot";
    pivot.position.copy(c);
    (screw.parent ?? gltfScene).add(pivot);
    pivot.add(screw);
    screw.position.sub(c); // keep the screw geometry where it was
    looseParts.push({ obj: pivot, base: c.clone(), spin: false });
    return pivot;
  })();
  // Same one-shot resolution as frontRank (see above).
  const screwRank = screwPivot ? seatRankOf(screwPivot) : 1;

  gltfScene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (posNames.has(o.name)) return; // already moved by the explode rig
    // Anything that blooms in-shader (a shell wedge OR a feature seated on a
    // shell, e.g. the mount hardware) deforms WITH its shell and must NOT be flung.
    if (hasBloom(o)) return;
    // skip glass, decals, accessories, the iris (isRigExempt), the pivoted lead
    // screw, anything nested inside a wedge (isSegWedge — multi-material wedges
    // have sub-meshes whose names don't match; the wedges deform in-shader via the
    // bloom graph), and anything parented under a driven group empty (posNames —
    // the internals-v2 cell/carrier/follower solids ride their empty's zoom/focus/
    // explode via the hierarchy and must not also be flung loose).
    for (let anc: THREE.Object3D | null = o; anc; anc = anc.parent) {
      if (
        isRigExempt(anc.name) ||
        isSegWedge(anc.name) ||
        posNames.has(anc.name) ||
        anc.name === "Focus_LeadScrew"
      )
        return;
    }
    looseParts.push({ obj: o, base: o.position.clone(), spin: true });
  });

  // Per-part spin: as the teardown fans out, the loose hardware slowly rotates
  // about the optical axis (an "unthreading" tumble) — proportional to explode so
  // it unwinds cleanly on reassembly.
  const looseBaseRotY = looseParts.map((p) => p.obj.rotation.y);
  const looseSpin = looseParts.map((_, i) => {
    const h = Math.sin(i * 91.7) * 43758.5453;
    return (h - Math.floor(h) - 0.5) * 2.4; // ±1.2 rad
  });

  function update({
    zoom: zoomT,
    focus: focusT,
    aperture: apertureT,
    explode: explodeT,
    unwrap: unwrapT,
    rewrap: rewrapT,
    rewrapOn: rewrapOnT,
    curl: curlT,
    shear: shearT,
    helix: helixT,
    assemble: assembleT,
    rollout: rolloutT,
    cardify: cardifyT,
    genie: genieT,
  }: RigDrive) {
    // per-part rewrap settle: the part's own seat progress on the shared scrub —
    // the SAME stagger law (REWRAP_STAGGER/WINDOW) as the shader's per-shell
    // timeline, so ladder parts and shells seat in lock-step
    const settle = (rank: number) =>
      rewrapOnT *
      smoothstep(0, 1, (rewrapT - rank * REWRAP_STAGGER) / REWRAP_WINDOW);

    // Shell wedges deform in-shader on the single bloom channel: explode drives
    // the radial dilation + per-piece slide, unwrap peels them flat. Every wedge
    // (former window and non-window alike) blooms the same way now. MUST be set
    // before the ladder loop: assembleFlightState() below reads uAssemble.value.
    uBloom.value = explodeT;
    uUnwrap.value = unwrapT;
    uRewrap.value = rewrapT;
    uRewrapOn.value = rewrapOnT;
    uCurl.value = curlT;
    uShear.value = shearT;
    // Independent formation spread — the shader derives every per-wedge stagger,
    // snap and over-coil from this alone; 0 leaves the seated render bit-exact.
    uHelix.value = helixT;
    uAssemble.value = assembleT;
    // Shader-only rolling-contact unroll (no rig ladder — the shell rolls out in
    // place); 0 leaves the seated render bit-exact.
    uRollout.value = rolloutT;
    // Shader-only cardify morph (sheets → photo cards); bit-exact at 0.
    uCardify.value = cardifyT;
    // Shader-only genie minimize funnel (materials/genie); bit-exact at 0.
    // The warp runs in the TRUE model frame, so its frame uniforms follow the
    // live gltf root (setModelOrientation, transitions) every driven frame.
    uGenie.value = genieT;
    updateGenieFrame(gltfScene);

    // Assemble channel drives the RIG ladder too, so the whole object flies as one
    // composition: each part takes its full tier-ladder explode rung × the shared
    // gain × the flight state, which flows off the SAME gate law as the shader
    // wedges (assembleFlightState is the JS mirror). Depth is scaled by the "Depth"
    // slider (uAssembleDepth). At assemble = 0 the flight state is exactly 0 for
    // every rank, so the whole term vanishes and the seated ladder is untouched.
    const depthScale = uAssembleDepth.value;

    // Everything on the ladder — glass AND structure — translates axially by its
    // approved rung × the shared gain; the shells' RADIAL motion stays in-shader
    // (bloom dilation, per-piece slide), composing on top of this axial spread.
    // Focus travel is the rig-authentic flat ±1.5mm (see FOCUS_MM) — no gain.
    for (const r of posRiders) {
      const explodeEff = explodeT * (1 - settle(r.seatRank));
      const axial =
        zoomT * r.zoom +
        focusT * r.focus +
        explodeEff * r.explode * EXPLODE_AXIAL_GAIN +
        assembleFlightState(r.seatRank) *
          r.explode *
          EXPLODE_AXIAL_GAIN *
          depthScale;
      r.obj.position.set(0, axial, 0);
    }

    // Front elements' extra LOCAL fan out of the barrel head (ladder option) — they
    // ride Barrel_Inner, so they seat on ITS rank and fly home on its assemble flight.
    const frontEff = explodeT * (1 - settle(frontRank));
    const frontFlight = assembleFlightState(frontRank) * depthScale;
    for (const g of frontGlass) {
      g.obj.position.set(
        g.basePos.x,
        g.basePos.y + (frontEff + frontFlight) * g.fan * EXPLODE_AXIAL_GAIN,
        g.basePos.z,
      );
    }

    // Loose parts (only the focus lead screw now) expand radially IN PROPORTION to
    // their radius — matching the shells' bloom-dilation rate — instead of a fixed
    // fling that outruns everything. base.xz is the radial plane (optical axis = Y),
    // so scaling x/z about the origin moves the part straight out from the axis.
    const screwEff =
      explodeT * (1 - settle(screwRank)) +
      assembleFlightState(screwRank) * depthScale;
    const looseExpand = 1 + screwEff * LOOSE_EXPAND;
    const screwAxial = screwEff * SCREW_EXPLODE_MM * EXPLODE_AXIAL_GAIN; // its ladder rung
    looseParts.forEach((p, k) => {
      p.obj.position.set(
        p.base.x * looseExpand,
        p.base.y + (p.spin ? 0 : screwAxial),
        p.base.z * looseExpand,
      );
      // explode tumble — skipped for non-spin entries (the focus lead screw pivot),
      // whose rotation.y is owned by the focus drive below; stomping it here would
      // erase the screw's 327.3°/mm focus spin.
      if (p.spin) p.obj.rotation.y = looseBaseRotY[k] + looseSpin[k] * explodeT;
    });

    if (ringZoom) ringZoom.rotation.y = zoomT * ZOOM_RING_THROW_RAD;
    // Cam barrel is pinned 1:1 to the zoom ring — same angle, same sign.
    if (camBarrel) camBarrel.rotation.y = zoomT * ZOOM_RING_THROW_RAD;
    if (ringFocus) ringFocus.rotation.y = focusT * FOCUS_RING_THROW_RAD;

    // Lead screw spins about its own axis with focus — 327.3°/mm of the authentic
    // element travel, ~1.4 revolutions over the full throw (plainly visible even
    // though the element's own 1.5mm slide is subtle).
    if (screwPivot) {
      const travelMm = focusT * FOCUS_MM.Optics_G4_Focus;
      screwPivot.rotation.y = deg(FOCUS_SCREW_DEG_PER_MM * travelMm);
    }

    const closeRad = deg(IRIS_CLOSE_DEG * apertureT);
    for (const blade of irisBlades) blade.rotation.y = closeRad;
    // Aperture chain (§3b): cam plate + actuator gear rotate on the eased-aperture
    // law e = 0.4a + 0.6a², about the same axis as the blades.
    const apEase = 0.4 * apertureT + 0.6 * apertureT * apertureT;
    if (irisCamPlate) irisCamPlate.rotation.y = deg(IRIS_CAMPLATE_DEG * apEase);
    if (irisActuatorGear)
      irisActuatorGear.rotation.y = deg(IRIS_ACTUATORGEAR_DEG * apEase);
  }

  return { update };
}
