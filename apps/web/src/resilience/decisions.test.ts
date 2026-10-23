import { describe, expect, it } from "vitest";
import type { Disruption as EngineDisruption } from "@sahaay/engine";
import { apiPlan } from "../test-utils/mockApi";
import household from "./__fixtures__/household.json";
import baseline from "./__fixtures__/plan-baseline.json";
import planSam from "./__fixtures__/plan-sam.json";
import planSamTaylor from "./__fixtures__/plan-sam-taylor.json";
import planSamTaylorWater from "./__fixtures__/plan-sam-taylor-water.json";
import planHome from "./__fixtures__/plan-home.json";
import {
  TIE_BREAK_RULE,
  buildDecisionTrace,
  checkConstraints,
  classifyCandidates,
  computeInsights,
  countChanges,
  explainAssignment,
  incompleteReasons,
} from "./decisions";
import {
  buildMapModel,
  diffTasks,
  parseBaselineReference,
  parseHousehold,
  parsePlanView,
  type Household,
  type PlanView,
  type Reference,
} from "./model";

// Fixtures are real API payloads (see __fixtures__/README.md).
const hh = parseHousehold(household) as Household;
const view = (raw: unknown) => parsePlanView(raw) as PlanView;
const snapshotOf = (raw: unknown): Reference => ({
  kind: "snapshot",
  label: "Before last disruption",
  view: view(raw),
});
const task = (h: Household, id: string) => h.tasks.find((t) => t.id === id)!;

function trace(h: Household, raw: unknown, ref?: unknown) {
  const current = view(raw);
  const reference = ref ? snapshotOf(ref) : undefined;
  const model = buildMapModel(h, current, reference);
  return {
    current,
    model,
    trace: buildDecisionTrace(h, current, reference, model.affectedTaskIds),
    insights: computeInsights(h, current, model.affectedTaskIds),
  };
}

const SAM: EngineDisruption = { type: "person_unavailable", personId: "sam" };
const TAYLOR: EngineDisruption = { type: "person_unavailable", personId: "taylor" };
const WATER: EngineDisruption = { type: "resource_unavailable", resourceId: "water" };
const HOME: EngineDisruption = { type: "location_inaccessible", locationId: "home" };

// ------------------------------------------------------------ parsing ---

describe("validation and durations are read from the real payload", () => {
  it("parses the engine's validation result and the scheduled tasks", () => {
    expect(view(planSam).validation).toEqual({
      valid: true,
      violations: [],
      schedulingErrors: [],
      scheduledTaskIds: ["T01", "T02"],
    });
    expect(view(planSamTaylor).validation?.scheduledTaskIds).toEqual(["T02"]);
  });

  it("does not invent validation when the payload has none", () => {
    const { currentPlan: _c, baselinePlan: _b, ...noPlan } = planSam;
    expect(parsePlanView({ ...noPlan, currentPlan: { assignedTasks: [] } })?.validation).toBeUndefined();
    expect(parseBaselineReference(planSam)?.view.validation).toBeUndefined();
  });

  it("keeps task durations and explicit assignments only when present", () => {
    expect(task(hh, "T01").estimatedMinutes).toBe(10);
    expect(task(hh, "T01").assignedPersonId).toBeUndefined();
    const p = parseHousehold({
      tasks: [{ id: "X", estimatedMinutes: "soon", assignedPersonId: 5 }],
    })!;
    expect(p.tasks[0]).not.toHaveProperty("estimatedMinutes");
    expect(p.tasks[0]).not.toHaveProperty("assignedPersonId");
  });
});

// --------------------------------------------------- assignment reasons ---

