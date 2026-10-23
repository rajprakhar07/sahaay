import { describe, expect, it } from "vitest";
import type { HouseholdPlan, Person, Task } from "./index";
import {
  deriveRecoveryStatus,
  summarizeOutcomes,
  type TaskOutcome,
} from "./outcomes";
import { recoverPlan, type Disruption, type RecoveryResult } from "./recovery";

// ---------- Fixtures ----------

function makeTask(
  overrides: Partial<Task> & Pick<Task, "id" | "title">,
): Task {
  return {
    description: "",
    priority: "medium",
    required: true,
    estimatedMinutes: 10,
    requiredSkills: [],
    resourceNeeds: [],
    dependsOnTaskIds: [],
    ...overrides,
  };
}

const alex: Person = { id: "alex", name: "Alex", skills: ["first-aid"], available: true };
const sam: Person = { id: "sam", name: "Sam", skills: ["communication"], available: true };
// Taylor overlaps Sam's skill; "taylor" sorts after "sam", so the baseline
// tie-break assigns T01 to Sam and Taylor is the genuine backup.
const taylor: Person = { id: "taylor", name: "Taylor", skills: ["communication"], available: true };

function demoHousehold(): HouseholdPlan {
  return {
    id: "demo",
    people: [{ ...alex }, { ...sam }, { ...taylor }],
    resources: [
      { id: "water", name: "Water kit", kind: "reusable", quantity: 1, unit: "kit" },
    ],
    locations: [{ id: "home", name: "Home", description: "" }],
    tasks: [
      makeTask({
        id: "T01",
        title: "Check household members",
        priority: "critical",
        requiredSkills: ["communication"],
        locationId: "home",
      }),
      makeTask({
        id: "T02",
        title: "Prepare emergency supplies",
        priority: "high",
        estimatedMinutes: 20,
        locationId: "home",
        resourceNeeds: [{ resourceId: "water", quantity: 1 }],
      }),
    ],
  };
}

function outcome(result: RecoveryResult, taskId: string): TaskOutcome {
  const found = result.taskOutcomes.find((o) => o.taskId === taskId);
  if (!found) throw new Error(`No outcome for ${taskId}`);
  return found;
}

const samOut: Disruption = { type: "person_unavailable", personId: "sam" };
const taylorOut: Disruption = { type: "person_unavailable", personId: "taylor" };
const waterOut: Disruption = { type: "resource_unavailable", resourceId: "water" };
const homeOut: Disruption = { type: "location_inaccessible", locationId: "home" };

// ---------- Baseline ----------

describe("baseline planning", () => {
  it("resolves every task and reports fully_recovered", () => {
    const result = recoverPlan(demoHousehold(), []);

    expect(result.recoveryStatus).toBe("fully_recovered");
    expect(result.complete).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.unresolvedRisks).toEqual([]);
    expect(result.taskOutcomes.map((o) => o.taskId)).toEqual(["T01", "T02"]);

    for (const o of result.taskOutcomes) {
      expect(o.status).toBe("resolved");
      expect(o.reasonCode).toBeUndefined();
      expect(o.blockedBy).toEqual([]);
    }
    expect(outcome(result, "T01").assignedPersonId).toBe("sam");
    expect(outcome(result, "T02").assignedPersonId).toBe("alex");
    expect(result.summary).toMatchObject({
      requiredTotal: 2,
      requiredResolved: 2,
      requiredUnresolved: 0,
    });
  });
});

// ---------- Individual disruptions ----------

