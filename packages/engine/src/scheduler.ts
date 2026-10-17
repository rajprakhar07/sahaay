import type { Person, Resource, Task } from "./index";
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
 * Optional data that enables constraint checks. Each family of checks runs
 * only when its data is supplied:
 *  - `people`: unknown / unavailable assigned people are rejected.
 *  - `resources`: unknown resources, over-capacity reusable resources and
 *    over-stock consumable resources are rejected.
 */
export interface SchedulingContext {
  people?: readonly Person[];
  resources?: readonly Resource[];
}

interface PlacedTask {
  taskId: string;
  startMinute: number;
  endMinute: number;
  personId: string | undefined;
  needs: ReadonlyMap<string, number>;
}

const PRIORITY_RANK: Record<Task["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Code-point comparison: independent of the machine's locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Half-open intervals [start, end): touching intervals do not overlap.
function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function aggregateNeeds(task: Task): Map<string, number> {
  const totals = new Map<string, number>();
  for (const need of task.resourceNeeds) {
    totals.set(
      need.resourceId,
      (totals.get(need.resourceId) ?? 0) + need.quantity,
    );
  }
  return totals;
}

function validateConstraintInputs(
  orderedTasks: readonly Task[],
  context: SchedulingContext,
): string[] {
  const errors: string[] = [];

  if (context.people) {
    const peopleById = new Map(
      context.people.map((person) => [person.id, person]),
    );

    for (const task of orderedTasks) {
      if (task.assignedPersonId === undefined) continue;

      const person = peopleById.get(task.assignedPersonId);
      if (!person) {
        errors.push(
          `Task "${task.id}" is assigned to unknown person "${task.assignedPersonId}"`,
        );
      } else if (!person.available) {
        errors.push(
          `Task "${task.id}" is assigned to unavailable person "${person.id}" (${person.name})`,
        );
      }
    }
  }

  if (context.resources) {
    const resourcesById = new Map(
      context.resources.map((resource) => [resource.id, resource]),
    );
    const consumableDemand = new Map<string, number>();

    for (const task of orderedTasks) {
      for (const [resourceId, quantity] of aggregateNeeds(task)) {
        const resource = resourcesById.get(resourceId);

        if (!resource) {
          errors.push(
            `Task "${task.id}" requires unknown resource "${resourceId}"`,
          );
          continue;
        }

        if (resource.kind === "reusable") {
          if (quantity > resource.quantity) {
            errors.push(
              `Task "${task.id}" requires ${quantity} of reusable resource "${resource.id}" (${resource.name}), but only ${resource.quantity} exist`,
            );
          }
        } else {
          consumableDemand.set(
            resourceId,
            (consumableDemand.get(resourceId) ?? 0) + quantity,
          );
        }
      }
    }

    for (const resourceId of [...consumableDemand.keys()].sort(compareText)) {
      const resource = resourcesById.get(resourceId);
      const demand = consumableDemand.get(resourceId) ?? 0;

      if (resource && demand > resource.quantity) {
        errors.push(
          `Consumable resource "${resource.id}" (${resource.name}): tasks require ${demand} ${resource.unit} in total but only ${resource.quantity} are in stock`,
        );
      }
    }
  }

  return errors;
}

/**
 * Finds the earliest start >= `earliest` at which `task` neither overlaps
 * another task of the same person nor pushes a reusable resource over its
 * capacity at any moment of its interval.
 *
 * Usage only ever decreases at the end of an already-placed task, so the only
 * start times worth trying are `earliest` and those end times.
 */
function findEarliestStart(
  task: Task,
  earliest: number,
  placed: readonly PlacedTask[],
  reusableCapacity: ReadonlyMap<string, number>,
): number | undefined {
  const needs = aggregateNeeds(task);

  const candidates = [
    ...new Set([
      earliest,
      ...placed
        .map((entry) => entry.endMinute)
        .filter((end) => end > earliest),
    ]),
  ].sort((a, b) => a - b);

  for (const start of candidates) {
    const end = start + task.estimatedMinutes;
    const overlapping = placed.filter((entry) =>
      intervalsOverlap(start, end, entry.startMinute, entry.endMinute),
    );

    if (
      task.assignedPersonId !== undefined &&
      overlapping.some((entry) => entry.personId === task.assignedPersonId)
    ) {
      continue;
    }

    let resourcesFit = true;

    for (const [resourceId, quantity] of needs) {
      const capacity = reusableCapacity.get(resourceId);
      if (capacity === undefined) continue; // consumable or unchecked

      const users = overlapping.filter((entry) => entry.needs.has(resourceId));

      // Demand can only rise at the candidate's start or at the start of an
      // overlapping task, so checking those moments covers the whole interval.
      const checkPoints = [
        start,
        ...users
          .map((entry) => entry.startMinute)
          .filter((t) => t > start && t < end),
      ];

      for (const t of checkPoints) {
        let demand = quantity;
        for (const entry of users) {
          if (entry.startMinute <= t && t < entry.endMinute) {
            demand += entry.needs.get(resourceId) ?? 0;
          }
        }
        if (demand > capacity) {
          resourcesFit = false;
          break;
        }
      }

      if (!resourcesFit) break;
    }

    if (resourcesFit) return start;
  }

  return undefined;
}

/**
 * Creates a schedule that respects task dependencies and, when a context is
 * supplied, person availability and resource limits. Tasks run in parallel
 * whenever no constraint prevents it. All times are minutes from the start of
 * the planning horizon.
 *
 * Deterministic: tasks are placed in priority order (critical first), then by
 * task ID; each is placed at its earliest feasible start. The result never
 * depends on the order of the input array.
 *
 * Any violated hard constraint yields `feasible: false` with an empty schedule.
 */
export function createSchedule(
  tasks: readonly Task[],
  context: SchedulingContext = {},
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

  const orderedTasks = [...tasks].sort((a, b) => compareText(a.id, b.id));
  const errors: string[] = [];

  const taskById = new Map<string, Task>();
  for (const task of orderedTasks) {
    if (taskById.has(task.id)) {
      errors.push(`Duplicate task ID "${task.id}"`);
    } else {
      taskById.set(task.id, task);
    }
  }

  for (const task of orderedTasks) {
    for (const dependencyId of task.dependsOnTaskIds) {
      if (!taskById.has(dependencyId)) {
        errors.push(
          `Task "${task.id}" depends on missing task "${dependencyId}"`,
        );
      }
    }
  }

  errors.push(...validateConstraintInputs(orderedTasks, context));

  if (errors.length > 0) {
    return { feasible: false, schedule: [], errors };
  }

  const reusableCapacity = new Map<string, number>();
  for (const resource of context.resources ?? []) {
    if (resource.kind === "reusable") {
      reusableCapacity.set(resource.id, resource.quantity);
    }
  }

  const placed: PlacedTask[] = [];
  const placedById = new Map<string, PlacedTask>();
  const remaining = new Map(taskById);

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) =>
      task.dependsOnTaskIds.every((id) => placedById.has(id)),
    );

    ready.sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        compareText(a.id, b.id),
    );

    const next = ready[0];
    if (!next) {
      return {
        feasible: false,
        schedule: [],
        errors: [
          `Unable to order remaining tasks: ${[...remaining.keys()].join(", ")}`,
        ],
      };
    }

    let earliest = 0;
    for (const dependencyId of next.dependsOnTaskIds) {
      const dependency = placedById.get(dependencyId);
      if (dependency) earliest = Math.max(earliest, dependency.endMinute);
    }

    const start = findEarliestStart(next, earliest, placed, reusableCapacity);
    if (start === undefined) {
      return {
        feasible: false,
        schedule: [],
        errors: [`Task "${next.id}" could not be placed without violating a constraint`],
      };
    }

    const entry: PlacedTask = {
      taskId: next.id,
      startMinute: start,
      endMinute: start + next.estimatedMinutes,
      personId: next.assignedPersonId,
      needs: aggregateNeeds(next),
    };

    placed.push(entry);
    placedById.set(next.id, entry);
    remaining.delete(next.id);
  }

  const schedule: ScheduledTask[] = placed
    .map((entry) => ({
      taskId: entry.taskId,
      startMinute: entry.startMinute,
      endMinute: entry.endMinute,
    }))
    .sort(
      (a, b) =>
        a.startMinute - b.startMinute || compareText(a.taskId, b.taskId),
    );

  return { feasible: true, schedule, errors: [] };
}