describe("why a person was (or was not) chosen", () => {
  it("explains the Sam to Taylor reassignment with every alternative", () => {
    const current = view(planSam);
    const d = explainAssignment(hh, task(hh, "T01"), current, "sam")!;

    expect(d.kind).toBe("reassigned");
    expect(d.from).toBe("sam");
    expect(d.to).toBe("taylor");
    expect(d.consistent).toBe(true);
    expect(d.eligibleCount).toBe(1);
    expect(d.tieBreak).toBeUndefined();
    expect(d.candidates.map((c) => [c.personId, c.verdict])).toEqual([
      ["alex", "missing_skills"],
      ["sam", "disrupted"],
      ["taylor", "selected"],
    ]);
    expect(d.candidates[0]!.missingSkills).toEqual(["communication"]);
    expect(d.summary).toContain("Reassigned from Sam to Taylor");
    expect(d.summary).toContain("Sam is unavailable in this scenario");
    expect(d.summary).toContain("Taylor is the only available person");
    expect(d.summary).toContain("communication");
  });

  it("quotes the planner's tie-break only when several people are eligible", () => {
    const current = view(baseline);
    const kept = explainAssignment(hh, task(hh, "T01"), current, "sam")!;
    expect(kept.kind).toBe("kept");
    expect(kept.eligibleCount).toBe(2);
    expect(kept.tieBreak).toBe(TIE_BREAK_RULE);
    expect(kept.summary).toContain(TIE_BREAK_RULE);
    // Alex has no required skill need for T02, so many people are eligible there.
    const t02 = explainAssignment(hh, task(hh, "T02"), current, "alex")!;
    expect(t02.eligibleCount).toBe(3);
  });

  it("returns nothing for a task that was not resolved", () => {
    expect(explainAssignment(hh, task(hh, "T01"), view(planSamTaylor), "sam")).toBeUndefined();
  });

  it("says so when the household data does not support the assignment", () => {
    // Plan says Alex does T01, but Alex lacks the skill in this household.
    const forged = view(baseline);
    forged.tasks = forged.tasks.map((t) => (t.taskId === "T01" ? { ...t, assignedPersonId: "alex" } : t));
    const d = explainAssignment(hh, task(hh, "T01"), forged, "sam")!;
    expect(d.consistent).toBe(false);
    expect(d.summary).toContain("may be out of sync");
  });

  it("recognises an explicit assignment from the household model", () => {
    const explicit: Household = {
      ...hh,
      tasks: hh.tasks.map((t) => (t.id === "T01" ? { ...t, assignedPersonId: "sam" } : t)),
    };
    const d = explainAssignment(explicit, task(explicit, "T01"), view(baseline), "sam")!;
    expect(d.kind).toBe("explicit");
    expect(d.summary).toContain("household model");
  });

  it("separates 'unavailable in the model' from 'disrupted'", () => {
    const edited: Household = {
      ...hh,
      people: hh.people.map((p) => (p.id === "taylor" ? { ...p, available: false } : p)),
    };
    const c = classifyCandidates(edited, task(edited, "T01"), view(planSam));
    expect(c.find((x) => x.personId === "taylor")?.verdict).toBe("unavailable_in_model");
    expect(c.find((x) => x.personId === "sam")?.verdict).toBe("disrupted");
  });
});

// ----------------------------------------------------------- constraints ---

describe("constraints are checked against real data", () => {
  it("shows skill, resource and location constraints as met when they are", () => {
    const checks = checkConstraints(hh, task(hh, "T02"), view(planSam));
    expect(checks.map((c) => [c.kind, c.met])).toEqual([
      ["resource", true],
      ["location", true],
    ]);
    const t01 = checkConstraints(hh, task(hh, "T01"), view(planSam));
    expect(t01.find((c) => c.kind === "skill")).toMatchObject({ met: true });
    expect(t01.find((c) => c.kind === "skill")?.text).toContain("Taylor has it");
  });

  it("flags the disrupted resource and the inaccessible location", () => {
    const water = checkConstraints(hh, task(hh, "T02"), view(planSamTaylorWater));
    expect(water.find((c) => c.kind === "resource")).toMatchObject({ met: false });
    expect(water.find((c) => c.kind === "resource")?.text).toContain("unavailable in this scenario");

    const home = checkConstraints(hh, task(hh, "T01"), view(planHome));
    expect(home.find((c) => c.kind === "location")).toMatchObject({ met: false });
  });

  it("does not guess skill checks for a task nobody is assigned to", () => {
    const checks = checkConstraints(hh, task(hh, "T01"), view(planSamTaylor));
    expect(checks.some((c) => c.kind === "skill")).toBe(false);
  });
});

