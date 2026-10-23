import { describe, expect, it } from "vitest";
import type { Disruption as EngineDisruption } from "@sahaay/engine";
import { apiPlan } from "../test-utils/mockApi";
import household from "./__fixtures__/household.json";
import baseline from "./__fixtures__/plan-baseline.json";
import baselineAfterReset from "./__fixtures__/plan-baseline-after-reset.json";
import planSam from "./__fixtures__/plan-sam.json";
import planSamTaylor from "./__fixtures__/plan-sam-taylor.json";
import planSamTaylorWater from "./__fixtures__/plan-sam-taylor-water.json";
import planHome from "./__fixtures__/plan-home.json";
import {
  buildMapModel,
  describeNode,
  diffTasks,
  eligiblePeople,
  neighbor,
  parseBaselineReference,
  parseHousehold,
  parsePlanView,
  recoveryCondition,
  summarizeIncident,
  type Household,
  type MapModel,
  type PlanView,
  type Reference,
} from "./model";

// ---------------------------------------------------------------------------
// Fixtures in __fixtures__ were captured from the real API (see its README).
// ---------------------------------------------------------------------------

const hh = parseHousehold(household) as Household;
const view = (raw: unknown) => parsePlanView(raw) as PlanView;
const snapshotOf = (raw: unknown): Reference => ({
  kind: "snapshot",
  label: "Before last disruption",
  view: view(raw),
});

function build(
  current: unknown,
  reference?: unknown,
  selectedKey?: string,
  h: Household = hh,
): MapModel {
  return buildMapModel(h, view(current), reference ? snapshotOf(reference) : undefined, {
    selectedKey,
  });
}
const node = (m: MapModel, key: string) => m.nodes.find((n) => n.key === key)!;
const edge = (m: MapModel, key: string) => m.edges.find((e) => e.key === key);

const SAM: EngineDisruption = { type: "person_unavailable", personId: "sam" };
const TAYLOR: EngineDisruption = { type: "person_unavailable", personId: "taylor" };
const WATER: EngineDisruption = { type: "resource_unavailable", resourceId: "water" };
const HOME: EngineDisruption = { type: "location_inaccessible", locationId: "home" };

// ------------------------------------------------------------- contract ---

describe("fixtures are faithful to the real backend", () => {
  it("the real engine reproduces every captured API payload exactly", () => {
    expect(apiPlan(household, [])).toEqual(baseline);
    expect(apiPlan(household, [SAM])).toEqual(planSam);
    expect(apiPlan(household, [SAM, TAYLOR])).toEqual(planSamTaylor);
    expect(apiPlan(household, [SAM, TAYLOR, WATER])).toEqual(planSamTaylorWater);
    expect(apiPlan(household, [HOME])).toEqual(planHome);
  });

  it("reset restores the baseline payload exactly", () => {
    expect(baselineAfterReset).toEqual(baseline);
  });
});

// -------------------------------------------------------------- parsing ---

