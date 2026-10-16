
import type { Task } from "./index";

export interface DependencyCycle {
  taskIds: string[];
}

export interface IntegrityReport {
  valid: boolean;
  cycles: DependencyCycle[];
}

/**
 * Detects cycles in task dependencies.
 * A task's dependsOnTaskIds lists the tasks that must happen before it.
 */
export function checkDependencyIntegrity(
  tasks: readonly Task[],
): IntegrityReport {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: DependencyCycle[] = [];
  const cycleKeys = new Set<string>();

  function visit(taskId: string): void {
    const currentState = state.get(taskId);

    if (currentState === "visited") return;

    if (currentState === "visiting") {
      const cycleStart = stack.indexOf(taskId);

      if (cycleStart !== -1) {
        const cyclePath = stack.slice(cycleStart);
        const cycleKey = [...cyclePath].sort().join("|");

        if (!cycleKeys.has(cycleKey)) {
          cycleKeys.add(cycleKey);
          cycles.push({ taskIds: [...cyclePath, taskId] });
        }
      }

      return;
    }

    const task = taskById.get(taskId);
    if (!task) return;

    state.set(taskId, "visiting");
    stack.push(taskId);

    for (const dependencyId of task.dependsOnTaskIds) {
      if (taskById.has(dependencyId)) {
        visit(dependencyId);
      }
    }

    stack.pop();
    state.set(taskId, "visited");
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return {
    valid: cycles.length === 0,
    cycles,
  };
}