// ----------------------------------------------------------------- trace ---

describe("decision trace: disruption to remaining risks", () => {
  it("traces Sam being unavailable through reassignment to a passed validation", () => {
    const { trace: t } = trace(hh, planSam, baseline);

    expect(t.hasDisruptions).toBe(true);
    expect(t.disruptions).toEqual([{ description: "Sam is unavailable", added: true }]);
    expect(t.impacted.map((i) => i.taskId)).toEqual(["T01"]);
    expect(t.impacted[0]!.reasons).toEqual(["Was assigned to Sam, who is unavailable."]);

    const d = t.decisions.find((x) => x.taskId === "T01")!;
    expect(d.headline).toBe("Reassigned from Sam to Taylor");
    expect(d.assignment?.summary).toContain("Sam is unavailable in this scenario");
    expect(t.decisions.map((x) => x.taskId)).toEqual(["T01"]);

    expect(t.validation).toEqual({ state: "passed", scheduledCount: 2, taskCount: 2, messages: [] });
    expect(t.risks).toEqual({ required: [], optional: [] });
  });

  it("explains an unrecovered task: why, which alternatives failed, and what to do", () => {
    const { trace: t } = trace(hh, planSamTaylor, planSam);
    const d = t.decisions.find((x) => x.taskId === "T01")!;

    expect(d.status).not.toBe("resolved");
    expect(d.headline).toMatch(/^Could not be recovered: /);
    expect(d.assignment).toBeUndefined();
    expect(d.alternatives?.map((c) => [c.personId, c.verdict])).toEqual([
      ["alex", "missing_skills"],
      ["sam", "disrupted"],
      ["taylor", "disrupted"],
    ]);
    expect(d.nextStep).toBeTruthy();
    expect(d.engineExplanation).toBeTruthy();
    expect(t.risks.required.map((r) => r.taskId)).toEqual(["T01"]);
    // Validation passed for what was scheduled, and says how much that was.
    expect(t.validation).toMatchObject({ state: "passed", scheduledCount: 1, taskCount: 2 });
  });

  it("names the blocking resource and does not invent person alternatives for it", () => {
    const { trace: t } = trace(hh, planSamTaylorWater, planSamTaylor);
    const d = t.decisions.find((x) => x.taskId === "T02")!;
    expect(d.reasonCode).toBe("RESOURCE_UNAVAILABLE");
    expect(d.alternatives).toBeUndefined();
    expect(d.constraints.find((c) => c.kind === "resource")?.met).toBe(false);
    expect(d.impact).toContain("Needs Water kit, which is unavailable.");
    expect(t.disruptions.map((x) => x.added)).toEqual([false, false, true]);
  });

  it("traces an inaccessible location to every task there", () => {
    const { trace: t } = trace(hh, planHome, baseline);
    expect(t.impacted.map((i) => i.taskId)).toEqual(["T01", "T02"]);
    expect(t.impacted.every((i) => i.reasons.some((r) => r.includes("Home, which is inaccessible")))).toBe(true);
    expect(t.risks.required.map((r) => r.taskId)).toEqual(["T01", "T02"]);
    expect(t.validation.scheduledCount).toBe(0);
  });

  it("reports no disruption honestly for the baseline", () => {
    const { trace: t } = trace(hh, baseline);
    expect(t.hasDisruptions).toBe(false);
    expect(t.disruptions).toEqual([]);
    expect(t.impacted).toEqual([]);
    expect(t.decisions).toEqual([]);
  });

  it("marks validation as not reported rather than assuming it passed", () => {
    const current = view(planSam);
    delete current.validation;
    const t = buildDecisionTrace(hh, current, undefined, []);
    expect(t.validation.state).toBe("not_reported");
    expect(t.validation.messages).toEqual([]);
  });

  it("surfaces validator violations and scheduling errors as failed", () => {
    const current = view(planSam);
    current.validation = {
      valid: false,
      violations: [{ type: "PERSON_OVERLAP", message: "Taylor is double-booked.", taskIds: ["T01"] }],
      schedulingErrors: ["resource over-demand"],
      scheduledTaskIds: [],
    };
    const t = buildDecisionTrace(hh, current, undefined, []);
    expect(t.validation.state).toBe("failed");
    expect(t.validation.messages).toEqual(["resource over-demand", "Taylor is double-booked."]);
  });
});

