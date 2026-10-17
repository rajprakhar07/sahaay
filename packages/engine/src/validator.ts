import type { Person, Resource, Task } from "./index";

// Deliberately independent of scheduler.ts: these shapes are structurally
// compatible with the scheduler's output, but nothing is imported from it.

export interface ScheduleEntry {
  taskId: string;
  startMinute: number;
  endMinute: number;
}

export interface ValidationContext {
  people?: readonly Person[];
  resources?: readonly Resource[];
}

export type ViolationType =
  | "DUPLICATE_TASK_ID"
  | "MISSING_TASK"
  | "UNKNOWN_TASK"
  | "DUPLICATE_ENTRY"
  | "INVALID_TIME"
  | "INVALID_DURATION"
  | "UNKNOWN_DEPENDENCY"
  | "DEPENDENCY_VIOLATION"
  | "UNKNOWN_PERSON"
  | "UNAVAILABLE_PERSON"
  | "PERSON_OVERLAP"
  | "UNKNOWN_RESOURCE"
  | "RESOURCE_CAPACITY_EXCEEDED"
  | "CONSUMABLE_STOCK_EXCEEDED";

export interface ScheduleViolation {
  type: ViolationType;
  message: string;
  taskIds: string[];
  resourceIds: string[];
  personIds: string[];
}

export interface ValidationResult {
  valid: boolean;
  violations: ScheduleViolation[];
}

interface ViolationIds {
  taskIds?: readonly string[];
  resourceIds?: readonly string[];
  personIds?: readonly string[];
}

