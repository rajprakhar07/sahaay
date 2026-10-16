
import { describe, expect, it } from "vitest";
import type { Task } from "./index";
import { checkDependencyIntegrity } from "./integrity";

function makeTask(
  id: string,
  dependsOnTaskIds: string[] = [],
): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    priority: "medium",
    required: true,
    estimatedMinutes: 10,
    requiredSkills: [],
    resourceNeeds: [],
    dependsOnTaskIds,
  };
}

describe("checkDependencyIntegrity", () => {
  it("accepts tasks with no dependencies", () => {
    const result = checkDependencyIntegrity([
      makeTask("A"),
      makeTask("B"),
    ]);

    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
  });

  it("accepts a valid dependency chain", () => {
    const result = checkDependencyIntegrity([
      makeTask("A"),
      makeTask("B", ["A"]),
      makeTask("C", ["B"]),
    ]);

    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
  });

  it("detects a two-task cycle", () => {
    const result = checkDependencyIntegrity([
      makeTask("A", ["B"]),
      makeTask("B", ["A"]),
    ]);

    expect(result.valid).toBe(false);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]?.taskIds).toEqual(
      expect.arrayContaining(["A", "B"]),
    );
  });

  it("detects a longer cycle", () => {
    const result = checkDependencyIntegrity([
      makeTask("A", ["C"]),
      makeTask("B", ["A"]),
      makeTask("C", ["B"]),
    ]);

    expect(result.valid).toBe(false);
    expect(result.cycles).toHaveLength(1);

    const cycle = result.cycles[0]?.taskIds;
    expect(cycle).toHaveLength(4);
    expect(cycle?.[0]).toBe(cycle?.[3]);
  });

  it("detects two independent cycles", () => {
    const result = checkDependencyIntegrity([
      makeTask("A", ["B"]),
      makeTask("B", ["A"]),
      makeTask("C", ["D"]),
      makeTask("D", ["C"]),
    ]);

    expect(result.valid).toBe(false);
    expect(result.cycles).toHaveLength(2);
  });

  it("ignores a missing dependency instead of crashing", () => {
    const result = checkDependencyIntegrity([
      makeTask("A", ["MISSING"]),
    ]);

    expect(result.valid).toBe(true);
    expect(result.cycles).toHaveLength(0);
  });
});
