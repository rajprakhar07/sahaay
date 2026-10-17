
import { describe, expect, it } from "vitest";
import { TaskSchema } from "./index";
import { createSchedule } from "./scheduler";

function makeTask(
  id: string,
  estimatedMinutes: number,
  dependsOnTaskIds: string[] = [],
) {
  return TaskSchema.parse({
    id,
    title: `Task ${id}`,
    priority: "medium",
    estimatedMinutes,
    dependsOnTaskIds,
  });
}

describe("createSchedule", () => {
  it("schedules a single task from minute zero", () => {
    const result = createSchedule([makeTask("A", 30)]);

    expect(result.feasible).toBe(true);
    expect(result.schedule).toEqual([
      { taskId: "A", startMinute: 0, endMinute: 30 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("schedules dependent tasks in the correct order", () => {
    const result = createSchedule([
      makeTask("B", 20, ["A"]),
      makeTask("A", 30),
    ]);

    expect(result.feasible).toBe(true);

    const taskA = result.schedule.find((task) => task.taskId === "A");
    const taskB = result.schedule.find((task) => task.taskId === "B");

    expect(taskA?.startMinute).toBe(0);
    expect(taskA?.endMinute).toBe(30);
    expect(taskB?.startMinute).toBe(30);
    expect(taskB?.endMinute).toBe(50);
  });

  it("allows independent tasks to run in parallel", () => {
    const result = createSchedule([
      makeTask("A", 30),
      makeTask("B", 20),
    ]);

    expect(result.feasible).toBe(true);
    expect(result.schedule).toHaveLength(2);
    expect(result.schedule.every((task) => task.startMinute === 0)).toBe(true);
  });

  it("rejects a dependency cycle", () => {
    const result = createSchedule([
      makeTask("A", 10, ["B"]),
      makeTask("B", 10, ["A"]),
    ]);

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(result.errors.some((error) => error.includes("Dependency cycle"))).toBe(true);
  });
});