describe("parsing", () => {
  it("reads the household model", () => {
    expect(hh.people.map((p) => p.id)).toEqual(["alex", "sam", "taylor"]);
    expect(hh.tasks.map((t) => t.id)).toEqual(["T01", "T02"]);
    expect(hh.tasks[1]!.resourceNeeds).toEqual([{ resourceId: "water", quantity: 1 }]);
    expect(hh.tasks[0]!.locationId).toBe("home");
  });

  it("tolerates missing or malformed data instead of throwing", () => {
    expect(parseHousehold(null)).toBeNull();
    expect(parseHousehold({})).toEqual({ people: [], resources: [], locations: [], tasks: [] });
    expect(parsePlanView(undefined)).toBeNull();
    expect(parsePlanView({ taskOutcomes: [{ taskId: 5 }, { taskId: "X", status: "weird" }] })?.tasks).toEqual([]);
  });

  it("reads engine task outcomes, status and summary", () => {
    const v = view(planSam);
    expect(v.source).toBe("outcomes");
    expect(v.recoveryStatus).toBe("fully_recovered");
    expect(v.disruptions).toEqual([{ type: "person_unavailable", personId: "sam" }]);
    expect(v.tasks.find((t) => t.taskId === "T01")).toMatchObject({
      status: "resolved",
      assignedPersonId: "taylor",
      baselineAssignedPersonId: "sam",
    });
    expect(v.summary?.requiredResolved).toBe(2);
  });

  it("falls back to plan fields for an older backend without taskOutcomes", () => {
    const { taskOutcomes: _o, recoveryStatus: _s, summary: _m, ...legacy } = planSamTaylor;
    const v = view(legacy);
    expect(v.source).toBe("legacy");
    expect(v.recoveryStatus).toBeUndefined();
    expect(v.tasks.find((t) => t.taskId === "T02")).toMatchObject({ status: "resolved", assignedPersonId: "alex" });
    const t01 = v.tasks.find((t) => t.taskId === "T01")!;
    expect(t01.status).toBe("unresolved");
    expect(t01.reasonCode).toBeUndefined(); // no code is invented
  });

  it("builds a baseline reference only from what the baseline plan states", () => {
    const ref = parseBaselineReference(planSamTaylor)!;
    expect(ref.kind).toBe("baseline");
    expect(ref.view.disruptions).toEqual([]);
    expect(ref.view.tasks.map((t) => [t.taskId, t.assignedPersonId])).toEqual([
      ["T01", "sam"],
      ["T02", "alex"],
    ]);
    expect(ref.view.tasks.every((t) => t.reasonCode === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------- graph ---

describe("graph for the baseline", () => {
  const m = build(baseline);

  it("has one node per real entity", () => {
    expect(m.nodes.map((n) => n.key)).toEqual([
      "person:alex", "person:sam", "person:taylor",
      "task:T01", "task:T02",
      "resource:water", "location:home",
    ]);
  });

  it("draws exactly the relationships in the model", () => {
    expect(m.edges.map((e) => e.key).sort()).toEqual([
      "assigned:alex>T02",
      "assigned:sam>T01",
      "at:T01>home",
      "at:T02>home",
      "needs:T02>water",
    ]);
    expect(m.edges.every((e) => e.emphasis === "normal")).toBe(true);
    expect(m.affectedTaskIds).toEqual([]);
    expect(m.nodes.every((n) => !n.affected)).toBe(true);
  });
});

describe("real reassignment (Sam unavailable, Taylor takes over)", () => {
  const m = build(planSam, baseline);

  it("marks the disrupted person and the affected task", () => {
    expect(node(m, "person:sam")).toMatchObject({ state: "disrupted", affected: true });
    expect(node(m, "task:T01")).toMatchObject({ state: "resolved", affected: true, change: "reassigned" });
    expect(node(m, "task:T02")).toMatchObject({ state: "resolved", affected: false });
    expect(node(m, "task:T02").change).toBeUndefined();
  });

  it("shows the new assignment and a ghost of the old one", () => {
    expect(edge(m, "assigned:taylor>T01")).toMatchObject({ emphasis: "new" });
    expect(edge(m, "was:sam>T01")).toMatchObject({ emphasis: "ghost", affected: true, label: "was" });
    expect(edge(m, "assigned:sam>T01")).toBeUndefined();
    expect(node(m, "task:T01").lines[2]).toBe("Taylor · reassigned");
  });

  it("does not claim a reassignment without a reference", () => {
    const alone = build(planSam);
    expect(node(alone, "task:T01").change).toBeUndefined();
    expect(node(alone, "task:T01").lines[2]).toBe("Taylor");
    expect(edge(alone, "was:sam>T01")).toBeUndefined();
    expect(edge(alone, "assigned:taylor>T01")!.emphasis).toBe("normal");
    // Still traced as affected: the engine reports Sam as the baseline assignee.
    expect(node(alone, "task:T01").affected).toBe(true);
  });
});

describe("unresolved task keeps its real failure reason", () => {
  const m = build(planSamTaylor, planSam);

  it("shows the reason code and no assignment edge", () => {
    expect(node(m, "task:T01")).toMatchObject({ state: "unresolved", change: "newly_unresolved" });
    expect(node(m, "task:T01").lines[2]).toBe("PERSON_UNAVAILABLE");
    expect(m.edges.some((e) => e.to === "task:T01" && e.kind === "assigned" && e.emphasis !== "ghost")).toBe(false);
    expect(edge(m, "was:taylor>T01")).toMatchObject({ emphasis: "ghost", affected: true });
  });
});

describe("resource and location disruptions", () => {
  it("highlights the needs-edge to an unavailable resource", () => {
    const m = build(planSamTaylorWater, planSamTaylor);
    expect(node(m, "resource:water")).toMatchObject({ state: "disrupted", affected: true });
    expect(node(m, "task:T02")).toMatchObject({ state: "blocked", change: "newly_blocked" });
    expect(node(m, "task:T02").lines[2]).toBe("RESOURCE_UNAVAILABLE");
    expect(edge(m, "needs:T02>water")).toMatchObject({ emphasis: "affected", affected: true });
    expect(edge(m, "needs:T02>water")!.label).toBe("×1");
  });

  it("highlights every edge into an inaccessible location", () => {
    const m = build(planHome, baseline);
    expect(node(m, "location:home")).toMatchObject({ state: "disrupted", affected: true });
    expect(edge(m, "at:T01>home")!.emphasis).toBe("affected");
    expect(edge(m, "at:T02>home")!.emphasis).toBe("affected");
    expect(m.nodes.filter((n) => n.kind === "task").every((n) => n.state === "blocked")).toBe(true);
    expect(m.affectedTaskIds).toEqual(["T01", "T02"]);
  });
});

describe("eligible backups", () => {
  it("are drawn only for the selected task, from the model's skills", () => {
    expect(build(baseline).edges.some((e) => e.kind === "eligible")).toBe(false);

    const m = build(baseline, undefined, "task:T01");
    expect(m.edges.filter((e) => e.kind === "eligible").map((e) => e.key).sort()).toEqual([
      "eligible:sam>T01",
      "eligible:taylor>T01",
    ]);
    expect(eligiblePeople(hh, hh.tasks[0]!).map((p) => p.id)).toEqual(["sam", "taylor"]);
  });

  it("say when the eligible person is unavailable", () => {
    const m = build(planSamTaylor, undefined, "task:T01");
    expect(edge(m, "eligible:sam>T01")!.label).toBe("can do, unavailable");
  });

  it("are not invented for tasks that need no skills", () => {
    const m = build(baseline, undefined, "task:T02");
    expect(m.edges.some((e) => e.kind === "eligible")).toBe(false);
  });
});

describe("no fabricated connections, across every captured scenario", () => {
  const scenarios: [string, unknown, unknown?][] = [
    ["baseline", baseline],
    ["sam", planSam, baseline],
    ["sam+taylor", planSamTaylor, planSam],
    ["sam+taylor+water", planSamTaylorWater, planSamTaylor],
    ["home", planHome, baseline],
  ];

  it.each(scenarios)("%s: every edge is backed by the data", (_name, current, ref) => {
    const m = build(current, ref, "task:T01");
    const keys = new Set(m.nodes.map((n) => n.key));
    const outcomes = view(current).tasks;

    for (const e of m.edges) {
      expect(keys.has(e.from), e.key).toBe(true);
      expect(keys.has(e.to), e.key).toBe(true);
    }
    for (const e of m.edges.filter((x) => x.kind === "needs")) {
      const task = hh.tasks.find((t) => `task:${t.id}` === e.from)!;
      expect(task.resourceNeeds.some((n) => `resource:${n.resourceId}` === e.to)).toBe(true);
    }
    for (const e of m.edges.filter((x) => x.kind === "at")) {
      const task = hh.tasks.find((t) => `task:${t.id}` === e.from)!;
      expect(`location:${task.locationId}`).toBe(e.to);
    }
    for (const e of m.edges.filter((x) => x.kind === "assigned" && x.emphasis !== "ghost")) {
      const o = outcomes.find((t) => `task:${t.taskId}` === e.to)!;
      expect(o.status).toBe("resolved");
      expect(`person:${o.assignedPersonId}`).toBe(e.from);
    }
  });

  it.each(scenarios)("%s: layout is deterministic and independent of plan state", (_n, current, ref) => {
    const a = build(current, ref);
    const b = build(current, ref);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const positions = (m: MapModel) => m.nodes.map((n) => [n.key, n.x, n.y, n.w, n.h]);
    expect(positions(a)).toEqual(positions(build(baseline)));
  });

  it("no two nodes overlap", () => {
    const m = build(baseline);
    for (const a of m.nodes) {
      for (const b of m.nodes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.key} vs ${b.key}`).toBe(true);
      }
    }
  });
});

// ------------------------------------------------------- diff & summary ---

describe("diff and incident summary", () => {
  it("classifies each task's change", () => {
    const kinds = (cur: unknown, ref: unknown) =>
      diffTasks(hh, view(ref), view(cur)).map((c) => [c.taskId, c.kind]);

    expect(kinds(baseline, baseline)).toEqual([["T01", "unchanged"], ["T02", "unchanged"]]);
    expect(kinds(planSam, baseline)).toEqual([["T01", "reassigned"], ["T02", "unchanged"]]);
    expect(kinds(planSamTaylor, planSam)).toEqual([["T01", "newly_unresolved"], ["T02", "unchanged"]]);
    expect(kinds(planSamTaylorWater, planSamTaylor)).toEqual([["T01", "unchanged"], ["T02", "newly_blocked"]]);
    expect(kinds(baseline, planSamTaylor)).toEqual([["T01", "recovered"], ["T02", "unchanged"]]);
    expect(kinds(planHome, baseline)).toEqual([["T01", "newly_blocked"], ["T02", "newly_blocked"]]);
  });

  it("summarizes what happened, what changed and what remains", () => {
    const cur = view(planSamTaylor);
    const ref = snapshotOf(planSam);
    const changes = diffTasks(hh, ref.view, cur);
    const s = summarizeIncident(hh, ref, cur, changes, ["T01"]);

    expect(s.addedDisruptions).toEqual([{ type: "person_unavailable", personId: "taylor" }]);
    expect(s.removedDisruptions).toEqual([]);
    expect(s.newlyFailed.map((c) => c.taskId)).toEqual(["T01"]);
    expect(s.reassigned).toEqual([]);
    expect(s.stillUnresolved.map((t) => t.taskId)).toEqual(["T01"]);
  });

  it("reports the reassignment from and to", () => {
    const cur = view(planSam);
    const ref = snapshotOf(baseline);
    const s = summarizeIncident(hh, ref, cur, diffTasks(hh, ref.view, cur), []);
    expect(s.reassigned).toEqual([{ taskId: "T01", from: "sam", to: "taylor" }]);
  });
});

describe("recovery conditions come from reason codes and blockers", () => {
  const cond = (raw: unknown, id: string) =>
    recoveryCondition(view(raw).tasks.find((t) => t.taskId === id)!, hh);

  it("names who or what must be restored", () => {
    expect(cond(planSamTaylor, "T01")).toBe("Make at least one of these people available: Sam, Taylor.");
    expect(cond(planSamTaylorWater, "T02")).toBe("Restore: Water kit.");
    expect(cond(planHome, "T01")).toBe("Restore access to Home.");
    expect(cond(planSam, "T01")).toBe("");
  });
});

// ------------------------------------- richer engine-generated scenarios ---

describe("dependencies and optional tasks (real engine output)", () => {
  const rich = JSON.parse(JSON.stringify(household));
  rich.tasks.push(
    { id: "T03", title: "Notify neighbours", description: "", priority: "medium", required: true, estimatedMinutes: 10, requiredSkills: [], resourceNeeds: [], dependsOnTaskIds: ["T01"] },
    { id: "T04", title: "Water the plants", description: "", priority: "low", required: false, estimatedMinutes: 5, requiredSkills: ["gardening"], resourceNeeds: [], dependsOnTaskIds: [] },
  );
  const richHh = parseHousehold(rich) as Household;
  const before = apiPlan(rich, [SAM]);
  const after = apiPlan(rich, [SAM, TAYLOR]);

  it("draws dependency edges and traces affected dependents", () => {
    const m = build(after, before, undefined, richHh);
    expect(edge(m, "depends:T03>T01")).toBeDefined();
    expect(m.affectedTaskIds).toEqual(["T01", "T03"]);
    expect(node(m, "task:T03")).toMatchObject({ state: "blocked", affected: true });
    expect(node(m, "task:T03").lines[2]).toBe("DEPENDENCY_BLOCKED");
    expect(edge(m, "depends:T03>T01")!.emphasis).toBe("affected");
  });

  it("reports an unresolved optional task without failing required work", () => {
    const m = build(before, undefined, undefined, richHh);
    expect(node(m, "task:T04")).toMatchObject({ state: "unresolved" });
    expect(node(m, "task:T04").lines[1]).toBe("UNRESOLVED · OPTIONAL");
    expect(node(m, "task:T04").lines[2]).toBe("REQUIRED_SKILL_MISSING");
    expect(view(before).recoveryStatus).toBe("fully_recovered");
  });

  it("explains how to unblock a dependent task", () => {
    const state = view(after).tasks.find((t) => t.taskId === "T03")!;
    expect(recoveryCondition(state, richHh)).toBe(
      "Resolve the prerequisite task(s) first: Check household members.",
    );
  });
});

// ---------------------------------------------------- keyboard navigation ---

describe("keyboard neighbour navigation", () => {
  const m = build(baseline);

  it("moves within a column with up and down", () => {
    expect(neighbor(m.nodes, "person:alex", "down")).toBe("person:sam");
    expect(neighbor(m.nodes, "person:taylor", "up")).toBe("person:sam");
    expect(neighbor(m.nodes, "person:alex", "up")).toBeUndefined();
    expect(neighbor(m.nodes, "person:taylor", "down")).toBeUndefined();
  });

  it("moves between columns with left and right, to the closest row", () => {
    expect(neighbor(m.nodes, "person:alex", "right")).toBe("task:T01");
    expect(neighbor(m.nodes, "task:T02", "left")).toBe("person:sam");
    expect(neighbor(m.nodes, "task:T01", "right")).toBe("resource:water");
    expect(neighbor(m.nodes, "resource:water", "right")).toBeUndefined();
    expect(neighbor(m.nodes, "person:alex", "left")).toBeUndefined();
  });

  it("falls back to the first node for an unknown key", () => {
    expect(neighbor(m.nodes, "nope", "down")).toBe("person:alex");
  });
});

describe("accessible node descriptions", () => {
  it("describe state, assignment and change from data only", () => {
    const m = build(planSam, baseline);
    const cur = view(planSam);
    const d = (key: string) => describeNode(hh, cur, m, node(m, key));

    expect(d("task:T01")).toBe(
      "Task T01 Check household members. required. resolved, assigned to Taylor. reassigned from Sam. affected by a disruption.",
    );
    expect(d("person:sam")).toBe("Person Sam. unavailable, disrupted in this scenario. skills: communication.");
    expect(d("person:taylor")).toBe("Person Taylor. available. skills: communication. assigned to T01.");
  });

  it("states a blocked task's engine reason", () => {
    const m = build(planSamTaylorWater, planSamTaylor);
    const text = describeNode(hh, view(planSamTaylorWater), m, node(m, "task:T02"));
    expect(text).toContain("blocked: Resource unavailable");
    expect(text).toContain("was resolved before this change");
  });
});
