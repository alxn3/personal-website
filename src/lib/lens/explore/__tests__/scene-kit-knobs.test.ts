import { describe, expect, it, vi } from "vitest";
import { recipeKnob, recipeKnobs } from "../../ops/host";
import { createDemoKit, drive, set, withKit } from "../scene-kit";
import { DEMOS } from "../demos";
import type { DemoApi, LensDemo } from "../demos";

// scene-kit is pure TS, but createDemoKit's reduced-motion probe reads window.
(globalThis as unknown as { window: unknown }).window ??= {
  matchMedia: () => ({ matches: false }),
};

/**
 * The kit's auto-restore of UNIFORM writes (`set`) — the one undo class whose
 * inverse is a MEASURED prior rather than a constant rest value.
 *
 * Everything else the kit records (pose, background, orientation, isolate,
 * shading, wipe, text) inverts to a fixed rest value, so a skipped or repeated
 * undo still lands the bench at rest: those writes SELF-HEAL on the next
 * selection. A `set()` undo does not — if it is ever skipped, the box stays
 * dirty AND the next demo's `set()` snapshots the dirty value as its "prior",
 * baking the leak in until reload. Since demos write their knobs FIRST in
 * enter() they are undone LAST, which makes them the exact writes any
 * interruption of the undo chain strands. Hence these tests.
 */

const fakeApi = (over: Partial<DemoApi> = {}): DemoApi =>
  ({
    state: new Proxy({} as Record<string, number>, {
      get: (t, k) => (typeof k === "string" ? (t[k] ?? 0) : undefined),
      set: (t, k, v) => ((t[k as string] = v as number), true),
    }),
    scene: new Proxy(
      {},
      {
        get: (_t, k) => (k === "getShading" ? () => "realistic" : () => {}),
      },
    ),
    setPageWipe() {},
    setPageText() {},
    ...over,
  }) as unknown as DemoApi;

/** Every recipe knob's live value — the bench state a demo must leave pristine. */
const knobState = () => {
  const out: Record<string, number> = {};
  for (const [recipe, ks] of Object.entries(recipeKnobs()))
    for (const [knob, u] of Object.entries(ks))
      out[`${recipe}.${knob}`] = u.value;
  return out;
};