interface ResourceUsage {
  taskId: string;
  start: number;
  end: number;
  quantity: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Half-open intervals [start, end): touching intervals do not overlap.
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function aggregateNeeds(task: Task): Map<string, number> {
  const totals = new Map<string, number>();
  for (const need of task.resourceNeeds) {
    totals.set(need.resourceId, (totals.get(need.resourceId) ?? 0) + need.quantity);
  }
  return totals;
}

/**
 * Checks a proposed schedule against the hard constraints of the plan.
 * Never fixes or changes anything; it only reports. A valid schedule yields
 * `{ valid: true, violations: [] }`.
 *
 * Checks that need extra data run only when it is supplied:
 *  - `context.people`: unknown / unavailable assigned people.
 *  - `context.resources`: unknown resources, reusable capacity, consumable stock.
 * Same-person overlap is checked whenever a task has an assigned person.
 */
export function validateSchedule(
  tasks: readonly Task[],
  schedule: readonly ScheduleEntry[],
  context: ValidationContext = {},
): ValidationResult {
  const violations: ScheduleViolation[] = [];

  function report(type: ViolationType, message: string, ids: ViolationIds = {}): void {
    violations.push({
      type,
      message,
      taskIds: [...(ids.taskIds ?? [])].sort(compareText),
      resourceIds: [...(ids.resourceIds ?? [])].sort(compareText),
      personIds: [...(ids.personIds ?? [])].sort(compareText),
    });
  }

  // ----- 1. Task list sanity -----

  const taskById = new Map<string, Task>();
  for (const task of tasks) {
    if (taskById.has(task.id)) {
      report("DUPLICATE_TASK_ID", `Task ID "${task.id}" is used more than once`, { taskIds: [task.id] });
    } else {
      taskById.set(task.id, task);
    }
  }
  const uniqueTasks = [...taskById.values()].sort((a, b) => compareText(a.id, b.id));

  // ----- 2. Schedule entries: coverage, duplicates, times, durations -----

  const entriesById = new Map<string, ScheduleEntry[]>();
  for (const entry of schedule) {
    const list = entriesById.get(entry.taskId) ?? [];
    list.push(entry);
    entriesById.set(entry.taskId, list);
  }

  // First well-formed entry per known task; later checks use only these.
  const canonical = new Map<string, ScheduleEntry>();
  const invalidIds = new Set<string>();

  for (const taskId of [...entriesById.keys()].sort(compareText)) {
    const entries = entriesById.get(taskId) ?? [];
    const task = taskById.get(taskId);

    if (!task) {
      report("UNKNOWN_TASK", `Schedule contains unknown task "${taskId}"`, { taskIds: [taskId] });
      continue;
    }

    if (entries.length > 1) {
      report("DUPLICATE_ENTRY", `Task "${taskId}" appears ${entries.length} times in the schedule`, {
        taskIds: [taskId],
      });
    }

    const first = entries[0];
    if (!first) continue;

    const timesValid =
      Number.isInteger(first.startMinute) &&
      Number.isInteger(first.endMinute) &&
      first.startMinute >= 0 &&
      first.endMinute > first.startMinute;

    if (!timesValid) {
      invalidIds.add(taskId);
      report(
        "INVALID_TIME",
        `Task "${taskId}" has an invalid interval [${first.startMinute}, ${first.endMinute}): times must be whole minutes, start >= 0 and end > start`,
        { taskIds: [taskId] },
      );
      continue;
    }

    const duration = first.endMinute - first.startMinute;
    if (duration !== task.estimatedMinutes) {
      report(
        "INVALID_DURATION",
        `Task "${taskId}" is scheduled for ${duration} minutes but needs ${task.estimatedMinutes}`,
        { taskIds: [taskId] },
      );
    }

    canonical.set(taskId, first);
  }

  for (const task of uniqueTasks) {
    if (!entriesById.has(task.id)) {
      report("MISSING_TASK", `Task "${task.id}" is not in the schedule`, { taskIds: [task.id] });
    }
  }

  // ----- 3. Dependencies -----

  for (const task of uniqueTasks) {
    const entry = canonical.get(task.id);

    for (const dependencyId of task.dependsOnTaskIds) {
      if (!taskById.has(dependencyId)) {
        report("UNKNOWN_DEPENDENCY", `Task "${task.id}" depends on unknown task "${dependencyId}"`, {
          taskIds: [task.id],
        });
        continue;
      }

      if (!entry) continue; // missing or invalid entry is reported elsewhere

      const dependencyEntry = canonical.get(dependencyId);

      if (dependencyEntry) {
        if (entry.startMinute < dependencyEntry.endMinute) {
          report(
            "DEPENDENCY_VIOLATION",
            `Task "${task.id}" starts at minute ${entry.startMinute}, before its prerequisite "${dependencyId}" ends at minute ${dependencyEntry.endMinute}`,
            { taskIds: [task.id, dependencyId] },
          );
        }
      } else if (!invalidIds.has(dependencyId)) {
        report(
          "DEPENDENCY_VIOLATION",
          `Task "${task.id}" is scheduled but its prerequisite "${dependencyId}" is not`,
          { taskIds: [task.id, dependencyId] },
        );
      }
    }
  }

  // ----- 4. People -----

  if (context.people) {
    const peopleById = new Map(context.people.map((person) => [person.id, person]));

    for (const task of uniqueTasks) {
      if (task.assignedPersonId === undefined) continue;

      const person = peopleById.get(task.assignedPersonId);
      if (!person) {
        report("UNKNOWN_PERSON", `Task "${task.id}" is assigned to unknown person "${task.assignedPersonId}"`, {
          taskIds: [task.id],
          personIds: [task.assignedPersonId],
        });
      } else if (!person.available) {
        report(
          "UNAVAILABLE_PERSON",
          `Task "${task.id}" is assigned to unavailable person "${person.id}" (${person.name})`,
          { taskIds: [task.id], personIds: [person.id] },
        );
      }
    }
  }

  const taskIdsByPerson = new Map<string, string[]>();
  for (const taskId of [...canonical.keys()].sort(compareText)) {
    const task = taskById.get(taskId);
    if (!task || task.assignedPersonId === undefined) continue;
    const list = taskIdsByPerson.get(task.assignedPersonId) ?? [];
    list.push(taskId);
    taskIdsByPerson.set(task.assignedPersonId, list);
  }

  for (const personId of [...taskIdsByPerson.keys()].sort(compareText)) {
    const ids = taskIdsByPerson.get(personId) ?? [];

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const idA = ids[i];
        const idB = ids[j];
        if (idA === undefined || idB === undefined) continue;

        const a = canonical.get(idA);
        const b = canonical.get(idB);
        if (!a || !b) continue;

        if (overlaps(a.startMinute, a.endMinute, b.startMinute, b.endMinute)) {
          report(
            "PERSON_OVERLAP",
            `Person "${personId}" is assigned to overlapping tasks "${idA}" [${a.startMinute}, ${a.endMinute}) and "${idB}" [${b.startMinute}, ${b.endMinute})`,
            { taskIds: [idA, idB], personIds: [personId] },
          );
        }
      }
    }
  }

  // ----- 5. Resources -----

  if (context.resources) {
    const resourcesById = new Map(context.resources.map((resource) => [resource.id, resource]));

    for (const task of uniqueTasks) {
      for (const resourceId of [...aggregateNeeds(task).keys()].sort(compareText)) {
        if (!resourcesById.has(resourceId)) {
          report("UNKNOWN_RESOURCE", `Task "${task.id}" requires unknown resource "${resourceId}"`, {
            taskIds: [task.id],
            resourceIds: [resourceId],
          });
        }
      }
    }

    const usageByResource = new Map<string, ResourceUsage[]>();
    for (const taskId of [...canonical.keys()].sort(compareText)) {
      const task = taskById.get(taskId);
      const entry = canonical.get(taskId);
      if (!task || !entry) continue;

      for (const [resourceId, quantity] of aggregateNeeds(task)) {
        if (!resourcesById.has(resourceId)) continue;
        const list = usageByResource.get(resourceId) ?? [];
        list.push({ taskId, start: entry.startMinute, end: entry.endMinute, quantity });
        usageByResource.set(resourceId, list);
      }
    }

    for (const resourceId of [...usageByResource.keys()].sort(compareText)) {
      const resource = resourcesById.get(resourceId);
      const usages = usageByResource.get(resourceId);
      if (!resource || !usages) continue;

      if (resource.kind === "reusable") {
        // Demand can only rise when some task starts, so checking every start
        // time covers every moment of the schedule.
        const checkPoints = [...new Set(usages.map((u) => u.start))].sort((a, b) => a - b);

        for (const t of checkPoints) {
          const active = usages.filter((u) => u.start <= t && t < u.end);
          const demand = active.reduce((sum, u) => sum + u.quantity, 0);

          if (demand > resource.quantity) {
            const activeIds = active.map((u) => u.taskId);
            report(
              "RESOURCE_CAPACITY_EXCEEDED",
              `Reusable resource "${resource.id}" (${resource.name}) is over capacity at minute ${t}: tasks ${activeIds.join(", ")} need ${demand} ${resource.unit} at once but only ${resource.quantity} exist`,
              { taskIds: activeIds, resourceIds: [resource.id] },
            );
            break; // report the first violating moment per resource
          }
        }
      } else {
        const total = usages.reduce((sum, u) => sum + u.quantity, 0);

        if (total > resource.quantity) {
          report(
            "CONSUMABLE_STOCK_EXCEEDED",
            `Consumable resource "${resource.id}" (${resource.name}): scheduled tasks use ${total} ${resource.unit} in total but only ${resource.quantity} are in stock`,
            { taskIds: usages.map((u) => u.taskId), resourceIds: [resource.id] },
          );
        }
      }
    }
  }

  violations.sort((a, b) => compareText(a.type, b.type) || compareText(a.message, b.message));

  return { valid: violations.length === 0, violations };
}