describe("person unavailable", () => {
  it("reassigns to a feasible backup and states the change truthfully", () => {
    const result = recoverPlan(demoHousehold(), [samOut]);
    const t01 = outcome(result, "T01");

    expect(t01.status).toBe("resolved");
    expect(t01.assignedPersonId).toBe("taylor");
    expect(t01.baselineAssignedPersonId).toBe("sam");
    expect(t01.explanation).toContain("Reassigned from Sam");
    expect(t01.explanation).toContain("unavailable in this scenario");
    expect(result.recoveryStatus).toBe("fully_recovered");
    // The returned plan itself confirms the reassignment.
    expect(
      result.recoveryPlan.assignedTasks.find((t) => t.id === "T01")
        ?.assignedPersonId,
    ).toBe("taylor");
  });

  it("does not claim a reassignment when the assignee did not change", () => {
    const result = recoverPlan(demoHousehold(), [taylorOut]);
    expect(outcome(result, "T01").assignedPersonId).toBe("sam");
    expect(outcome(result, "T01").explanation).not.toContain("Reassigned");
  });

  it("reports PERSON_UNAVAILABLE and names who is unavailable when no backup exists", () => {
    const result = recoverPlan(demoHousehold(), [samOut, taylorOut]);
    const t01 = outcome(result, "T01");

    expect(t01.status).toBe("unresolved");
    expect(t01.reasonCode).toBe("PERSON_UNAVAILABLE");
    expect(t01.blockedBy).toEqual([
      { kind: "person", id: "sam" },
      { kind: "person", id: "taylor" },
    ]);
    expect(t01.explanation).toContain("Sam");
    expect(t01.explanation).toContain("Taylor");
    expect(outcome(result, "T02").status).toBe("resolved");
    expect(result.recoveryStatus).toBe("partially_recovered");
    expect(result.recovered).toBe(false);
  });

  it("explains an explicitly assigned person who is unavailable at baseline", () => {
    const household = demoHousehold();
    household.people[1] = { ...sam, available: false };
    household.tasks[0] = { ...household.tasks[0]!, assignedPersonId: "sam" };

    const t01 = outcome(recoverPlan(household, []), "T01");
    expect(t01.reasonCode).toBe("PERSON_UNAVAILABLE");
    expect(t01.blockedBy).toEqual([{ kind: "person", id: "sam" }]);
  });
});

describe("missing skills", () => {
  it("reports REQUIRED_SKILL_MISSING (not PERSON_UNAVAILABLE) when nobody has the skill", () => {
    const household = demoHousehold();
    household.tasks[0] = {
      ...household.tasks[0]!,
      requiredSkills: ["sign-language"],
    };

    const t01 = outcome(recoverPlan(household, []), "T01");
    expect(t01.status).toBe("unresolved");
    expect(t01.reasonCode).toBe("REQUIRED_SKILL_MISSING");
    expect(t01.blockedBy).toEqual([{ kind: "skill", id: "sign-language" }]);
  });

  it("reports REQUIRED_SKILL_MISSING for an explicit assignee lacking the skill", () => {
    const household = demoHousehold();
    household.tasks[0] = { ...household.tasks[0]!, assignedPersonId: "alex" };

    const t01 = outcome(recoverPlan(household, []), "T01");
    expect(t01.reasonCode).toBe("REQUIRED_SKILL_MISSING");
    expect(t01.explanation).toContain("Alex");
  });

  it("falls back to NO_FEASIBLE_ASSIGNMENT when there is nobody to assign", () => {
    const household = demoHousehold();
    household.people = [];
    household.tasks = [makeTask({ id: "T09", title: "Anything" })];

    const result = recoverPlan(household, []);
    expect(outcome(result, "T09").reasonCode).toBe("NO_FEASIBLE_ASSIGNMENT");
    expect(result.recoveryStatus).toBe("recovery_failed");
  });
});

describe("resource unavailable", () => {
  it("blocks only the task that needs the resource", () => {
    const result = recoverPlan(demoHousehold(), [waterOut]);
    const t02 = outcome(result, "T02");

    expect(t02.status).toBe("blocked");
    expect(t02.reasonCode).toBe("RESOURCE_UNAVAILABLE");
    expect(t02.blockedBy).toEqual([{ kind: "resource", id: "water" }]);
    expect(outcome(result, "T01").status).toBe("resolved");
    expect(result.recoveryStatus).toBe("partially_recovered");
  });
});

