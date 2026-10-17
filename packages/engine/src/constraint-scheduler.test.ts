import { describe, expect, it } from "vitest";
import { TaskSchema, PersonSchema, ResourceSchema } from "./index";
import { createSchedule } from "./scheduler";
import type { ScheduledTask } from "./scheduler";

describe("Constraint scheduling models", () => {
  it("represents an unavailable person", () => {
    const person = PersonSchema.parse({
      id: "P01",
      name: "Asha",
      available: false,
    });

    expect(person.available).toBe(false);
  });

  it("represents a reusable resource with limited quantity", () => {
    const resource = ResourceSchema.parse({
      id: "R01",
      name: "First-aid kit",
      kind: "reusable",
      quantity: 1,
      unit: "kit",
    });

    expect(resource.kind).toBe("reusable");
    expect(resource.quantity).toBe(1);
  });

  it("represents a consumable resource", () => {
    const resource = ResourceSchema.parse({
      id: "R02",
      name: "Water",
      kind: "consumable",
      quantity: 5,
      unit: "litres",
    });

    expect(resource.kind).toBe("consumable");
    expect(resource.quantity).toBe(5);
  });

  it("parses a task requiring a specific resource quantity", () => {
    const task = TaskSchema.parse({
      id: "T01",
      title: "Prepare first-aid supplies",
      priority: "high",
      estimatedMinutes: 15,
      resourceNeeds: [{ resourceId: "R01", quantity: 1 }],
    });

    expect(task.resourceNeeds).toEqual([
      { resourceId: "R01", quantity: 1 },
    ]);
  });
});

// ---------- Helpers for behavioral tests ----------

interface TaskOptions {
  priority?: "low" | "medium" | "high" | "critical";
  dependsOn?: string[];
  person?: string;
  needs?: Array<{ resourceId: string; quantity: number }>;
}

function task(id: string, minutes: number, options: TaskOptions = {}) {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    priority: options.priority ?? "medium",
    estimatedMinutes: minutes,
    dependsOnTaskIds: options.dependsOn ?? [],
    assignedPersonId: options.person,
    resourceNeeds: options.needs ?? [],
  });
}

function person(id: string, available = true) {
  return PersonSchema.parse({ id, name: `Person ${id}`, available });
}

function reusable(id: string, quantity: number) {
  return ResourceSchema.parse({
    id,
    name: `Reusable ${id}`,
    kind: "reusable",
    quantity,
    unit: "unit",
  });
}

function consumable(id: string, quantity: number) {
  return ResourceSchema.parse({
    id,
    name: `Consumable ${id}`,
    kind: "consumable",
    quantity,
    unit: "litres",
  });
}

function entry(schedule: readonly ScheduledTask[], taskId: string) {
  return schedule.find((item) => item.taskId === taskId);
}

// Independent check: how many of the given tasks run at the same moment, at most.
function peakConcurrency(
  schedule: readonly ScheduledTask[],
  taskIds: readonly string[],
): number {
  const items = schedule.filter((item) => taskIds.includes(item.taskId));
  let peak = 0;
  for (const item of items) {
    const concurrent = items.filter(
      (other) =>
        other.startMinute <= item.startMinute &&
        item.startMinute < other.endMinute,
    ).length;
    peak = Math.max(peak, concurrent);
  }
  return peak;
}