// -------------------------------------------------------------- insights ---

describe("resilience insights come from real state", () => {
  it("baseline: nobody is a single point of failure and nothing is under pressure", () => {
    const { insights: i } = trace(hh, baseline);
    expect(i.requiredResolved).toBe(2);
    expect(i.requiredTotal).toBe(2);
    expect(i.affectedCount).toBe(0);
    expect(i.openRiskCount).toBe(0);
    expect(i.singleHolderSkills).toEqual([]);
    expect(i.uncoveredSkills).toEqual([]);
    expect(i.resourcePressure).toEqual([]);
    expect(i.workload.map((w) => [w.personId, w.minutes])).toEqual([
      ["alex", 20],
      ["sam", 10],
    ]);
    expect(i.workload[0]!.share).toBeCloseTo(20 / 30);
  });

  it("after Sam is out, Taylor is the only communication holder", () => {
    const { insights: i } = trace(hh, planSam, baseline);
    expect(i.singleHolderSkills).toEqual([
      { skill: "communication", taskIds: ["T01"], holderIds: ["taylor"] },
    ]);
    expect(i.workload.map((w) => [w.personId, w.minutes])).toEqual([
      ["alex", 20],
      ["taylor", 10],
    ]);
  });

  it("after Sam and Taylor, the skill is uncovered and T01 is the open risk", () => {
    const { insights: i } = trace(hh, planSamTaylor, planSam);
    expect(i.uncoveredSkills.map((s) => [s.skill, s.taskIds])).toEqual([["communication", ["T01"]]]);
    expect(i.singleHolderSkills).toEqual([]);
    expect(i.openRiskCount).toBe(1);
    expect(i.requiredResolved).toBe(1);
    expect(i.requiredTotal).toBe(2);
    expect(i.recoveryStatus).toBe("partially_recovered");
  });

  it("reports a disrupted resource with its blocked tasks and zero supply", () => {
    const { insights: i } = trace(hh, planSamTaylorWater, planSamTaylor);
    expect(i.resourcePressure).toEqual([
      {
        resourceId: "water",
        name: "Water kit",
        supply: 0,
        unit: "kit",
        disrupted: true,
        taskIds: ["T02"],
        blockedTaskIds: ["T02"],
      },
    ]);
    expect(i.recoveryStatus).toBe("recovery_failed");
  });

  it("leaves workload out when the backend reports no durations", () => {
    const noMinutes: Household = {
      ...hh,
      tasks: hh.tasks.map(({ estimatedMinutes: _m, ...rest }) => rest),
    };
    expect(computeInsights(noMinutes, view(baseline), []).workload).toEqual([]);
  });
});

// --------------------------------------------------------------- compare ---

