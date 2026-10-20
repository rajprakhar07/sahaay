
import type { Person, Resource, Task } from "./index";
import { assignTasks } from "./assignment";
import { createSchedule } from "./scheduler";
import { validateSchedule } from "./validator";

export interface PlanningIssue {
  taskId: string;
  reason: string;
}

export interface PlanResult {
  complete: boolean;
  feasible: boolean;
  assignedTasks: Task[];
  unassignedTasks: PlanningIssue[];
  schedule: ReturnType<typeof createSchedule>["schedule"];
  schedulingErrors: string[];
  validation: ReturnType<typeof validateSchedule>;
}

export function createPlan(
  tasks: readonly Task[],
  people: readonly Person[],
  resources: readonly Resource[] = [],
): PlanResult {
  const assignment = assignTasks(tasks, people);
  const assignmentById = new Map(
    assignment.assignments.map((item) => [item.taskId, item]),
  );

  const taskById = new Map<string, Task>();
  const duplicateIds = new Set<string>();

  for (const task of tasks) {
    if (taskById.has(task.id)) duplicateIds.add(task.id);
    else taskById.set(task.id, task);
  }

  const unassignedTasks: PlanningIssue[] = assignment.assignments
    .filter((item) => !item.assigned)
    .map((item) => ({
      taskId: item.taskId,
      reason: item.explanation ?? item.reason ?? "Assignment failed.",
    }));

  // A task cannot be scheduled if any prerequisite is missing or unassigned.
  const blockedIds = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const task of tasks) {
      if (blockedIds.has(task.id)) continue;

      const blockedDependency = task.dependsOnTaskIds.find(
        (dependencyId) =>
          !taskById.has(dependencyId) ||
          duplicateIds.has(dependencyId) ||
          blockedIds.has(dependencyId) ||
          assignmentById.get(dependencyId)?.assigned !== true,
      );

     if (blockedDependency !== undefined) {
  blockedIds.add(task.id);

  const alreadyReported = unassignedTasks.some(
    (issue) => issue.taskId === task.id,
  );

  if (!alreadyReported) {
    unassignedTasks.push({
      taskId: task.id,
      reason: `Blocked because prerequisite "${blockedDependency}" is missing, ambiguous, or unassigned.`,
    });
  }

  changed = true;
}
    }
  }

  const assignedTasks = tasks
    .filter(
      (task) =>
        !duplicateIds.has(task.id) &&
        !blockedIds.has(task.id) &&
        assignmentById.get(task.id)?.assigned === true,
    )
      .map((task) => {
      const personId = assignmentById.get(task.id)?.personId;

      return {
        ...task,
        requiredSkills: [...task.requiredSkills],
        dependsOnTaskIds: [...task.dependsOnTaskIds],
        resourceNeeds: task.resourceNeeds.map((need) => ({
          ...need,
        })),
        ...(personId === undefined
          ? {}
          : { assignedPersonId: personId }),
      };
    });

  const scheduling = createSchedule(assignedTasks, { people, resources });

  const validation = validateSchedule(
    assignedTasks,
    scheduling.schedule,
    { people, resources },
  );

  const complete =
    tasks.length > 0 &&
    duplicateIds.size === 0 &&
    unassignedTasks.length === 0 &&
    assignedTasks.length === tasks.length &&
    assignment.complete &&
    scheduling.feasible &&
    validation.valid;

  return {
    complete,
    feasible: complete,
    assignedTasks,
    unassignedTasks,
    schedule: scheduling.schedule,
    schedulingErrors: scheduling.errors,
    validation,
  };
}
