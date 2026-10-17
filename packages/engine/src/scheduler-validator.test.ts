import { describe, expect, it } from "vitest";
import { TaskSchema, PersonSchema, ResourceSchema } from "./index";
import type { Person, Resource, Task } from "./index";
import { createSchedule } from "./scheduler";
import type { SchedulingContext } from "./scheduler";
import { validateSchedule } from "./validator";

// ---------- Helpers ----------

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

function person(id: string) {
  return PersonSchema.parse({ id, name: `Person ${id}`, available: true });
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

const needR1 = [{ resourceId: "R1", quantity: 1 }];

interface Scenario {
  name: string;
  tasks: Task[];
  context: SchedulingContext;
}

const scenarios: Scenario[] = [
  {
    name: "plain dependency chain",
    tasks: [
      task("A", 30),
      task("B", 20, { dependsOn: ["A"] }),
      task("C", 10, { dependsOn: ["B"] }),
    ],
    context: {},
  },
  {
    name: "diamond dependencies",
    tasks: [
      task("A", 10),
      task("B", 10, { dependsOn: ["A"] }),
      task("C", 20, { dependsOn: ["A"] }),
      task("D", 10, { dependsOn: ["B", "C"] }),
    ],
    context: {},
  },
  {
    name: "same person serialised",
    tasks: [
      task("A", 30, { person: "P1" }),
      task("B", 20, { person: "P1" }),
      task("C", 15, { person: "P2" }),
    ],
    context: { people: [person("P1"), person("P2")] },
  },
  {
    name: "capacity-1 reusable resource",
    tasks: [
      task("A", 20, { needs: needR1 }),
      task("B", 20, { needs: needR1 }),
      task("C", 10, { dependsOn: ["B"] }),
    ],
    context: { resources: [reusable("R1", 1)] },
  },
  {
    name: "three tasks on a capacity-2 resource",
    tasks: [
      task("A", 30, { needs: needR1 }),
      task("B", 30, { needs: needR1 }),
      task("C", 30, { needs: needR1 }),
    ],
    context: { resources: [reusable("R1", 2)] },
  },
  {
    name: "consumable stock exactly used",
    tasks: [
      task("A", 10, { needs: [{ resourceId: "C1", quantity: 3 }] }),
      task("B", 10, { needs: [{ resourceId: "C1", quantity: 2 }] }),
    ],
    context: { resources: [consumable("C1", 5)] },
  },
  {
    name: "mixed people, resources and dependencies",
    tasks: [
      task("A", 20, { person: "P1", needs: needR1 }),
      task("B", 20, { person: "P2", needs: needR1 }),
      task("C", 10, { person: "P1" }),
      task("D", 10, { dependsOn: ["A"], needs: needR1 }),
      task("E", 10, { priority: "low", person: "P2" }),
    ],
    context: {
      people: [person("P1"), person("P2")],
      resources: [reusable("R1", 1)],
    },
  },
];

describe("scheduler output is accepted by the independent validator", () => {
  it.each(scenarios)("$name", ({ tasks, context }) => {
    const result = createSchedule(tasks, context);

    expect(result.feasible).toBe(true);

    const validation = validateSchedule(tasks, result.schedule, context);
    expect(validation.violations).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("holds for 200 generated scenarios", () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 200; seed++) {
      const { tasks, context } = generateScenario(seed);
      const result = createSchedule(tasks, context);

      if (!result.feasible) {
        failures.push(`seed ${seed}: scheduler infeasible: ${result.errors.join("; ")}`);
        continue;
      }

      const validation = validateSchedule(tasks, result.schedule, context);
      if (!validation.valid) {
        failures.push(
          `seed ${seed}: ${validation.violations.map((v) => `${v.type}: ${v.message}`).join("; ")}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("the validator catches tampering with scheduler output", () => {
  it("rejects a schedule edited to break reusable capacity", () => {
    const tasks = [task("A", 20, { needs: needR1 }), task("B", 20, { needs: needR1 })];
    const context: SchedulingContext = { resources: [reusable("R1", 1)] };
    const result = createSchedule(tasks, context);

    expect(validateSchedule(tasks, result.schedule, context).valid).toBe(true);

    const tampered = result.schedule.map((entry) =>
      entry.taskId === "B" ? { ...entry, startMinute: 0, endMinute: 20 } : entry,
    );
    const validation = validateSchedule(tasks, tampered, context);

    expect(validation.valid).toBe(false);
    expect(validation.violations.map((v) => v.type)).toContain("RESOURCE_CAPACITY_EXCEEDED");
  });

  it("rejects a schedule edited to break a dependency", () => {
    const tasks = [task("A", 30), task("B", 20, { dependsOn: ["A"] })];
    const result = createSchedule(tasks);

    expect(validateSchedule(tasks, result.schedule).valid).toBe(true);

    const tampered = result.schedule.map((entry) =>
      entry.taskId === "B" ? { ...entry, startMinute: 10, endMinute: 30 } : entry,
    );
    const validation = validateSchedule(tasks, tampered);

    expect(validation.valid).toBe(false);
    expect(validation.violations.map((v) => v.type)).toContain("DEPENDENCY_VIOLATION");
  });
});

// ---------- Seeded scenario generator (no dependencies, fully repeatable) ----------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function taskId(index: number): string {
  return `T${String(index + 1).padStart(2, "0")}`;
}

function generateScenario(seed: number): {
  tasks: Task[];
  context: { people: Person[]; resources: Resource[] };
} {
  const rng = makeRng(seed);
  const priorities = ["low", "medium", "high", "critical"] as const;
  const count = 3 + Math.floor(rng() * 8);
  const tasks: Task[] = [];

  for (let i = 0; i < count; i++) {
    const dependsOn: string[] = [];
    for (let j = 0; j < i; j++) {
      if (rng() < 0.25) dependsOn.push(taskId(j));
    }

    const needs: Array<{ resourceId: string; quantity: number }> = [];
    if (rng() < 0.5) needs.push({ resourceId: "R1", quantity: 1 + Math.floor(rng() * 2) });
    if (rng() < 0.3) needs.push({ resourceId: "R2", quantity: 1 });
    if (rng() < 0.3) needs.push({ resourceId: "C1", quantity: 1 + Math.floor(rng() * 3) });

    tasks.push(
      TaskSchema.parse({
        id: taskId(i),
        title: `Generated ${taskId(i)}`,
        priority: priorities[Math.floor(rng() * 4)],
        estimatedMinutes: 5 * (1 + Math.floor(rng() * 6)),
        dependsOnTaskIds: dependsOn,
        assignedPersonId: rng() < 0.6 ? `P${1 + Math.floor(rng() * 3)}` : undefined,
        resourceNeeds: needs,
      }),
    );
  }

  return {
    tasks,
    context: {
      people: [person("P1"), person("P2"), person("P3")],
      resources: [reusable("R1", 2), reusable("R2", 1), consumable("C1", 1000)],
    },
  };
}