describe("insufficient resources", () => {
  it("reports RESOURCE_INSUFFICIENT for a reusable need above capacity, without a disruption", () => {
    const household = demoHousehold();
    household.tasks[1] = {
      ...household.tasks[1]!,
      resourceNeeds: [{ resourceId: "water", quantity: 2 }],
    };

    const result = recoverPlan(household, []);
    const t02 = outcome(result, "T02");
    expect(t02.reasonCode).toBe("RESOURCE_INSUFFICIENT");
    expect(t02.blockedBy).toEqual([{ kind: "resource", id: "water" }]);
    expect(t02.explanation).toContain("needs 2 but capacity is 1");
  });

  it("labels collateral tasks SCHEDULING_FAILED because the scheduler is all-or-nothing", () => {
    const household = demoHousehold();
    household.tasks[1] = {
      ...household.tasks[1]!,
      resourceNeeds: [{ resourceId: "water", quantity: 2 }],
    };

    const result = recoverPlan(household, []);
    // T01 is fine on its own, but the engine abandons the whole schedule.
    expect(outcome(result, "T01").reasonCode).toBe("SCHEDULING_FAILED");
    expect(result.recoveryPlan.schedule).toEqual([]);
    expect(result.recoveryStatus).toBe("recovery_failed");
  });

  it("blames every task consuming an over-demanded consumable", () => {
    const household = demoHousehold();
    household.resources.push({
      id: "rations", name: "Rations", kind: "consumable", quantity: 4, unit: "packs",
    });
    household.tasks.push(
      makeTask({ id: "T03", title: "Pack rations A", resourceNeeds: [{ resourceId: "rations", quantity: 3 }] }),
      makeTask({ id: "T04", title: "Pack rations B", resourceNeeds: [{ resourceId: "rations", quantity: 3 }] }),
    );

    const result = recoverPlan(household, []);
    expect(outcome(result, "T03").reasonCode).toBe("RESOURCE_INSUFFICIENT");
    expect(outcome(result, "T04").reasonCode).toBe("RESOURCE_INSUFFICIENT");
    expect(outcome(result, "T03").explanation).toContain("combined demand of 6 exceeds stock of 4");
    expect(outcome(result, "T01").reasonCode).toBe("SCHEDULING_FAILED");
  });

  it("uses RESOURCE_INSUFFICIENT, not RESOURCE_UNAVAILABLE, for stock of zero without a disruption", () => {
    const household = demoHousehold();
    household.resources[0] = { ...household.resources[0]!, quantity: 0 };

    const t02 = outcome(recoverPlan(household, []), "T02");
    expect(t02.reasonCode).toBe("RESOURCE_INSUFFICIENT");
  });
});

describe("inaccessible location", () => {
  it("blocks every task at that location and fails recovery when nothing else remains", () => {
    const result = recoverPlan(demoHousehold(), [homeOut]);

    for (const id of ["T01", "T02"]) {
      const o = outcome(result, id);
      expect(o.status).toBe("blocked");
      expect(o.reasonCode).toBe("LOCATION_INACCESSIBLE");
      expect(o.blockedBy).toEqual([{ kind: "location", id: "home" }]);
    }
    expect(result.recoveryStatus).toBe("recovery_failed");
  });

  it("is partially recovered when a task elsewhere stays schedulable", () => {
    const household = demoHousehold();
    household.tasks.push(makeTask({ id: "T03", title: "Call relatives" }));

    const result = recoverPlan(household, [homeOut]);
    expect(outcome(result, "T03").status).toBe("resolved");
    expect(result.recoveryStatus).toBe("partially_recovered");
  });
});

// ---------- Simultaneous disruptions ----------

describe("simultaneous disruptions", () => {
  it("handles independent effects together: one reassignment, one block", () => {
    const result = recoverPlan(demoHousehold(), [samOut, waterOut]);

    expect(outcome(result, "T01").assignedPersonId).toBe("taylor");
    expect(outcome(result, "T02").reasonCode).toBe("RESOURCE_UNAVAILABLE");
    expect(result.recoveryStatus).toBe("partially_recovered");
  });

  it("fails recovery when person and resource disruptions leave no required work", () => {
    const result = recoverPlan(demoHousehold(), [samOut, taylorOut, waterOut]);

    expect(outcome(result, "T01").reasonCode).toBe("PERSON_UNAVAILABLE");
    expect(outcome(result, "T02").reasonCode).toBe("RESOURCE_UNAVAILABLE");
    expect(result.recoveryStatus).toBe("recovery_failed");
  });

  it("reports both causes when a task is hit by a location and a resource disruption", () => {
    const result = recoverPlan(demoHousehold(), [homeOut, waterOut]);
    const t02 = outcome(result, "T02");

    expect(t02.reasonCode).toBe("LOCATION_INACCESSIBLE");
    expect(t02.blockedBy).toEqual([
      { kind: "location", id: "home" },
      { kind: "resource", id: "water" },
    ]);
  });
});