describe("scene-kit: uniform writes restore", () => {
  it("restores a plain { value } box on restore()", () => {
    const kit = createDemoKit(fakeApi());
    const box = { value: 0.2 };
    kit.begin();
    withKit(kit.api, () => set(box, 0.45));
    expect(box.value).toBe(0.45);
    kit.restore();
    expect(box.value).toBe(0.2);
  });

  it("restores a live recipe-knob view (the demos' mask targets)", () => {
    const kit = createDemoKit(fakeApi());
    const rankLo = recipeKnob("rollout", "rankLo");
    const before = rankLo.value;
    kit.begin();
    withKit(kit.api, () => set(rankLo, 0.45));
    expect(rankLo.value).toBe(0.45);
    kit.restore();
    expect(rankLo.value).toBe(before);
  });

  it("keeps every knob pristine across select → scrub → None, per demo", () => {
    const rest = knobState();
    for (const demo of DEMOS) {
      const kit = createDemoKit(fakeApi());
      kit.begin();
      withKit(kit.api, () => demo.enter());
      for (const p of [0, 0.25, 0.5, 0.75, 1])
        withKit(kit.api, () => demo.apply(p));
      withKit(kit.api, () => demo.exit?.());
      kit.restore();
      expect({ demo: demo.id, ...knobState() }).toEqual({
        demo: demo.id,
        ...rest,
      });
    }
  });

  it("restores the knobs even when an earlier undo throws", () => {
    // The undo chain runs in reverse, so a demo's knob writes are undone LAST:
    // one throwing teardown step (a page layer, a scene call) must not strand
    // them — that is the permanent, self-reinforcing leak class.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kit = createDemoKit(
      fakeApi({
        setPageText(cfg) {
          // null is the TEARDOWN call the kit's undo makes
          if (cfg === null) throw new Error("page text teardown blew up");
        },
      }),
    );
    const box = { value: 0.2 };
    kit.begin();
    withKit(kit.api, () => {
      set(box, 0.45); // recorded first ⇒ undone last
      kit.api.setPageText({ front: { text: "hi" } });
    });
    kit.restore();
    expect(box.value).toBe(0.2);
    warn.mockRestore();
  });

  it("deselecting to None runs the same teardown a demo switch runs", () => {
    // The live leak (Filmstrip → None left rollout.rankLo at 0.45) was
    // lens.astro-side ORDERING — the deselect path did not close the kit the
    // way the switch path does. vitest cannot execute that page script (it is
    // an .astro <script> against a real WebGPU scene), so this pins the
    // KIT-SIDE CONTRACT the page must call: on None, the outgoing demo's
    // exit() and the kit's restore() run exactly as on a switch, and begin()
    // still runs — a deselect must not leave a recording open for some later
    // selection to flush.
    const kit = createDemoKit(fakeApi());
    const rest = knobState();
    // lens.astro's selectDemo() teardown+setup order, transcribed. `demo` is
    // null for the None button; NOTHING here may be gated on it.
    const selectDemo = (demo: LensDemo | null, outgoing: LensDemo | null) => {
      withKit(kit.api, () => outgoing?.exit?.());
      kit.restore();
      kit.begin();
      withKit(kit.api, () => demo?.enter());
      withKit(kit.api, () => demo?.apply(0));
    };
    const film = DEMOS.find((d) => d.id === "d-filmstrip");
    if (!film) throw new Error("d-filmstrip missing from DEMOS");

    selectDemo(film, null); // ← the Filmstrip button
    expect(recipeKnob("rollout", "rankLo").value).toBe(0.45);
    selectDemo(null, film); // ← the None button
    expect(knobState()).toEqual(rest);
    // …and nothing is left recorded for a later begin() to flush: the bench is
    // already pristine when the NEXT selection opens its recording.
    kit.begin();
    expect(knobState()).toEqual(rest);
  });

  it("restores every CHANNEL drive() moved, and the value eases home to it", () => {
    // drive() is the kit's other measured-prior undo (set() is the one the
    // tests above cover), and until now nothing pinned it: a demo that drives
    // `bend` and `rollout` must leave the bench's own scrub exactly where it
    // found it. The undo restores the TARGET only — deliberately, and this is
    // the whole design: scene.ts's tick() eases each value toward its target
    // (core/scene EASE), so the bench glides back from the demo pose instead of
    // snapping on deselect. The convergence check below is that contract stated
    // as an assertion rather than a comment.
    const api = fakeApi();
    const kit = createDemoKit(api);
    // the bench's prior pose: two sliders parked mid-scrub, value ≡ target
    const PRIOR = { bend: 0.3, rollout: 0.8 };
    for (const [c, v] of Object.entries(PRIOR)) {
      (api.state as unknown as Record<string, number>)[c] = v;
      (api.state as unknown as Record<string, number>)[`${c}Target`] = v;
    }
    const read = (k: string) =>
      (api.state as unknown as Record<string, number>)[k];

    kit.begin();
    withKit(kit.api, () => {
      drive("bend", 0.1);
      drive("rollout", 0.4);
      drive("bend", 0.9); // a scrub: the SECOND write must not re-snapshot
    });
    // value AND target both written, so a scrubbed frame is a pure function of p
    expect(read("bend")).toBe(0.9);
    expect(read("bendTarget")).toBe(0.9);
    expect(read("rollout")).toBe(0.4);
    expect(read("rolloutTarget")).toBe(0.4);

    kit.restore();
    // one undo per channel, holding the FIRST prior (0.3), not the 0.1 the
    // second drive() would have snapshotted
    expect(read("bendTarget")).toBe(PRIOR.bend);
    expect(read("rolloutTarget")).toBe(PRIOR.rollout);

    // …and tick()'s ease carries the live values back to exactly those targets.
    for (let i = 0; i < 400; i++)
      for (const c of Object.keys(PRIOR))
        (api.state as unknown as Record<string, number>)[c] =
          read(c) + (read(`${c}Target`) - read(c)) * 0.12;
    expect(read("bend")).toBeCloseTo(PRIOR.bend, 12);
    expect(read("rollout")).toBeCloseTo(PRIOR.rollout, 12);
  });

  it("undoes a write recorded after restore() rather than discarding it", () => {
    // Writes can land after teardown: a shading transition's beat-synced
    // `present` re-enters the bracket from its own tick, a bind()ed async
    // callback fires late. Those go into a fresh recording that the next
    // selection's begin() used to throw away — stranding them forever.
    const kit = createDemoKit(fakeApi());
    const box = { value: 0.2 };
    kit.begin();
    kit.restore();
    withKit(kit.api, () => set(box, 0.45)); // late callback, after teardown
    kit.begin(); // next selection
    expect(box.value).toBe(0.2);
  });
});
