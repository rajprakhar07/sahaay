
import { describe, expect, it } from "vitest";
import {
  HouseholdPlanSchema,
  PersonSchema,
  ResourceSchema,
  TaskSchema,
  LocationSchema,
} from "./index";

const validPlan = {
  id: "PLAN-01",
  people: [
    {
      id: "P01",
      name: "Asha",
      skills: ["first aid"],
    
      available: true,
    },
  ],
  locations: [
    {
      id: "L01",
      name: "Home",
      description: "Household starting point",
    },
  ],
  resources: [
    {
      id: "R01",
      name: "First-aid kit",
      kind: "reusable",
      quantity: 1,
      unit: "kit",
      locationId: "L01",
    },
  ],
  tasks: [
    {
      id: "T01",
      title: "Collect emergency kit",
      description: "Collect supplies before leaving",
      priority: "high",
      required: true,
      estimatedMinutes: 5,
      assignedPersonId: "P01",
      requiredSkills: [],
      resourceNeeds: [{ resourceId: "R01", quantity: 1 }],
      locationId: "L01",
      dependsOnTaskIds: [],
    },
  ],
};

describe("individual data schemas", () => {
  it("accepts a valid person", () => {
    expect(
      PersonSchema.safeParse({
        id: "P01",
        name: "Asha",
        available: true,
      }).success,
    ).toBe(true);
  });

  it("rejects a person with a blank name", () => {
    expect(
      PersonSchema.safeParse({
        id: "P01",
        name: "   ",
        available: true,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative resource quantity", () => {
    expect(
      ResourceSchema.safeParse({
        id: "R01",
        name: "Water",
        quantity: -1,
        unit: "litres",
      }).success,
    ).toBe(false);
  });

  it("rejects a task with zero estimated minutes", () => {
    expect(
      TaskSchema.safeParse({
        id: "T01",
        title: "Get supplies",
        priority: "high",
        estimatedMinutes: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts a valid location", () => {
    expect(
      LocationSchema.safeParse({
        id: "L01",
        name: "Home",
      }).success,
    ).toBe(true);
  });
});

describe("household plan validation", () => {
  it("accepts a valid household plan", () => {
    expect(HouseholdPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it("rejects duplicate person IDs", () => {
    const plan = {
      ...validPlan,
      people: [
        ...validPlan.people,
        { ...validPlan.people[0], name: "Another person" },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a task assigned to a missing person", () => {
    const plan = {
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          assignedPersonId: "P99",
        },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a task referencing a missing resource", () => {
    const plan = {
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          resourceNeeds: [{ resourceId: "R99", quantity: 1 }],
        },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a task depending on itself", () => {
    const plan = {
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          dependsOnTaskIds: ["T01"],
        },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a task depending on a missing task", () => {
    const plan = {
      ...validPlan,
      tasks: [
        {
          ...validPlan.tasks[0],
          dependsOnTaskIds: ["T99"],
        },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });
});


describe("additional data-model regression tests", () => {
  it("rejects duplicate task IDs", () => {
    const plan = {
      ...validPlan,
      tasks: [
        ...validPlan.tasks,
        { ...validPlan.tasks[0], title: "Duplicate task" },
      ],
    };

    const result = HouseholdPlanSchema.safeParse(plan);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === "tasks" &&
            issue.path[2] === "id",
        ),
      ).toBe(true);
    }
  });

  it("rejects a task referencing a missing location", () => {
    const plan = {
      ...validPlan,
      tasks: [
        { ...validPlan.tasks[0], locationId: "L99" },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects a resource referencing a missing location", () => {
    const plan = {
      ...validPlan,
      resources: [
        { ...validPlan.resources[0], locationId: "L99" },
      ],
    };

    expect(HouseholdPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("trims IDs and names before validating the plan", () => {
    const plan = {
      ...validPlan,
      people: [
        { ...validPlan.people[0], id: " P01 ", name: " Asha " },
      ],
      tasks: [
        { ...validPlan.tasks[0], assignedPersonId: " P01 " },
      ],
    };

    const result = HouseholdPlanSchema.safeParse(plan);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.people).toHaveLength(1);
expect(result.data.tasks).toHaveLength(1);

expect(result.data.people.at(0)?.id).toBe("P01");
expect(result.data.people.at(0)?.name).toBe("Asha");
expect(result.data.tasks.at(0)?.assignedPersonId).toBe("P01");
    }
  });

  it("rejects IDs that become duplicates after trimming", () => {
    const plan = {
      ...validPlan,
      people: [
        { ...validPlan.people[0], id: "P01" },
        { ...validPlan.people[0], id: " P01 " },
      ],
    };

    const result = HouseholdPlanSchema.safeParse(plan);

    expect(result.success).toBe(false);
  });

  it("rejects an unsupported task priority", () => {
    const result = TaskSchema.safeParse({
      id: "T02",
      title: "Prepare supplies",
      priority: "urgent",
      estimatedMinutes: 10,
    });

    expect(result.success).toBe(false);
  });
});