describe("comparison counts and reasons for incomplete recovery", () => {
  it("counts recovered, reassigned, newly failed and unresolved tasks", () => {
    const count = (cur: unknown, ref: unknown) => {
      const c = view(cur);
      return countChanges(diffTasks(hh, view(ref), c), c);
    };
    expect(count(planSam, baseline)).toEqual({ recovered: 0, reassigned: 1, newlyFailed: 0, stillUnresolved: 0 });
    expect(count(planSamTaylor, planSam)).toEqual({ recovered: 0, reassigned: 0, newlyFailed: 1, stillUnresolved: 1 });
    expect(count(baseline, planSamTaylor)).toEqual({ recovered: 1, reassigned: 0, newlyFailed: 0, stillUnresolved: 0 });
    expect(count(planHome, baseline)).toEqual({ recovered: 0, reassigned: 0, newlyFailed: 2, stillUnresolved: 2 });
  });

  it("groups required unresolved tasks by the engine's reason code", () => {
    expect(incompleteReasons(view(baseline))).toEqual([]);
    expect(incompleteReasons(view(planSamTaylor)).map((r) => [r.taskIds, r.code])).toEqual([
      [["T01"], view(planSamTaylor).tasks.find((t) => t.taskId === "T01")!.reasonCode],
    ]);
    const home = incompleteReasons(view(planHome));
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ code: "LOCATION_INACCESSIBLE", taskIds: ["T01", "T02"] });
  });

  it("does not report optional tasks as reasons recovery is incomplete", () => {
    const current = view(planSam);
    current.tasks = current.tasks.map((t) => (t.taskId === "T02" ? { ...t, required: false, status: "blocked" as const } : t));
    expect(incompleteReasons(current)).toEqual([]);
  });
});

// ------------------------------------------------ invariants, real engine ---

type Target = EngineDisruption;
const allSubsets = (targets: Target[]): Target[][] =>
  Array.from({ length: 1 << targets.length }, (_, mask) => targets.filter((_, i) => mask & (1 << i)));

/** A richer household: shared skills, a dependency, an optional task and an explicit assignment. */
const rich = {
  id: "rich",
  people: [
    { id: "ana", name: "Ana", skills: ["first-aid", "driving"], available: true },
    { id: "ben", name: "Ben", skills: ["first-aid"], available: true },
    { id: "cy", name: "Cy", skills: ["driving"], available: true },
    { id: "di", name: "Di", skills: ["cooking", "first-aid"], available: true },
  ],
  tasks: [
    { id: "A", title: "Treat injury", priority: "critical", required: true, estimatedMinutes: 15, requiredSkills: ["first-aid"], resourceNeeds: [{ resourceId: "kit", quantity: 1 }], dependsOnTaskIds: [] },
    { id: "B", title: "Drive to shelter", priority: "high", required: true, estimatedMinutes: 30, requiredSkills: ["driving"], resourceNeeds: [], locationId: "shelter", dependsOnTaskIds: ["A"] },
    { id: "C", title: "Cook meal", priority: "low", required: false, estimatedMinutes: 20, requiredSkills: ["cooking"], resourceNeeds: [], dependsOnTaskIds: [] },
    { id: "D", title: "Radio check", priority: "medium", required: true, estimatedMinutes: 5, requiredSkills: [], resourceNeeds: [], assignedPersonId: "cy", dependsOnTaskIds: [] },
  ],
  resources: [{ id: "kit", name: "First-aid kit", kind: "reusable", quantity: 1, unit: "kit" }],
  locations: [{ id: "shelter", name: "Shelter", description: "" }],
};

