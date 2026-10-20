
import { describe, expect, it } from "vitest";
import type { HouseholdPlan, Task } from "./index";
import { recoverPlan, type Disruption } from "./recovery";

function makeTask(
  overrides: Partial<Task> & Pick<Task, "id" | "title">,
): Task {
  return {
    description: "",
    priority: "medium",
    required: true,
    estimatedMinutes: 15,
    requiredSkills: [],
    resourceNeeds: [],
    dependsOnTaskIds: [],
    ...overrides,
  };
}

function makeHousehold(): HouseholdPlan {
  return {
    id: "home-1",
    people: [
      {
        id: "p1",
        name: "Asha",
        skills: ["first aid"],
        available: true,
      },
      {
        id: "p2",
        name: "Ravi",
        skills: ["first aid", "transport"],
        available: true,
      },
    ],
    resources: [
      {
        id: "r1",
        name: "First-aid kit",
        kind: "reusable",
        quantity: 1,
        unit: "kit",
      },
      {
        id: "r2",
        name: "Water bottles",
        kind: "consumable",
        quantity: 6,
        unit: "bottles",
      },
    ],
    locations: [
      {
        id: "l1",
        name: "Home",
        description: "",
      },
      {
        id: "l2",
        name: "Meeting point",
        description: "",
      },
    ],
    tasks: [
      makeTask({
        id: "t1",
        title: "Prepare first-aid kit",
        requiredSkills: ["first aid"],
        resourceNeeds: [{ resourceId: "r1", quantity: 1 }],
      }),
      makeTask({
        id: "t2",
        title: "Arrange transport",
        requiredSkills: ["transport"],
        dependsOnTaskIds: ["t1"],
        locationId: "l2",
      }),
      makeTask({
        id: "t3",
        title: "Prepare drinking water",
        resourceNeeds: [{ resourceId: "r2", quantity: 2 }],
      }),
    ],
  };
}

