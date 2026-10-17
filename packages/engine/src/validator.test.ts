import { describe, expect, it } from "vitest";
import { TaskSchema, PersonSchema, ResourceSchema } from "./index";
import { validateSchedule } from "./validator";
import type { ScheduleEntry, ValidationResult } from "./validator";

// ---------- Helpers (hand-built data only; no scheduler involved) ----------

interface TaskOptions {
  dependsOn?: string[];
  person?: string;
  needs?: Array<{ resourceId: string; quantity: number }>;
}

function task(id: string, minutes: number, options: TaskOptions = {}) {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    priority: "medium",
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

function at(taskId: string, startMinute: number, endMinute: number): ScheduleEntry {
  return { taskId, startMinute, endMinute };
}

function typesOf(result: ValidationResult): string[] {
  return result.violations.map((violation) => violation.type);
}

function firstOf(result: ValidationResult, type: string) {
  return result.violations.find((violation) => violation.type === type);
}

const needR1 = [{ resourceId: "R1", quantity: 1 }];

// ---------- Tests ----------

describe("validateSchedule: valid schedules", () => {
  it("accepts a single correct entry with zero violations", () => {
    const result = validateSchedule([task("A", 30)], [at("A", 0, 30)]);

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("accepts a task that starts exactly when its prerequisite ends", () => {
    const result = validateSchedule(
      [task("A", 30), task("B", 20, { dependsOn: ["A"] })],
      [at("A", 0, 30), at("B", 30, 50)],
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("accepts an empty plan with an empty schedule", () => {
    expect(validateSchedule([], [])).toEqual({ valid: true, violations: [] });
  });
});

describe("validateSchedule: task coverage", () => {
  it("reports a task that is missing from the schedule", () => {
    const result = validateSchedule([task("A", 10), task("B", 10)], [at("A", 0, 10)]);

    expect(typesOf(result)).toEqual(["MISSING_TASK"]);
    expect(result.violations[0]?.taskIds).toEqual(["B"]);
    expect(result.valid).toBe(false);
  });

  it("reports a schedule entry for an unknown task", () => {
    const result = validateSchedule([task("A", 10)], [at("A", 0, 10), at("Z", 0, 10)]);

    expect(typesOf(result)).toEqual(["UNKNOWN_TASK"]);
    expect(result.violations[0]?.taskIds).toEqual(["Z"]);
  });

  it("reports duplicate entries for the same task", () => {
    const result = validateSchedule([task("A", 10)], [at("A", 0, 10), at("A", 0, 10)]);

    expect(typesOf(result)).toEqual(["DUPLICATE_ENTRY"]);
    expect(firstOf(result, "DUPLICATE_ENTRY")?.message).toContain("2 times");
  });

  it("reports duplicate task IDs in the task list", () => {
    const result = validateSchedule([task("A", 10), task("A", 10)], [at("A", 0, 10)]);

    expect(typesOf(result)).toEqual(["DUPLICATE_TASK_ID"]);
  });
});

describe("validateSchedule: times and durations", () => {
  it("reports a negative start time and nothing else", () => {
    const result = validateSchedule([task("A", 30)], [at("A", -5, 25)]);

    expect(typesOf(result)).toEqual(["INVALID_TIME"]);
  });

  it("reports an interval whose end equals its start", () => {
    const result = validateSchedule([task("A", 30)], [at("A", 10, 10)]);

    expect(typesOf(result)).toEqual(["INVALID_TIME"]);
  });

  it("reports non-integer times", () => {
    const result = validateSchedule([task("A", 30)], [at("A", 0.5, 30.5)]);

    expect(typesOf(result)).toEqual(["INVALID_TIME"]);
  });

  it("reports a scheduled duration shorter than the task needs", () => {
    const result = validateSchedule([task("A", 30)], [at("A", 0, 20)]);

    expect(typesOf(result)).toEqual(["INVALID_DURATION"]);
    expect(result.violations[0]?.taskIds).toEqual(["A"]);
  });

  it("reports a scheduled duration longer than the task needs", () => {
    const result = validateSchedule([task("A", 30)], [at("A", 0, 45)]);

    expect(typesOf(result)).toEqual(["INVALID_DURATION"]);
  });
});

describe("validateSchedule: dependencies", () => {
  it("reports a task that starts before its prerequisite ends", () => {
    const result = validateSchedule(
      [task("A", 30), task("B", 20, { dependsOn: ["A"] })],
      [at("A", 0, 30), at("B", 20, 40)],
    );

    expect(typesOf(result)).toEqual(["DEPENDENCY_VIOLATION"]);
    expect(result.violations[0]?.taskIds).toEqual(["A", "B"]);
  });

  it("reports a task that starts at the same minute as its prerequisite", () => {
    const result = validateSchedule(
      [task("A", 30), task("B", 20, { dependsOn: ["A"] })],
      [at("A", 0, 30), at("B", 0, 20)],
    );

    expect(typesOf(result)).toEqual(["DEPENDENCY_VIOLATION"]);
  });

  it("reports a scheduled task whose prerequisite is not scheduled", () => {
    const result = validateSchedule(
      [task("A", 10), task("B", 20, { dependsOn: ["A"] })],
      [at("B", 0, 20)],
    );

    expect(typesOf(result)).toEqual(["DEPENDENCY_VIOLATION", "MISSING_TASK"]);
  });

  it("reports a dependency on an unknown task", () => {
    const result = validateSchedule(
      [task("A", 10, { dependsOn: ["MISSING"] })],
      [at("A", 0, 10)],
    );

    expect(typesOf(result)).toEqual(["UNKNOWN_DEPENDENCY"]);
    expect(result.violations[0]?.message).toContain("MISSING");
  });

  it("can never accept a schedule for a dependency cycle", () => {
    const tasks = [
      task("A", 10, { dependsOn: ["B"] }),
      task("B", 10, { dependsOn: ["A"] }),
    ];

    const aFirst = validateSchedule(tasks, [at("A", 0, 10), at("B", 10, 20)]);
    const bFirst = validateSchedule(tasks, [at("A", 10, 20), at("B", 0, 10)]);

    expect(aFirst.valid).toBe(false);
    expect(typesOf(aFirst)).toContain("DEPENDENCY_VIOLATION");
    expect(bFirst.valid).toBe(false);
    expect(typesOf(bFirst)).toContain("DEPENDENCY_VIOLATION");
  });
});

describe("validateSchedule: people", () => {
  it("reports overlapping tasks of the same person", () => {
    const result = validateSchedule(
      [task("A", 30, { person: "P1" }), task("B", 30, { person: "P1" })],
      [at("A", 0, 30), at("B", 10, 40)],
      { people: [person("P1")] },
    );

    expect(typesOf(result)).toEqual(["PERSON_OVERLAP"]);
    expect(result.violations[0]?.personIds).toEqual(["P1"]);
    expect(result.violations[0]?.taskIds).toEqual(["A", "B"]);
  });

  it("reports an overlap of a single minute", () => {
    const result = validateSchedule(
      [task("A", 30, { person: "P1" }), task("B", 11, { person: "P1" })],
      [at("A", 0, 30), at("B", 29, 40)],
      { people: [person("P1")] },
    );

    expect(typesOf(result)).toEqual(["PERSON_OVERLAP"]);
  });

  it("accepts back-to-back tasks of the same person", () => {
    const result = validateSchedule(
      [task("A", 30, { person: "P1" }), task("B", 20, { person: "P1" })],
      [at("A", 0, 30), at("B", 30, 50)],
      { people: [person("P1")] },
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("accepts simultaneous tasks of different people", () => {
    const result = validateSchedule(
      [task("A", 30, { person: "P1" }), task("B", 30, { person: "P2" })],
      [at("A", 0, 30), at("B", 0, 30)],
      { people: [person("P1"), person("P2")] },
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("reports a task assigned to an unavailable person", () => {
    const result = validateSchedule(
      [task("A", 10, { person: "P1" })],
      [at("A", 0, 10)],
      { people: [person("P1", false)] },
    );

    expect(typesOf(result)).toEqual(["UNAVAILABLE_PERSON"]);
    expect(result.violations[0]?.personIds).toEqual(["P1"]);
    expect(result.violations[0]?.taskIds).toEqual(["A"]);
  });

  it("reports a task assigned to an unknown person", () => {
    const result = validateSchedule(
      [task("A", 10, { person: "P9" })],
      [at("A", 0, 10)],
      { people: [person("P1")] },
    );

    expect(typesOf(result)).toEqual(["UNKNOWN_PERSON"]);
    expect(result.violations[0]?.personIds).toEqual(["P9"]);
  });

  it("does not check availability or existence without a people context", () => {
    const result = validateSchedule([task("A", 10, { person: "P9" })], [at("A", 0, 10)]);

    expect(result).toEqual({ valid: true, violations: [] });
  });
});

describe("validateSchedule: resources", () => {
  it("reports a task that requires an unknown resource", () => {
    const result = validateSchedule(
      [task("A", 10, { needs: [{ resourceId: "R9", quantity: 1 }] })],
      [at("A", 0, 10)],
      { resources: [reusable("R1", 1)] },
    );

    expect(typesOf(result)).toEqual(["UNKNOWN_RESOURCE"]);
    expect(result.violations[0]?.resourceIds).toEqual(["R9"]);
  });

  it("reports two tasks using a capacity-1 resource at the same time", () => {
    const result = validateSchedule(
      [task("A", 20, { needs: needR1 }), task("B", 20, { needs: needR1 })],
      [at("A", 0, 20), at("B", 0, 20)],
      { resources: [reusable("R1", 1)] },
    );

    expect(typesOf(result)).toEqual(["RESOURCE_CAPACITY_EXCEEDED"]);
    expect(result.violations[0]?.resourceIds).toEqual(["R1"]);
    expect(result.violations[0]?.taskIds).toEqual(["A", "B"]);
  });

  it("counts all overlapping tasks: staggered tasks that pairwise fit", () => {
    // Capacity 2. Every pair fits; at minute 20 all three are running.
    const result = validateSchedule(
      [
        task("A", 30, { needs: needR1 }),
        task("B", 30, { needs: needR1 }),
        task("C", 30, { needs: needR1 }),
      ],
      [at("A", 0, 30), at("B", 10, 40), at("C", 20, 50)],
      { resources: [reusable("R1", 2)] },
    );

    expect(typesOf(result)).toEqual(["RESOURCE_CAPACITY_EXCEEDED"]);
    expect(result.violations[0]?.taskIds).toEqual(["A", "B", "C"]);
  });

  it("detects a peak that happens in the middle of a long task", () => {
    // C runs 0-30. A and B start later and together push demand to 3 at minute 5.
    const result = validateSchedule(
      [
        task("C", 30, { needs: needR1 }),
        task("A", 10, { needs: needR1 }),
        task("B", 10, { needs: needR1 }),
      ],
      [at("C", 0, 30), at("A", 0, 10), at("B", 5, 15)],
      { resources: [reusable("R1", 2)] },
    );

    expect(typesOf(result)).toEqual(["RESOURCE_CAPACITY_EXCEEDED"]);
  });

  it("accepts back-to-back use of a capacity-1 resource", () => {
    const result = validateSchedule(
      [task("A", 20, { needs: needR1 }), task("B", 20, { needs: needR1 })],
      [at("A", 0, 20), at("B", 20, 40)],
      { resources: [reusable("R1", 1)] },
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("does not over-report when overlapping tasks never run together", () => {
    // Capacity 2. C overlaps A and B, but A and B never overlap each other.
    const result = validateSchedule(
      [
        task("A", 10, { needs: needR1 }),
        task("G", 10, { dependsOn: ["A"] }),
        task("B", 10, { dependsOn: ["G"], needs: needR1 }),
        task("C", 30, { needs: needR1 }),
      ],
      [at("A", 0, 10), at("G", 10, 20), at("B", 20, 30), at("C", 0, 30)],
      { resources: [reusable("R1", 2)] },
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("reports a single task that needs more than the total capacity", () => {
    const result = validateSchedule(
      [task("T1", 10, { needs: [{ resourceId: "R1", quantity: 2 }] })],
      [at("T1", 0, 10)],
      { resources: [reusable("R1", 1)] },
    );

    expect(typesOf(result)).toEqual(["RESOURCE_CAPACITY_EXCEEDED"]);
    expect(result.violations[0]?.taskIds).toEqual(["T1"]);
  });

  it("adds up repeated needs for the same resource within one task", () => {
    const result = validateSchedule(
      [
        task("T1", 10, {
          needs: [
            { resourceId: "R1", quantity: 1 },
            { resourceId: "R1", quantity: 1 },
          ],
        }),
      ],
      [at("T1", 0, 10)],
      { resources: [reusable("R1", 1)] },
    );

    expect(typesOf(result)).toEqual(["RESOURCE_CAPACITY_EXCEEDED"]);
  });

  it("reports total consumable use above stock", () => {
    const needs = [{ resourceId: "R2", quantity: 3 }];
    const result = validateSchedule(
      [task("A", 10, { needs }), task("B", 10, { needs })],
      [at("A", 0, 10), at("B", 10, 20)],
      { resources: [consumable("R2", 5)] },
    );

    expect(typesOf(result)).toEqual(["CONSUMABLE_STOCK_EXCEEDED"]);
    expect(result.violations[0]?.resourceIds).toEqual(["R2"]);
    expect(result.violations[0]?.taskIds).toEqual(["A", "B"]);
    expect(result.violations[0]?.message).toContain("6");
    expect(result.violations[0]?.message).toContain("5");
  });

  it("accepts consumable use exactly equal to stock, even in parallel", () => {
    const result = validateSchedule(
      [
        task("A", 10, { needs: [{ resourceId: "R2", quantity: 3 }] }),
        task("B", 10, { needs: [{ resourceId: "R2", quantity: 2 }] }),
      ],
      [at("A", 0, 10), at("B", 0, 10)],
      { resources: [consumable("R2", 5)] },
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("does not check resources without a resources context", () => {
    const result = validateSchedule(
      [task("A", 20, { needs: needR1 }), task("B", 20, { needs: needR1 })],
      [at("A", 0, 20), at("B", 0, 20)],
    );

    expect(result).toEqual({ valid: true, violations: [] });
  });
});

describe("validateSchedule: reporting", () => {
  const tasks = [
    task("T1", 10, { person: "P1" }),
    task("T2", 10, { needs: [{ resourceId: "R9", quantity: 1 }] }),
    task("T3", 10),
  ];
  const schedule = [at("T1", 0, 10), at("T2", 0, 10)];
  const context = { people: [person("P1", false)], resources: [reusable("R1", 1)] };

  it("reports several independent violations together", () => {
    const result = validateSchedule(tasks, schedule, context);

    expect(result.valid).toBe(false);
    expect(typesOf(result)).toEqual(["MISSING_TASK", "UNAVAILABLE_PERSON", "UNKNOWN_RESOURCE"]);
  });

  it("is deterministic and independent of schedule order", () => {
    const forward = validateSchedule(tasks, schedule, context);
    const reversed = validateSchedule(tasks, [...schedule].reverse(), context);

    expect(reversed).toEqual(forward);
    expect(validateSchedule(tasks, schedule, context)).toEqual(forward);
  });
});