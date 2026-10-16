
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
  it("schedules an independent task from minute zero", () => {
    const result = createSchedule([makeTask("T01", 20)]);

    expect(result.feasible).toBe(true);
    expect(result.schedule).toEqual([
      { taskId: "T01", startMinute: 0, endMinute: 20 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("allows independent tasks to run in parallel", () => {
    const result = createSchedule([
      makeTask("T01", 20),
      makeTask("T02", 10),
    ]);

    expect(result.feasible).toBe(true);
    expect(result.schedule).toHaveLength(2);
    expect(result.schedule.every((task) => task.startMinute === 0)).toBe(true);
  });

  it("starts a dependent task after its prerequisite finishes", () => {
    const result = createSchedule([
      makeTask("T02", 15, ["T01"]),
      makeTask("T01", 10),
    ]);

    expect(result.feasible).toBe(true);
    expect(result.schedule).toContainEqual({
      taskId: "T01",
      startMinute: 0,
      endMinute: 10,
    });
    expect(result.schedule).toContainEqual({
      taskId: "T02",
      startMinute: 10,
      endMinute: 25,
    });
  });

  it("rejects a dependency on a missing task", () => {
    const result = createSchedule([makeTask("T01", 10, ["T99"])]);

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(result.errors.join(" ")).toContain("T99");
  });

  it("rejects circular task dependencies", () => {
    const result = createSchedule([
      makeTask("T01", 10, ["T02"]),
      makeTask("T02", 15, ["T01"]),
    ]);

    expect(result.feasible).toBe(false);
    expect(result.schedule).toEqual([]);
    expect(result.errors.join(" ")).toContain("Dependency cycle");
  });
});
