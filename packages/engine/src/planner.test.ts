
import { describe, expect, it } from "vitest";
import type { Person, Task } from "./index";
import { createPlan } from "./planner";

const people: Person[] = [
  {
    id: "p1",
    name: "Asha",
    skills: ["first aid"],
    available: true,
  },
  {
    id: "p2",
    name: "Ravi",
    skills: ["transport"],
    available: true,
  },
];

function task(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
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

describe("createPlan integration", () => {
  it("creates and validates a plan when assignments are feasible", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Prepare first-aid kit",
        requiredSkills: ["first aid"],
      }),
      task({
        id: "t2",
        title: "Arrange transport",
        requiredSkills: ["transport"],
        dependsOnTaskIds: ["t1"],
      }),
    ];

    const result = createPlan(tasks, people);

    expect(result.complete).toBe(true);
    expect(result.feasible).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.schedule).toHaveLength(2);

    const first = result.schedule.find((entry) => entry.taskId === "t1");
    const second = result.schedule.find((entry) => entry.taskId === "t2");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.startMinute).toBeGreaterThanOrEqual(first!.endMinute);
  });

  it("does not assign a task to an unavailable person", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Prepare kit",
        requiredSkills: ["first aid"],
      }),
    ];

    const result = createPlan(tasks, [
      { ...people[0]!, available: false },
      people[1]!,
    ]);

    expect(result.complete).toBe(false);
    expect(result.feasible).toBe(false);
    expect(result.unassignedTasks.some((item) => item.taskId === "t1")).toBe(
      true,
    );
    expect(result.schedule).toHaveLength(0);
  });

  it("blocks a dependent task when its prerequisite cannot be assigned", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Prepare kit",
        requiredSkills: ["first aid"],
      }),
      task({
        id: "t2",
        title: "Use prepared kit",
        dependsOnTaskIds: ["t1"],
      }),
    ];

    const result = createPlan(tasks, [
      { ...people[0]!, available: false },
      people[1]!,
    ]);

    expect(result.complete).toBe(false);
    expect(result.feasible).toBe(false);
    expect(result.schedule.some((entry) => entry.taskId === "t1")).toBe(false);
    expect(result.schedule.some((entry) => entry.taskId === "t2")).toBe(false);
    expect(
      result.unassignedTasks.some(
        (item) => item.taskId === "t2" && item.reason.includes("Blocked"),
      ),
    ).toBe(true);
  });

  it("reports an impossible required assignment honestly", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Perform specialist task",
        requiredSkills: ["specialist skill"],
      }),
    ];

    const result = createPlan(tasks, people);

    expect(result.complete).toBe(false);
    expect(result.feasible).toBe(false);
    expect(result.unassignedTasks).toHaveLength(1);
    expect(result.schedule).toHaveLength(0);
  });

  it("does not silently accept duplicate task IDs", () => {
    const tasks = [
      task({ id: "t1", title: "First task" }),
      task({ id: "t1", title: "Duplicate task" }),
    ];

    const result = createPlan(tasks, people);

    expect(result.complete).toBe(false);
    expect(result.feasible).toBe(false);
  });
});