describe("recoverPlan", () => {
  it("reassigns work when a helper becomes unavailable", () => {
    const household = makeHousehold();

    const result = recoverPlan(household, [
      { type: "person_unavailable", personId: "p1" },
    ]);

    expect(result.recovered).toBe(true);
    expect(result.recoveryPlan.schedule).toHaveLength(3);
    expect(
      result.recoveryPlan.assignedTasks.find((task) => task.id === "t1")
        ?.assignedPersonId,
    ).toBe("p2");
  });

  it("does not use an unavailable resource", () => {
    const result = recoverPlan(makeHousehold(), [
      { type: "resource_unavailable", resourceId: "r1" },
    ]);

    expect(result.recovered).toBe(false);
    expect(result.scenario.resources.find((resource) => resource.id === "r1")?.quantity).toBe(0);
    expect(result.recoveryPlan.schedule.some((entry) => entry.taskId === "t1")).toBe(false);
    expect(result.unresolvedRisks.some((issue) => issue.taskId === "t1")).toBe(true);
  });

  it("blocks tasks at an inaccessible location", () => {
    const result = recoverPlan(makeHousehold(), [
      { type: "location_inaccessible", locationId: "l2" },
    ]);

    expect(result.recovered).toBe(false);
    expect(result.recoveryPlan.schedule.some((entry) => entry.taskId === "t2")).toBe(false);
    expect(result.unresolvedRisks.some(
      (issue) => issue.taskId === "t2" && issue.reason.includes("inaccessible"),
    )).toBe(true);
  });

  it("applies multiple disruptions together", () => {
    const disruptions: Disruption[] = [
      { type: "person_unavailable", personId: "p1" },
      { type: "resource_unavailable", resourceId: "r1" },
      { type: "location_inaccessible", locationId: "l2" },
    ];

    const result = recoverPlan(makeHousehold(), disruptions);

    expect(result.disruptionsApplied).toHaveLength(3);
    expect(result.scenario.people.find((person) => person.id === "p1")?.available).toBe(false);
    expect(result.scenario.resources.find((resource) => resource.id === "r1")?.quantity).toBe(0);
    expect(result.scenario.inaccessibleLocationIds).toContain("l2");
    expect(result.recovered).toBe(false);
  });

  it("does not mutate the original household", () => {
    const household = makeHousehold();
    const before = structuredClone(household);

    recoverPlan(household, [
      { type: "person_unavailable", personId: "p1" },
      { type: "resource_unavailable", resourceId: "r2" },
    ]);

    expect(household).toEqual(before);
  });

  it("produces the same result for identical inputs", () => {
    const household = makeHousehold();
    const disruptions: Disruption[] = [
      { type: "person_unavailable", personId: "p1" },
    ];

    expect(recoverPlan(household, disruptions)).toEqual(
      recoverPlan(household, disruptions),
    );
  });

  it("rejects disruptions targeting unknown IDs", () => {
    expect(() =>
      recoverPlan(makeHousehold(), [
        { type: "person_unavailable", personId: "unknown" },
      ]),
    ).toThrow(/Unknown person ID/);
  });

  it("reports an impossible recovery without claiming success", () => {
    const household = makeHousehold();
    household.people = household.people.map((person) => ({
      ...person,
      available: false,
    }));

    const result = recoverPlan(household, []);

    expect(result.recovered).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.unresolvedRisks.length).toBeGreaterThan(0);
  });
  it("does not claim recovery when duplicate task IDs make completion ambiguous", () => {
  const household = makeHousehold();

  // Create a duplicate of t1 that is excluded by an inaccessible location.
  household.tasks.push({
    ...household.tasks[0]!,
    locationId: "l2",
  });

  const result = recoverPlan(household, [
    { type: "location_inaccessible", locationId: "l2" },
  ]);

  expect(result.complete).toBe(false);
  expect(result.recovered).toBe(false);
});
it("can recover all required tasks while an optional task remains unresolved", () => {
  const household = makeHousehold();

  household.tasks = household.tasks.map((task) =>
    task.id === "t3" ? { ...task, required: false } : task,
  );

  const result = recoverPlan(household, [
    { type: "resource_unavailable", resourceId: "r2" },
  ]);

  expect(result.recovered).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.recoveryPlan.schedule.some((entry) => entry.taskId === "t1")).toBe(true);
  expect(result.recoveryPlan.schedule.some((entry) => entry.taskId === "t2")).toBe(true);
  expect(result.recoveryPlan.schedule.some((entry) => entry.taskId === "t3")).toBe(false);
  expect(result.unresolvedRisks.some((issue) => issue.taskId === "t3")).toBe(true);
});
it("reports both a directly blocked task and its dependent task", () => {
  const household = makeHousehold();

  const result = recoverPlan(household, [
    { type: "resource_unavailable", resourceId: "r1" },
  ]);

  expect(result.recovered).toBe(false);

  expect(
    result.unresolvedRisks.some(
      (issue) =>
        issue.taskId === "t1" &&
        issue.reason.includes("resource") &&
        issue.reason.includes("unavailable"),
    ),
  ).toBe(true);

  expect(
    result.unresolvedRisks.some(
      (issue) =>
        issue.taskId === "t2" &&
        issue.reason.includes("Blocked"),
    ),
  ).toBe(true);

  expect(
    result.recoveryPlan.schedule.some(
      (entry) => entry.taskId === "t3",
    ),
  ).toBe(true);
});
});
// Regression test: audit D3
it("does not report recovery when no optional work can be scheduled", () => {
  const household = makeHousehold();

  household.tasks = household.tasks.map((task) => ({
    ...task,
    required: false,
  }));

  household.people = household.people.map((person) => ({
    ...person,
    available: false,
  }));

  const result = recoverPlan(household, []);

  expect(result.recoveryPlan.schedule).toHaveLength(0);
  expect(result.unresolvedRisks).toHaveLength(household.tasks.length);
  expect(result.recovered).toBe(false);
  expect(result.complete).toBe(false);
});
// Regression test: audit D4
it("itemises tasks when a dependency cycle makes scheduling fail", () => {
  const household = makeHousehold();

  household.tasks = [
    makeTask({
      id: "a",
      title: "Task A",
      dependsOnTaskIds: ["b"],
    }),
    makeTask({
      id: "b",
      title: "Task B",
      dependsOnTaskIds: ["a"],
    }),
  ];

  const result = recoverPlan(household, []);

  expect(result.recoveryPlan.schedulingErrors.length).toBeGreaterThan(0);
  expect(result.recoveryPlan.schedule).toHaveLength(0);
  expect(result.recovered).toBe(false);
  expect(result.complete).toBe(false);

  expect(
    result.unresolvedRisks.map((issue) => issue.taskId).sort(),
  ).toEqual(["a", "b"]);
});
// Regression test: audit D4 — resource over-demand
it("itemises every task when resource demand exceeds stock", () => {
  const household = makeHousehold();

  household.tasks = [
    makeTask({
      id: "w1",
      title: "First resource-intensive task",
      resourceNeeds: [{ resourceId: "r2", quantity: 4 }],
    }),
    makeTask({
      id: "w2",
      title: "Second resource-intensive task",
      resourceNeeds: [{ resourceId: "r2", quantity: 4 }],
    }),
    makeTask({
      id: "free",
      title: "Task without resource requirements",
      resourceNeeds: [],
    }),
  ];

  const result = recoverPlan(household, []);

  expect(result.recoveryPlan.schedulingErrors.length).toBeGreaterThan(0);
  expect(result.recoveryPlan.schedule).toHaveLength(0);
  expect(result.recovered).toBe(false);
  expect(result.complete).toBe(false);

  expect(
    result.unresolvedRisks.map((issue) => issue.taskId).sort(),
  ).toEqual(["free", "w1", "w2"]);
});
// Regression test: audit D5 — unsupported disruption type
it("rejects an unsupported disruption type", () => {
  const invalidDisruption = {
    type: "meteor_strike",
    targetId: "p1",
  } as unknown as Disruption;

  expect(() =>
    recoverPlan(makeHousehold(), [invalidDisruption]),
  ).toThrow(RangeError);

  expect(() =>
    recoverPlan(makeHousehold(), [invalidDisruption]),
  ).toThrow(/meteor_strike/);
});


 // Regression test: audit D6 — nested-state isolation
