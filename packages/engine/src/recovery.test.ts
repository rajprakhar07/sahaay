
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
});