// ---------- Dependencies ----------

describe("dependencies", () => {
  function chain(): HouseholdPlan {
    const household = demoHousehold();
    household.tasks.push(
      makeTask({ id: "T03", title: "Notify neighbours", dependsOnTaskIds: ["T01"] }),
      makeTask({ id: "T04", title: "Share plan", dependsOnTaskIds: ["T03"] }),
    );
    return household;
  }

  it("blocks a dependent task, and its dependents, when a prerequisite is unresolved", () => {
    const result = recoverPlan(chain(), [samOut, taylorOut]);

    expect(outcome(result, "T01").reasonCode).toBe("PERSON_UNAVAILABLE");

    const t03 = outcome(result, "T03");
    expect(t03.status).toBe("blocked");
    expect(t03.reasonCode).toBe("DEPENDENCY_BLOCKED");
    expect(t03.blockedBy).toEqual([{ kind: "task", id: "T01" }]);
    expect(t03.explanation).toContain("T01");

    const t04 = outcome(result, "T04");
    expect(t04.reasonCode).toBe("DEPENDENCY_BLOCKED");
    expect(t04.blockedBy).toEqual([{ kind: "task", id: "T03" }]);
  });

  it("never reports a dependent as resolved while its prerequisite is not", () => {
    const result = recoverPlan(chain(), [samOut, taylorOut]);
    expect(outcome(result, "T03").status).not.toBe("resolved");
    expect(result.recoveryPlan.schedule.map((e) => e.taskId)).not.toContain("T03");
  });

  it("keeps dependents resolved when the prerequisite is reassigned successfully", () => {
    const result = recoverPlan(chain(), [samOut]);
    expect(outcome(result, "T01").assignedPersonId).toBe("taylor");
    expect(outcome(result, "T03").status).toBe("resolved");
    expect(outcome(result, "T04").status).toBe("resolved");
    expect(result.recoveryStatus).toBe("fully_recovered");
  });

  it("reports DEPENDENCY_CYCLE for cycle members and SCHEDULING_FAILED for bystanders", () => {
    const household = demoHousehold();
    household.tasks = [
      makeTask({ id: "A", title: "A", dependsOnTaskIds: ["B"] }),
      makeTask({ id: "B", title: "B", dependsOnTaskIds: ["A"] }),
      makeTask({ id: "C", title: "Independent" }),
    ];

    const result = recoverPlan(household, []);
    expect(outcome(result, "A").reasonCode).toBe("DEPENDENCY_CYCLE");
    expect(outcome(result, "A").blockedBy).toEqual([{ kind: "task", id: "B" }]);
    expect(outcome(result, "B").reasonCode).toBe("DEPENDENCY_CYCLE");
    expect(outcome(result, "C").reasonCode).toBe("SCHEDULING_FAILED");
    expect(result.recoveryStatus).toBe("recovery_failed");
  });
});

// ---------- Optional tasks and status definitions ----------

describe("optional tasks", () => {
  function withOptional(requiredSkills: string[]): HouseholdPlan {
    const household = demoHousehold();
    household.tasks.push(
      makeTask({ id: "T05", title: "Water the plants", required: false, requiredSkills }),
    );
    return household;
  }

  it("is fully_recovered with an unresolved optional task, reporting the gap separately", () => {
    const result = recoverPlan(withOptional(["gardening"]), []);

    expect(result.recoveryStatus).toBe("fully_recovered");
    expect(result.recovered).toBe(true);
    // Documented semantic difference: `complete` also needs optional tasks.
    expect(result.complete).toBe(false);
    expect(outcome(result, "T05").status).toBe("unresolved");
    expect(outcome(result, "T05").reasonCode).toBe("REQUIRED_SKILL_MISSING");
    expect(result.summary.optionalUnresolvedTaskIds).toEqual(["T05"]);
    expect(result.summary.requiredUnresolvedTaskIds).toEqual([]);
  });

  it("is recovery_failed when only optional work can be scheduled", () => {
    const result = recoverPlan(withOptional([]), [homeOut]);

    expect(outcome(result, "T05").status).toBe("resolved");
    expect(result.summary.requiredResolved).toBe(0);
    expect(result.recoveryStatus).toBe("recovery_failed");
  });

  it("is partially_recovered when a required task is unresolved even if optional work succeeds", () => {
    const result = recoverPlan(withOptional([]), [samOut, taylorOut]);

    expect(outcome(result, "T05").status).toBe("resolved");
    expect(outcome(result, "T02").status).toBe("resolved");
    expect(result.recoveryStatus).toBe("partially_recovered");
  });
});