function sweep(raw: unknown, targets: Target[]) {
  const h = parseHousehold(raw) as Household;
  const base = view(apiPlan(raw, []));
  const baseRef: Reference = { kind: "baseline", label: "Baseline", view: base };
  let checked = 0;

  for (const subset of allSubsets(targets)) {
    const current = view(apiPlan(raw, subset));
    for (const reference of [undefined, baseRef]) {
      const model = buildMapModel(h, current, reference);
      const t = buildDecisionTrace(h, current, reference, model.affectedTaskIds);
      const insights = computeInsights(h, current, model.affectedTaskIds);
      const label = JSON.stringify(subset);

      for (const state of current.tasks) {
        const tk = h.tasks.find((x) => x.id === state.taskId)!;
        if (state.status === "resolved") {
          const prev = reference?.view.tasks.find((x) => x.taskId === tk.id)?.assignedPersonId;
          const d = explainAssignment(h, tk, current, prev);
          // Every real assignment must be explainable from household data.
          expect(d, `${label} ${tk.id}`).toBeDefined();
          expect(d!.consistent, `${label} ${tk.id} consistent`).toBe(true);
          expect(
            d!.candidates.filter((c) => c.verdict === "selected").map((c) => c.personId),
            `${label} ${tk.id} selected`,
          ).toEqual([state.assignedPersonId]);
          // Nobody who is disrupted or lacks a skill may be the assignee.
          const chosen = d!.candidates.find((c) => c.personId === state.assignedPersonId)!;
          expect(chosen.verdict).toBe("selected");
        } else {
          const decision = t.decisions.find((x) => x.taskId === tk.id);
          expect(decision, `${label} ${tk.id} has a decision`).toBeDefined();
          expect(decision!.nextStep).toBeTruthy();
          expect(decision!.engineExplanation).toBeTruthy();
          // Alternatives are shown only for assignment-related failures,
          // and when shown, none of them may be an eligible person.
          if (decision!.alternatives) {
            expect(
              decision!.alternatives.every((c) => c.verdict !== "selected" && c.verdict !== "eligible_not_selected"),
              `${label} ${tk.id} alternatives`,
            ).toBe(true);
          }
        }
      }

      expect(insights.openRiskCount).toBe(current.tasks.filter((x) => x.status !== "resolved").length);
      expect(t.risks.required.length + t.risks.optional.length).toBe(insights.openRiskCount);
      expect(insights.requiredResolved).toBeLessThanOrEqual(insights.requiredTotal);
      expect(t.validation.state).not.toBe("not_reported");
      expect(t.validation.scheduledCount).toBe(
        current.tasks.filter((x) => x.status === "resolved").length,
      );
      // Workload never counts a person who has no resolved task.
      const resolvedBy = new Set(current.tasks.flatMap((x) => (x.status === "resolved" && x.assignedPersonId ? [x.assignedPersonId] : [])));
      expect(insights.workload.every((w) => resolvedBy.has(w.personId))).toBe(true);
      checked++;
    }
  }
  return checked;
}

describe("invariants against the real engine", () => {
  it("demo household: every combination of the five possible disruptions", () => {
    const targets: Target[] = [
      { type: "person_unavailable", personId: "alex" },
      SAM,
      TAYLOR,
      WATER,
      HOME,
    ];
    expect(sweep(household, targets)).toBe(2 * 32);
  });

  it("richer household: shared skills, dependency, optional task, explicit assignment", () => {
    const targets: Target[] = [
      { type: "person_unavailable", personId: "ana" },
      { type: "person_unavailable", personId: "ben" },
      { type: "person_unavailable", personId: "cy" },
      { type: "person_unavailable", personId: "di" },
      { type: "resource_unavailable", resourceId: "kit" },
      { type: "location_inaccessible", locationId: "shelter" },
    ];
    expect(sweep(rich, targets)).toBe(2 * 64);
  });

  it("an explicit assignment is reported as explicit until its person is disrupted", () => {
    const h = parseHousehold(rich) as Household;
    const intact = view(apiPlan(rich, []));
    expect(explainAssignment(h, task(h, "D"), intact, "cy")?.kind).toBe("explicit");

    const cyOut = view(apiPlan(rich, [{ type: "person_unavailable", personId: "cy" }]));
    const d = explainAssignment(h, task(h, "D"), cyOut, "cy")!;
    expect(d.kind).toBe("reassigned");
    expect(d.summary).toContain("Cy is unavailable in this scenario");
  });
});
