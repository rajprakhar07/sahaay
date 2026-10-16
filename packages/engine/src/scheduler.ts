
import type { Task } from "./index";
import { checkDependencyIntegrity } from "./integrity";

export interface ScheduledTask {
  taskId: string;
  startMinute: number;
  endMinute: number;
}

export interface ScheduleResult {
  feasible: boolean;
  schedule: ScheduledTask[];
  errors: string[];
}

/**
 * Creates a sequential schedule that respects task dependencies.
 * All times are minutes from the start of the planning horizon.
 */
export function createSchedule(
  tasks: readonly Task[],
): ScheduleResult {
  const integrity = checkDependencyIntegrity(tasks);

  if (!integrity.valid) {
    return {
      feasible: false,
      schedule: [],
      errors: integrity.cycles.map(
        (cycle) => `Dependency cycle: ${cycle.taskIds.join(" -> ")}`,
      ),
    };
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const scheduledById = new Map<string, ScheduledTask>();
  const schedule: ScheduledTask[] = [];
  const errors: string[] = [];

  function scheduleTask(taskId: string): boolean {
    if (scheduledById.has(taskId)) return true;

    const task = taskById.get(taskId);
    if (!task) {
      errors.push(`Missing task: ${taskId}`);
      return false;
    }

    let startMinute = 0;

    for (const dependencyId of task.dependsOnTaskIds) {
      const dependency = taskById.get(dependencyId);

      if (!dependency) {
        errors.push(
          `Task "${taskId}" depends on missing task "${dependencyId}"`,
        );
        return false;
      }

      if (!scheduleTask(dependencyId)) return false;

      const dependencySchedule = scheduledById.get(dependencyId);
      if (dependencySchedule) {
        startMinute = Math.max(startMinute, dependencySchedule.endMinute);
      }
    }

    const scheduledTask: ScheduledTask = {
      taskId,
      startMinute,
      endMinute: startMinute + task.estimatedMinutes,
    };

    scheduledById.set(taskId, scheduledTask);
    schedule.push(scheduledTask);
    return true;
  }

  for (const task of tasks) {
    if (!scheduleTask(task.id)) {
      return { feasible: false, schedule: [], errors };
    }
  }

  return {
    feasible: true,
    schedule: schedule.sort(
      (a, b) => a.startMinute - b.startMinute || a.taskId.localeCompare(b.taskId),
    ),
    errors: [],
  };
}