describe("edge cases", () => {
  it("reports recovery_failed for a household with no tasks", () => {
    const household = demoHousehold();
    household.tasks = [];
    const result = recoverPlan(household, []);

    expect(result.taskOutcomes).toEqual([]);
    expect(result.recoveryStatus).toBe("recovery_failed");
    expect(result.recovered).toBe(false);
  });

  it("reports AMBIGUOUS_INPUT and never recovery for duplicate task IDs", () => {
    const household = demoHousehold();
    household.tasks.push(makeTask({ id: "T01", title: "Duplicate" }));

    const result = recoverPlan(household, []);
    expect(result.recoveryStatus).toBe("recovery_failed");
    expect(result.recovered).toBe(false);
    expect(result.taskOutcomes.every((o) => o.reasonCode === "AMBIGUOUS_INPUT")).toBe(true);
  });
});

describe("status derivation is based only on task outcomes", () => {
  const make = (
    required: boolean,
    status: TaskOutcome["status"],
    id: string,
  ): TaskOutcome => ({
    taskId: id,
    required,
    status,
    ...(status === "resolved" ? {} : { reasonCode: "UNDIAGNOSED" as const }),
    explanation: "x",
    blockedBy: [],
  });

  const statusOf = (outcomes: TaskOutcome[]) =>
    deriveRecoveryStatus(summarizeOutcomes(outcomes));

  it("maps outcome combinations to the documented statuses", () => {
    expect(statusOf([make(true, "resolved", "a"), make(true, "resolved", "b")])).toBe("fully_recovered");
    expect(statusOf([make(true, "resolved", "a"), make(false, "blocked", "b")])).toBe("fully_recovered");
    expect(statusOf([make(true, "resolved", "a"), make(true, "blocked", "b")])).toBe("partially_recovered");
    expect(statusOf([make(true, "unresolved", "a"), make(false, "resolved", "b")])).toBe("recovery_failed");
    expect(statusOf([make(true, "unresolved", "a")])).toBe("recovery_failed");
    expect(statusOf([])).toBe("recovery_failed");
  });
});

// ---------- Invariants over every disruption combination ----------