describe("createSchedule with people and resources", () => {
  // ----- People -----

  it("rejects a task explicitly assigned to an unavailable person", () => {
    const result = createSchedule([task("T1", 30, { person: "P1" })], {
      people: [person("P1", false)],
    });

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(
      result.errors.some(
        (e) => e.includes("T1") && e.includes("P1") && e.includes("unavailable"),
      ),
    ).toBe(true);
  });

  it("accepts a task assigned to an available person", () => {
    const result = createSchedule([task("A", 30, { person: "P1" })], {
      people: [person("P1")],
    });

    expect(result.feasible).toBe(true);
    expect(result.schedule).toEqual([
      { taskId: "A", startMinute: 0, endMinute: 30 },
    ]);
  });

  it("reports an assignment to an unknown person", () => {
    const result = createSchedule([task("T1", 30, { person: "P9" })], {
      people: [person("P1")],
    });

    expect(result.feasible).toBe(false);
    expect(
      result.errors.some((e) => e.includes("T1") && e.includes("unknown person")),
    ).toBe(true);
  });

  it("serialises tasks of the same person, allowing touching intervals", () => {
    const result = createSchedule(
      [task("A", 30, { person: "P1" }), task("B", 20, { person: "P1" })],
      { people: [person("P1")] },
    );

    expect(result.feasible).toBe(true);
    expect(result.schedule).toEqual([
      { taskId: "A", startMinute: 0, endMinute: 30 },
      { taskId: "B", startMinute: 30, endMinute: 50 },
    ]);
  });

  it("runs tasks of different people in parallel", () => {
    const result = createSchedule(
      [task("A", 30, { person: "P1" }), task("B", 30, { person: "P2" })],
      { people: [person("P1"), person("P2")] },
    );

    expect(result.feasible).toBe(true);
    expect(result.schedule.every((item) => item.startMinute === 0)).toBe(true);
  });

  // ----- Reusable resources -----

  it("serialises tasks that share a reusable resource of capacity 1", () => {
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const result = createSchedule(
      [task("A", 20, { needs }), task("B", 20, { needs })],
      { resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(true);
    expect(entry(result.schedule, "A")?.startMinute).toBe(0);
    expect(entry(result.schedule, "B")?.startMinute).toBe(20);
  });

  it("counts all overlapping tasks, not just one pair (regression)", () => {
    // Capacity 2, three tasks each needing 1: every pair fits, all three do not.
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const result = createSchedule(
      [
        task("A", 30, { needs }),
        task("B", 30, { needs }),
        task("C", 30, { needs }),
      ],
      { resources: [reusable("R1", 2)] },
    );

    expect(result.feasible).toBe(true);
    expect(peakConcurrency(result.schedule, ["A", "B", "C"])).toBeLessThanOrEqual(2);
    expect(entry(result.schedule, "A")?.startMinute).toBe(0);
    expect(entry(result.schedule, "B")?.startMinute).toBe(0);
    expect(entry(result.schedule, "C")?.startMinute).toBe(30);
  });

  it("does not over-reject when overlapping tasks never run together", () => {
    // Capacity 2. C overlaps both A [0,10) and B [20,30), but A and B never
    // overlap each other, so demand never exceeds 2 and C may start at 0.
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const result = createSchedule(
      [
        task("A", 10, { needs }),
        task("G", 10, { dependsOn: ["A"] }),
        task("B", 10, { dependsOn: ["G"], needs }),
        task("C", 30, { priority: "low", needs }),
      ],
      { resources: [reusable("R1", 2)] },
    );

    expect(result.feasible).toBe(true);
    expect(entry(result.schedule, "A")).toEqual({
      taskId: "A",
      startMinute: 0,
      endMinute: 10,
    });
    expect(entry(result.schedule, "B")).toEqual({
      taskId: "B",
      startMinute: 20,
      endMinute: 30,
    });
    expect(entry(result.schedule, "C")).toEqual({
      taskId: "C",
      startMinute: 0,
      endMinute: 30,
    });
  });

  it("rejects a task that needs more of a reusable resource than exists", () => {
    const result = createSchedule(
      [task("T1", 10, { needs: [{ resourceId: "R1", quantity: 2 }] })],
      { resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(
      result.errors.some((e) => e.includes("T1") && e.includes("R1")),
    ).toBe(true);
  });

  // ----- Consumable resources -----

  it("rejects total consumable demand above stock", () => {
    const needs = [{ resourceId: "R2", quantity: 3 }];
    const result = createSchedule(
      [task("A", 10, { needs }), task("B", 10, { needs })],
      { resources: [consumable("R2", 5)] },
    );

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(
      result.errors.some(
        (e) => e.includes("R2") && e.includes("6") && e.includes("5"),
      ),
    ).toBe(true);
  });

  it("accepts consumable demand exactly equal to stock", () => {
    const result = createSchedule(
      [
        task("A", 10, { needs: [{ resourceId: "R2", quantity: 3 }] }),
        task("B", 10, { needs: [{ resourceId: "R2", quantity: 2 }] }),
      ],
      { resources: [consumable("R2", 5)] },
    );

    expect(result.feasible).toBe(true);
  });

  it("does not serialise tasks that merely draw on a consumable stock", () => {
    const needs = [{ resourceId: "R2", quantity: 2 }];
    const result = createSchedule(
      [task("A", 10, { needs }), task("B", 10, { needs })],
      { resources: [consumable("R2", 5)] },
    );

    expect(result.feasible).toBe(true);
    expect(result.schedule.every((item) => item.startMinute === 0)).toBe(true);
  });

  // ----- Errors -----

  it("reports a task that requires an unknown resource", () => {
    const result = createSchedule(
      [task("T1", 10, { needs: [{ resourceId: "R9", quantity: 1 }] })],
      { resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(false);
    expect(
      result.errors.some((e) => e.includes("T1") && e.includes("R9")),
    ).toBe(true);
  });

  it("reports several independent problems together", () => {
    const result = createSchedule(
      [
        task("T1", 10, { person: "P1" }),
        task("T2", 10, { needs: [{ resourceId: "R9", quantity: 1 }] }),
      ],
      { people: [person("P1", false)], resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it("reports a duplicate task ID instead of silently dropping a task", () => {
    const result = createSchedule([task("A", 10), task("A", 20)]);

    expect(result.feasible).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Duplicate") && e.includes("A")),
    ).toBe(true);
  });

  // ----- Dependencies still work alongside constraints -----

  it("respects dependencies when resource contention delays a prerequisite", () => {
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const result = createSchedule(
      [
        task("A", 20, { needs }),
        task("B", 20, { needs }),
        task("C", 10, { dependsOn: ["B"] }),
      ],
      { resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(true);
    expect(entry(result.schedule, "B")?.startMinute).toBe(20);
    expect(entry(result.schedule, "C")?.startMinute).toBe(40);
  });

  it("still rejects a dependency cycle when a context is supplied", () => {
    const result = createSchedule(
      [task("A", 10, { dependsOn: ["B"] }), task("B", 10, { dependsOn: ["A"] })],
      { people: [person("P1")], resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(false);
    expect(result.errors.some((e) => e.includes("Dependency cycle"))).toBe(true);
  });

  it("still reports a dependency on a missing task", () => {
    const result = createSchedule([task("A", 10, { dependsOn: ["MISSING"] })]);

    expect(result.feasible).toBe(false);
    expect(
      result.errors.some((e) => e.includes('missing task "MISSING"')),
    ).toBe(true);
  });

  // ----- Determinism and priority -----

  it("gives the same schedule regardless of input order", () => {
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const tasks = [
      task("A", 20, { person: "P1", needs }),
      task("B", 20, { person: "P2", needs }),
      task("C", 10, { person: "P1" }),
      task("D", 10, { dependsOn: ["A"], needs }),
      task("E", 10, { priority: "low", person: "P2" }),
    ];
    const context = {
      people: [person("P1"), person("P2")],
      resources: [reusable("R1", 1)],
    };

    const forward = createSchedule(tasks, context);
    const reversed = createSchedule([...tasks].reverse(), context);
    const rotated = createSchedule([...tasks.slice(2), ...tasks.slice(0, 2)], context);

    expect(forward.feasible).toBe(true);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
    expect(createSchedule(tasks, context)).toEqual(forward);
  });

  it("places higher-priority tasks first under contention", () => {
    const needs = [{ resourceId: "R1", quantity: 1 }];
    const result = createSchedule(
      [
        task("A", 10, { priority: "low", needs }),
        task("Z", 10, { priority: "critical", needs }),
      ],
      { resources: [reusable("R1", 1)] },
    );

    expect(result.feasible).toBe(true);
    expect(entry(result.schedule, "Z")?.startMinute).toBe(0);
    expect(entry(result.schedule, "A")?.startMinute).toBe(10);
  });
});