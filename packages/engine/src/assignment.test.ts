
import { describe, expect, it } from "vitest";
import { assignTasks } from "./assignment";
import type { Person, Task } from "./index";

const people: Person[] = [
  {
    id: "alice",
    name: "Alice",
    skills: ["Python", "SQL"],
    available: true,
  },
  {
    id: "bob",
    name: "Bob",
    skills: ["Java", "SQL"],
    available: true,
  },
  {
    id: "busy",
    name: "Busy Person",
    skills: ["Python", "Java"],
    available: false,
  },
];

function makeTask(
  overrides: Partial<Task> & Pick<Task, "id">,
): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    priority: overrides.priority ?? "medium",
    required: overrides.required ?? true,
    estimatedMinutes: overrides.estimatedMinutes ?? 30,
    assignedPersonId: overrides.assignedPersonId,
    requiredSkills: overrides.requiredSkills ?? [],
    resourceNeeds: overrides.resourceNeeds ?? [],
    locationId: overrides.locationId,
    dependsOnTaskIds: overrides.dependsOnTaskIds ?? [],
  };
}

describe("assignTasks", () => {
  it("matches skills without case or whitespace differences", () => {
    const result = assignTasks(
      [makeTask({ id: "T1", requiredSkills: ["  pYtHoN  "] })],
      people,
    );

    expect(result.complete).toBe(true);
    expect(result.assignments[0]).toMatchObject({
      taskId: "T1",
      personId: "alice",
      assigned: true,
    });
  });

  it("does not assign a task when nobody has the required skills", () => {
    const result = assignTasks(
      [makeTask({ id: "T1", requiredSkills: ["Kubernetes"] })],
      people,
    );

    expect(result.complete).toBe(false);
    expect(result.assignments[0]).toMatchObject({
      taskId: "T1",
      assigned: false,
      reason: "NO_ELIGIBLE_PERSON",
    });
  });

  it("does not assign an unavailable person", () => {
    const result = assignTasks(
      [makeTask({ id: "T1", requiredSkills: ["Python"] })],
      [{ ...people[2]! }],
    );

    expect(result.complete).toBe(false);
    expect(result.assignments[0]).toMatchObject({
      assigned: false,
      reason: "PERSON_UNAVAILABLE",
    });
  });

  it("does not silently replace an invalid explicit assignment", () => {
    const result = assignTasks(
      [
        makeTask({
          id: "T1",
          assignedPersonId: "missing",
          requiredSkills: ["Python"],
        }),
      ],
      people,
    );

    expect(result.complete).toBe(false);
    expect(result.assignments[0]).toMatchObject({
      assigned: false,
      reason: "UNKNOWN_PERSON",
    });
  });

  it("preserves a valid explicit assignment", () => {
    const result = assignTasks(
      [
        makeTask({
          id: "T1",
          assignedPersonId: "bob",
          requiredSkills: ["Java"],
        }),
      ],
      people,
    );

    expect(result.assignments[0]).toMatchObject({
      taskId: "T1",
      personId: "bob",
      assigned: true,
    });
  });

  it("balances workload and breaks ties by person ID", () => {
    const result = assignTasks(
      [
        makeTask({ id: "T1", requiredSkills: ["SQL"], estimatedMinutes: 60 }),
        makeTask({ id: "T2", requiredSkills: ["SQL"], estimatedMinutes: 30 }),
      ],
      people.slice(0, 2),
    );

    const assignments = Object.fromEntries(
      result.assignments.map((item) => [item.taskId, item.personId]),
    );

    expect(assignments).toEqual({
      T1: "alice",
      T2: "bob",
    });
  });

  it("prioritizes tasks with fewer eligible candidates", () => {
    const result = assignTasks(
      [
        makeTask({ id: "T1", requiredSkills: ["SQL"] }),
        makeTask({ id: "T2", requiredSkills: ["Java"] }),
      ],
      people.slice(0, 2),
    );

    const assignments = Object.fromEntries(
      result.assignments.map((item) => [item.taskId, item.personId]),
    );

    expect(assignments.T2).toBe("bob");
    expect(assignments.T1).toBe("alice");
  });

  it("produces the same result when input arrays are reordered", () => {
    const tasks = [
      makeTask({ id: "T2", requiredSkills: ["SQL"] }),
      makeTask({ id: "T1", requiredSkills: ["Python"] }),
    ];

    const first = assignTasks(tasks, people);
    const second = assignTasks([...tasks].reverse(), [...people].reverse());

    expect(second).toEqual(first);
  });


  it("rejects duplicate task IDs without assigning either duplicate", () => {
    const tasks = [
      makeTask({ id: "t1", title: "First task" }),
      makeTask({ id: "t1", title: "Second task" }),
    ];

    const result = assignTasks(tasks, people);

    expect(result.complete).toBe(false);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments.every((item) => !item.assigned)).toBe(true);
    expect(
      result.assignments.every((item) => item.reason === "DUPLICATE_TASK_ID"),
    ).toBe(true);
  });

  it("rejects duplicate person IDs rather than choosing an ambiguous person", () => {
    const tasks = [makeTask({ id: "t1", title: "Prepare kit" })];
    const duplicatePeople = [
      people[0]!,
      { ...people[0]!, name: "Different person record" },
    ];

    const result = assignTasks(tasks, duplicatePeople);

    expect(result.complete).toBe(false);
    expect(result.assignments[0]?.assigned).toBe(false);
    expect(result.assignments[0]?.reason).toBe("DUPLICATE_PERSON_ID");
  });
});

it("does not blame duplicate person IDs when only task IDs are duplicated", () => {
  const tasks = [
    makeTask({ id: "t1", title: "First copy" }),
    makeTask({ id: "t1", title: "Second copy" }),
    makeTask({ id: "t2", title: "Unrelated task" }),
  ];

  const result = assignTasks(tasks, people);

  expect(result.complete).toBe(false);

  const unrelatedTask = result.assignments.find(
    (item) => item.taskId === "t2",
  );

  expect(unrelatedTask).toBeDefined();
  expect(unrelatedTask?.reason).not.toBe("DUPLICATE_PERSON_ID");
  expect(unrelatedTask?.explanation).not.toContain(
    "Duplicate person IDs",
  );
});

it("reports both duplicate-ID problems without assigning tasks", () => {
  const duplicatePeople = [
    people[0]!,
    { ...people[0]!, name: "Duplicate Alice record" },
  ];

  const tasks = [
    makeTask({ id: "t1", title: "First copy" }),
    makeTask({ id: "t1", title: "Second copy" }),
    makeTask({ id: "t2", title: "Unrelated task" }),
  ];

  const result = assignTasks(tasks, duplicatePeople);

  expect(result.complete).toBe(false);
  expect(result.assignments).toHaveLength(3);
  expect(result.assignments.every((item) => !item.assigned)).toBe(true);

  expect(
    result.assignments
      .filter((item) => item.taskId === "t1")
      .every((item) => item.reason === "DUPLICATE_TASK_ID"),
  ).toBe(true);

  const unrelatedTask = result.assignments.find(
    (item) => item.taskId === "t2",
  );

  expect(unrelatedTask?.reason).toBe("DUPLICATE_PERSON_ID");
  expect(unrelatedTask?.explanation).toContain("Duplicate person IDs");
});