describe("invariants across all disruption combinations", () => {
  function sweepHousehold(): HouseholdPlan {
    return {
      id: "sweep",
      people: [{ ...alex }, { ...sam }, { ...taylor }],
      resources: [
        { id: "water", name: "Water kit", kind: "reusable", quantity: 1, unit: "kit" },
        { id: "rations", name: "Rations", kind: "consumable", quantity: 4, unit: "packs" },
      ],
      locations: [
        { id: "home", name: "Home", description: "" },
        { id: "shelter", name: "Shelter", description: "" },
      ],
      tasks: [
        makeTask({ id: "T01", title: "Check members", priority: "critical", requiredSkills: ["communication"], locationId: "home" }),
        makeTask({ id: "T02", title: "Prepare supplies", priority: "high", locationId: "home", resourceNeeds: [{ resourceId: "water", quantity: 1 }] }),
        makeTask({ id: "T03", title: "Notify neighbours", dependsOnTaskIds: ["T01"] }),
        makeTask({ id: "T04", title: "Pack rations", resourceNeeds: [{ resourceId: "rations", quantity: 2 }], locationId: "shelter" }),
        makeTask({ id: "T05", title: "First-aid check", required: false, requiredSkills: ["first-aid"], dependsOnTaskIds: ["T02"] }),
      ],
    };
  }

  const targets: Disruption[] = [
    { type: "person_unavailable", personId: "alex" },
    samOut,
    taylorOut,
    waterOut,
    homeOut,
    { type: "resource_unavailable", resourceId: "rations" },
    { type: "location_inaccessible", locationId: "shelter" },
  ];

  const combos: Disruption[][] = [];
  for (let mask = 0; mask < 1 << targets.length; mask++) {
    combos.push(targets.filter((_, i) => (mask & (1 << i)) !== 0));
  }

  it("covers all 128 combinations", () => {
    expect(combos).toHaveLength(128);
  });

  it("keeps outcomes, legacy flags and status mutually consistent", () => {
    const household = sweepHousehold();

    for (const disruptions of combos) {
      const label = JSON.stringify(disruptions);
      const r = recoverPlan(household, disruptions);
      const scheduled = new Set(r.recoveryPlan.schedule.map((e) => e.taskId));
      const requiredOutcomes = r.taskOutcomes.filter((o) => o.required);
      const requiredUnresolved = requiredOutcomes.filter((o) => o.status !== "resolved");
      const disrupted = new Set(
        disruptions.flatMap((d) => (d.type === "person_unavailable" ? [d.personId] : [])),
      );

      expect(r.taskOutcomes.map((o) => o.taskId), label).toEqual(household.tasks.map((t) => t.id));

      // A required unresolved task can never yield full recovery.
      if (requiredUnresolved.length > 0) {
        expect(r.recoveryStatus, label).not.toBe("fully_recovered");
        expect(r.recovered, label).toBe(false);
      }

      // Legacy flags relate to the new status as documented.
      expect(r.recovered, label).toBe(r.recoveryStatus === "fully_recovered");
      if (r.complete) {
        expect(r.recoveryStatus, label).toBe("fully_recovered");
        expect(r.taskOutcomes.every((o) => o.status === "resolved"), label).toBe(true);
      }

      // Status matches the definitions.
      const requiredResolved = requiredOutcomes.length - requiredUnresolved.length;
      if (r.recoveryStatus === "partially_recovered") {
        expect(requiredResolved, label).toBeGreaterThan(0);
        expect(requiredUnresolved.length, label).toBeGreaterThan(0);
      }
      if (r.recoveryStatus === "recovery_failed") {
        expect(requiredResolved, label).toBe(0);
      }

      // Outcomes agree with the real schedule and with legacy risks.
      for (const o of r.taskOutcomes) {
        expect(o.status === "resolved", `${label} ${o.taskId}`).toBe(scheduled.has(o.taskId));
        expect(o.reasonCode === undefined, `${label} ${o.taskId}`).toBe(o.status === "resolved");
        expect(o.explanation.length, `${label} ${o.taskId}`).toBeGreaterThan(0);
        expect(o.reasonCode, `${label} ${o.taskId}`).not.toBe("UNDIAGNOSED");

        if (o.status === "resolved") {
          // Assignments in the result respect availability.
          const person = r.scenario.people.find((p) => p.id === o.assignedPersonId);
          expect(person?.available, `${label} ${o.taskId}`).toBe(true);
          expect(disrupted.has(o.assignedPersonId ?? ""), `${label} ${o.taskId}`).toBe(false);
        }
      }
      expect(
        r.taskOutcomes.filter((o) => o.status !== "resolved").map((o) => o.taskId).sort(),
        label,
      ).toEqual(r.unresolvedRisks.map((risk) => risk.taskId).sort());

      // Dependents are never resolved while a prerequisite is not.
      for (const task of household.tasks) {
        if (outcome(r, task.id).status !== "resolved") continue;
        for (const dependencyId of task.dependsOnTaskIds) {
          expect(outcome(r, dependencyId).status, `${label} ${task.id}`).toBe("resolved");
        }
      }
    }
  });

  it("is deterministic for identical input", () => {
    const household = sweepHousehold();
    for (const disruptions of combos) {
      expect(JSON.stringify(recoverPlan(household, disruptions)), JSON.stringify(disruptions)).toBe(
        JSON.stringify(recoverPlan(household, disruptions)),
      );
    }
  });
});

// ---------- Backward compatibility ----------

describe("backward compatibility", () => {
  it("keeps unresolvedRisks in the legacy { taskId, reason } shape", () => {
    const result = recoverPlan(demoHousehold(), [samOut, taylorOut]);

    expect(result.unresolvedRisks).toEqual([
      {
        taskId: "T01",
        reason: "People with the required skills exist, but none are available.",
      },
    ]);
    expect(result.recoveryPlan.unassignedTasks).toEqual(result.unresolvedRisks);
  });

  it("does not mutate the household while building outcomes", () => {
    const household = demoHousehold();
    const before = structuredClone(household);
    recoverPlan(household, [samOut, waterOut]);
    expect(household).toEqual(before);
  });
});