it("does not share nested arrays between the household and recovery result", () => {
  const household = makeHousehold();
  const result = recoverPlan(household, []);

  const scenarioPerson = result.scenario.people.find(
    (person) => person.id === household.people[0]?.id,
  );
  const originalPerson = household.people[0];

  const plannedTask = result.originalPlan.assignedTasks.find(
    (task) => task.id === household.tasks[0]?.id,
  );
  const originalTask = household.tasks[0];

  expect(scenarioPerson).toBeDefined();
  expect(originalPerson).toBeDefined();
  expect(plannedTask).toBeDefined();
  expect(originalTask).toBeDefined();

  if (!scenarioPerson || !originalPerson || !plannedTask || !originalTask) {
    throw new Error("Expected sample household people and tasks to exist.");
  }

  expect(scenarioPerson.skills).not.toBe(originalPerson.skills);
  expect(plannedTask.requiredSkills).not.toBe(originalTask.requiredSkills);
  expect(plannedTask.resourceNeeds).not.toBe(originalTask.resourceNeeds);
});

// Regression test: audit D5 — missing disruption target
it("rejects a person-unavailable disruption with a missing personId", () => {
  const invalidDisruption = {
    type: "person_unavailable",
  } as unknown as Disruption;

  expect(() =>
    recoverPlan(makeHousehold(), [invalidDisruption]),
  ).toThrow(RangeError);
});
