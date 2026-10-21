import type { HouseholdPlan, Person, Resource, Task } from "./index";
import { assignTasks, normalizeSkill } from "./assignment";
import { checkDependencyIntegrity } from "./integrity";
import type { PlanResult } from "./planner";

/**
 * Per-task result of a recovery run.
 *
 *  - `resolved`   the task is assigned AND present in a valid schedule.
 *  - `blocked`    the task cannot run because something specific stands in
 *                 its way (an inaccessible location, an unavailable or
 *                 insufficient resource, or an unresolved prerequisite).
 *  - `unresolved` the engine could not assign or schedule the task for a
 *                 reason about people, skills or the schedule itself.
 */
export type TaskOutcomeStatus = "resolved" | "blocked" | "unresolved";

/**
 * Stable, machine-readable reason codes. Each code is emitted only when the
 * engine's own data supports it; see `buildTaskOutcomes` for the exact rule.
 *
 *  PERSON_UNAVAILABLE     people who could do the task exist, none are available
 *  REQUIRED_SKILL_MISSING no single person in the household has every required skill
 *  RESOURCE_UNAVAILABLE   a needed resource was disrupted in this scenario
 *  RESOURCE_INSUFFICIENT  needed quantity exceeds capacity (reusable) or stock (consumable)
 *  LOCATION_INACCESSIBLE  the task's location was disrupted in this scenario
 *  DEPENDENCY_BLOCKED     a prerequisite task is unresolved, missing or ambiguous
 *  DEPENDENCY_CYCLE       the task is part of a dependency cycle
 *  NO_FEASIBLE_ASSIGNMENT assignment failed and no more specific cause applies
 *  AMBIGUOUS_INPUT        duplicate IDs make assignment ambiguous
 *  SCHEDULING_FAILED      the plan-level schedule failed; this task is collateral
 *  UNDIAGNOSED            not scheduled, but the engine reports no cause (defensive)
 */
export type TaskReasonCode =
  | "PERSON_UNAVAILABLE"
  | "REQUIRED_SKILL_MISSING"
  | "RESOURCE_UNAVAILABLE"
  | "RESOURCE_INSUFFICIENT"
  | "LOCATION_INACCESSIBLE"
  | "DEPENDENCY_BLOCKED"
  | "DEPENDENCY_CYCLE"
  | "NO_FEASIBLE_ASSIGNMENT"
  | "AMBIGUOUS_INPUT"
  | "SCHEDULING_FAILED"
  | "UNDIAGNOSED";

export interface TaskBlocker {
  kind: "person" | "resource" | "location" | "task" | "skill";
  id: string;
}

export interface TaskOutcome {
  taskId: string;
  required: boolean;
  status: TaskOutcomeStatus;
  /** Present if and only if `status` is not `resolved`. */
  reasonCode?: TaskReasonCode;
  /** Human-readable, derived from the same data as `reasonCode`. */
  explanation: string;
  /** What stands in the way. Empty when nothing specific can be named. */
  blockedBy: TaskBlocker[];
  /** Assignee in the recovery plan (resolved tasks only). */
  assignedPersonId?: string;
  /** Assignee in the no-disruption baseline plan, when one existed. */
  baselineAssignedPersonId?: string;
}

/**
 * - `fully_recovered`     every required task is resolved (and at least one
 *                         task is resolved). Unresolved optional tasks are
 *                         reported in `summary`, not hidden, but do not
 *                         prevent this status.
 * - `partially_recovered` at least one required task is resolved, and at
 *                         least one required task is not.
 * - `recovery_failed`     no required task is resolved: no meaningful
 *                         required work can be scheduled. Optional tasks
 *                         being scheduled does not change this.
 */
export type RecoveryStatus =
  | "fully_recovered"
  | "partially_recovered"
  | "recovery_failed";

export interface OutcomeSummary {
  requiredTotal: number;
  requiredResolved: number;
  requiredUnresolved: number;
  optionalTotal: number;
  optionalResolved: number;
  optionalUnresolved: number;
  requiredUnresolvedTaskIds: string[];
  optionalUnresolvedTaskIds: string[];
}

export interface OutcomeInputs {
  household: HouseholdPlan;
  scenarioPeople: readonly Person[];
  scenarioResources: readonly Resource[];
  unavailablePersonIds: ReadonlySet<string>;
  unavailableResourceIds: ReadonlySet<string>;
  inaccessibleLocationIds: ReadonlySet<string>;
  /** Tasks actually handed to the planner (after disruption exclusions). */
  plannableTasks: readonly Task[];
  /** Plan for the household with no disruptions applied. */
  originalPlan: PlanResult;
  /** Raw plan produced for the disrupted scenario. */
  recoveredPlan: PlanResult;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function blockersEqual(a: TaskBlocker, b: TaskBlocker): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function sortBlockers(blockers: readonly TaskBlocker[]): TaskBlocker[] {
  const unique: TaskBlocker[] = [];
  for (const blocker of blockers) {
    if (!unique.some((existing) => blockersEqual(existing, blocker))) {
      unique.push(blocker);
    }
  }
  return unique.sort(
    (a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id),
  );
}

// ---------- Scheduling-level diagnosis (mirrors scheduler rules) ----------

interface ResourceShortfall {
  resourceId: string;
  kind: Resource["kind"];
  /** Demand of the single task (reusable) or total demand (consumable). */
  demand: number;
  stock: number;
}

/**
 * Finds the tasks that directly cause a resource-related scheduling error.
 * This mirrors the rules in `validateConstraintInputs` (scheduler.ts):
 *  - reusable: one task needs more than the resource's capacity;
 *  - consumable: combined demand of all tasks exceeds stock.
 */
function findResourceShortfalls(
  tasks: readonly Task[],
  resources: readonly Resource[],
): Map<string, ResourceShortfall[]> {
  const resourcesById = new Map(resources.map((r) => [r.id, r]));
  const byTask = new Map<string, ResourceShortfall[]>();
  const consumableDemand = new Map<string, number>();
  const consumableUsers = new Map<string, string[]>();

  const push = (taskId: string, shortfall: ResourceShortfall) => {
    const list = byTask.get(taskId) ?? [];
    list.push(shortfall);
    byTask.set(taskId, list);
  };

  for (const task of tasks) {
    const totals = new Map<string, number>();
    for (const need of task.resourceNeeds) {
      totals.set(
        need.resourceId,
        (totals.get(need.resourceId) ?? 0) + need.quantity,
      );
    }

    for (const [resourceId, quantity] of totals) {
      const resource = resourcesById.get(resourceId);
      if (!resource) continue;

      if (resource.kind === "reusable") {
        if (quantity > resource.quantity) {
          push(task.id, {
            resourceId,
            kind: "reusable",
            demand: quantity,
            stock: resource.quantity,
          });
        }
      } else {
        consumableDemand.set(
          resourceId,
          (consumableDemand.get(resourceId) ?? 0) + quantity,
        );
        consumableUsers.set(resourceId, [
          ...(consumableUsers.get(resourceId) ?? []),
          task.id,
        ]);
      }
    }
  }

  for (const [resourceId, demand] of consumableDemand) {
    const resource = resourcesById.get(resourceId);
    if (resource && demand > resource.quantity) {
      for (const taskId of consumableUsers.get(resourceId) ?? []) {
        push(taskId, {
          resourceId,
          kind: "consumable",
          demand,
          stock: resource.quantity,
        });
      }
    }
  }

  return byTask;
}

// ---------- Outcome construction ----------

/**
 * Builds one `TaskOutcome` per household task, in household task order.
 *
 * A task is `resolved` only when it appears in the recovery schedule and the
 * plan as a whole is valid. Every other task is explained using the first
 * applicable cause, checked in this order:
 *
 *  1. duplicate task ID                       -> AMBIGUOUS_INPUT
 *  2. disruption removed the task's location
 *     or a needed resource before planning    -> LOCATION_INACCESSIBLE /
 *                                                RESOURCE_UNAVAILABLE
 *  3. the assignment step rejected the task   -> PERSON_UNAVAILABLE /
 *                                                REQUIRED_SKILL_MISSING /
 *                                                NO_FEASIBLE_ASSIGNMENT /
 *                                                AMBIGUOUS_INPUT
 *  4. plan-level scheduling error caused
 *     directly by this task                   -> DEPENDENCY_CYCLE /
 *                                                RESOURCE_INSUFFICIENT
 *  5. a prerequisite is not resolved          -> DEPENDENCY_BLOCKED
 *  6. plan-level scheduling error, collateral -> SCHEDULING_FAILED
 *  7. anything else                           -> UNDIAGNOSED
 *
 * Assignment diagnosis reuses `assignTasks` on exactly the inputs the planner
 * used; it is a pure, deterministic function, so the result cannot diverge.
 */
export function buildTaskOutcomes(input: OutcomeInputs): TaskOutcome[] {
  const {
    household,
    scenarioPeople,
    scenarioResources,
    unavailablePersonIds,
    unavailableResourceIds,
    inaccessibleLocationIds,
    plannableTasks,
    originalPlan,
    recoveredPlan,
  } = input;

  const tasks = household.tasks;
  const taskById = new Map<string, Task>();
  const duplicateIds = new Set<string>();
  for (const task of tasks) {
    if (taskById.has(task.id)) duplicateIds.add(task.id);
    else taskById.set(task.id, task);
  }

  const personName = (id: string): string => {
    const person = scenarioPeople.find((p) => p.id === id);
    return person ? `${person.name} (${id})` : `"${id}"`;
  };
  const resourceName = (id: string): string => {
    const resource = household.resources.find((r) => r.id === id);
    return resource ? `${resource.name} (${id})` : `"${id}"`;
  };
  const locationName = (id: string): string => {
    const location = household.locations.find((l) => l.id === id);
    return location ? `${location.name} (${id})` : `"${id}"`;
  };
  const taskName = (id: string): string => {
    const task = taskById.get(id);
    return task ? `${id} (${task.title})` : `"${id}"`;
  };

  const scheduledIds = new Set(recoveredPlan.schedule.map((e) => e.taskId));
  const planOk =
    recoveredPlan.schedulingErrors.length === 0 &&
    recoveredPlan.validation.valid;

  const baselineAssignee = new Map(
    originalPlan.assignedTasks.map((t) => [t.id, t.assignedPersonId]),
  );
  const finalAssignee = new Map(
    recoveredPlan.assignedTasks.map((t) => [t.id, t.assignedPersonId]),
  );

  const assignmentFailures = new Map(
    assignTasks(plannableTasks, scenarioPeople)
      .assignments.filter((a) => !a.assigned)
      .map((a) => [a.taskId, a]),
  );

  // Scheduling-level direct causes (only relevant if the scheduler failed).
  const cycleBlockers = new Map<string, TaskBlocker[]>();
  let shortfalls = new Map<string, ResourceShortfall[]>();

  if (recoveredPlan.schedulingErrors.length > 0) {
    const integrity = checkDependencyIntegrity(recoveredPlan.assignedTasks);
    for (const cycle of integrity.cycles) {
      const members = sortedUnique(cycle.taskIds);
      for (const member of members) {
        const others = members.filter((id) => id !== member);
        cycleBlockers.set(
          member,
          (others.length > 0 ? others : [member]).map((id) => ({
            kind: "task" as const,
            id,
          })),
        );
      }
    }
    shortfalls = findResourceShortfalls(
      recoveredPlan.assignedTasks,
      scenarioResources,
    );
  }

  const outcomes: Array<TaskOutcome | undefined> = tasks.map(() => undefined);
  const outcomeById = new Map<string, TaskOutcome>();

  const record = (
    index: number,
    task: Task,
    status: TaskOutcomeStatus,
    reasonCode: TaskReasonCode | undefined,
    explanation: string,
    blockedBy: readonly TaskBlocker[] = [],
  ): void => {
    const baseline = baselineAssignee.get(task.id);
    const assigned =
      status === "resolved" ? finalAssignee.get(task.id) : undefined;

    const outcome: TaskOutcome = {
      taskId: task.id,
      required: task.required,
      status,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      explanation,
      blockedBy: sortBlockers(blockedBy),
      ...(assigned === undefined ? {} : { assignedPersonId: assigned }),
      ...(baseline === undefined ? {} : { baselineAssignedPersonId: baseline }),
    };

    outcomes[index] = outcome;
    if (!duplicateIds.has(task.id)) outcomeById.set(task.id, outcome);
  };

  // Pass 1: causes that do not depend on other tasks' outcomes.
  tasks.forEach((task, index) => {
    // Resolved.
    if (
      !duplicateIds.has(task.id) &&
      planOk &&
      scheduledIds.has(task.id)
    ) {
      const assigned = finalAssignee.get(task.id);
      const baseline = baselineAssignee.get(task.id);
      let explanation =
        assigned === undefined
          ? "Scheduled."
          : `Scheduled and assigned to ${personName(assigned)}.`;

      if (assigned !== undefined && baseline !== undefined && assigned !== baseline) {
        const reason = unavailablePersonIds.has(baseline)
          ? ` ${personName(baseline)} is unavailable in this scenario.`
          : "";
        explanation += ` Reassigned from ${personName(baseline)}.${reason}`;
      }

      record(index, task, "resolved", undefined, explanation);
      return;
    }

    // 1. Duplicate ID.
    if (duplicateIds.has(task.id)) {
      record(
        index,
        task,
        "unresolved",
        "AMBIGUOUS_INPUT",
        `Task ID "${task.id}" appears more than once, so this task cannot be planned unambiguously.`,
      );
      return;
    }

    // 2. Disruption removed location or resource before planning.
    const locationBlocked =
      task.locationId !== undefined &&
      inaccessibleLocationIds.has(task.locationId);
    const disruptedResources = sortedUnique(
      task.resourceNeeds
        .map((need) => need.resourceId)
        .filter((id) => unavailableResourceIds.has(id)),
    );

    if (locationBlocked || disruptedResources.length > 0) {
      const blockedBy: TaskBlocker[] = [];
      const parts: string[] = [];

      if (locationBlocked && task.locationId !== undefined) {
        blockedBy.push({ kind: "location", id: task.locationId });
        parts.push(
          `location ${locationName(task.locationId)} is inaccessible in this scenario`,
        );
      }
      for (const id of disruptedResources) {
        blockedBy.push({ kind: "resource", id });
        parts.push(`required resource ${resourceName(id)} is unavailable in this scenario`);
      }

      record(
        index,
        task,
        "blocked",
        locationBlocked ? "LOCATION_INACCESSIBLE" : "RESOURCE_UNAVAILABLE",
        `Blocked: ${parts.join("; ")}.`,
        blockedBy,
      );
      return;
    }

    // 3. Assignment step rejected the task.
    const failure = assignmentFailures.get(task.id);
    if (failure) {
      const holdsAllSkills = (person: Person): boolean => {
        const owned = new Set(person.skills.map(normalizeSkill));
        return task.requiredSkills.every((s) => owned.has(normalizeSkill(s)));
      };

      if (
        failure.reason === "DUPLICATE_TASK_ID" ||
        failure.reason === "DUPLICATE_PERSON_ID" ||
        failure.reason === "ASSIGNMENT_ABORTED"
      ) {
        record(
          index,
          task,
          "unresolved",
          "AMBIGUOUS_INPUT",
          failure.explanation ?? "Duplicate IDs make assignment ambiguous.",
        );
        return;
      }

      if (failure.reason === "PERSON_UNAVAILABLE") {
        const people =
          task.assignedPersonId !== undefined
            ? scenarioPeople.filter((p) => p.id === task.assignedPersonId)
            : scenarioPeople.filter((p) => !p.available && holdsAllSkills(p));
        const names = people.map((p) => {
          const note = unavailablePersonIds.has(p.id)
            ? " [disrupted in this scenario]"
            : "";
          return `${personName(p.id)}${note}`;
        });

        record(
          index,
          task,
          "unresolved",
          "PERSON_UNAVAILABLE",
          task.assignedPersonId !== undefined
            ? `Assigned person ${names.join(", ")} is unavailable.`
            : `Everyone able to do this task is unavailable: ${names.join(", ")}.`,
          people.map((p) => ({ kind: "person" as const, id: p.id })),
        );
        return;
      }

      if (
        failure.reason === "MISSING_REQUIRED_SKILLS" ||
        (failure.reason === "NO_ELIGIBLE_PERSON" &&
          task.requiredSkills.length > 0 &&
          !scenarioPeople.some(holdsAllSkills))
      ) {
        const heldBySomeone = new Set(
          scenarioPeople.flatMap((p) => p.skills.map(normalizeSkill)),
        );
        const unheld = task.requiredSkills.filter(
          (s) => !heldBySomeone.has(normalizeSkill(s)),
        );
        const detail =
          failure.reason === "MISSING_REQUIRED_SKILLS" &&
          task.assignedPersonId !== undefined
            ? `Assigned person ${personName(task.assignedPersonId)} lacks required skills (${task.requiredSkills.join(", ")}).`
            : unheld.length > 0
              ? `Nobody in the household has the required skill(s): ${unheld.join(", ")}.`
              : `No single person has all required skills: ${task.requiredSkills.join(", ")}.`;

        record(
          index,
          task,
          "unresolved",
          "REQUIRED_SKILL_MISSING",
          detail,
          unheld.map((skill) => ({ kind: "skill" as const, id: skill })),
        );
        return;
      }

      record(
        index,
        task,
        "unresolved",
        "NO_FEASIBLE_ASSIGNMENT",
        failure.explanation ?? "No feasible assignment exists for this task.",
      );
      return;
    }

    // 4. Plan-level scheduling error caused directly by this task.
    if (recoveredPlan.schedulingErrors.length > 0) {
      const cycle = cycleBlockers.get(task.id);
      if (cycle) {
        record(
          index,
          task,
          "blocked",
          "DEPENDENCY_CYCLE",
          `Part of a dependency cycle with ${cycle.map((b) => taskName(b.id)).join(", ")}.`,
          cycle,
        );
        return;
      }

      const shortfall = shortfalls.get(task.id);
      if (shortfall && shortfall.length > 0) {
        const parts = shortfall.map((s) =>
          s.kind === "reusable"
            ? `${resourceName(s.resourceId)} needs ${s.demand} but capacity is ${s.stock}`
            : `${resourceName(s.resourceId)}: combined demand of ${s.demand} exceeds stock of ${s.stock}`,
        );
        record(
          index,
          task,
          "blocked",
          "RESOURCE_INSUFFICIENT",
          `Insufficient resources: ${parts.join("; ")}. The scheduler abandons the whole schedule when a constraint is violated.`,
          shortfall.map((s) => ({ kind: "resource" as const, id: s.resourceId })),
        );
      }
    }
  });

  // Pass 2: dependency blocking, repeated until no further task changes.
  let changed = true;
  while (changed) {
    changed = false;

    tasks.forEach((task, index) => {
      if (outcomes[index] !== undefined) return;

      const blockers: TaskBlocker[] = [];
      const notes: string[] = [];

      for (const dependencyId of task.dependsOnTaskIds) {
        if (!taskById.has(dependencyId)) {
          blockers.push({ kind: "task", id: dependencyId });
          notes.push(`prerequisite "${dependencyId}" does not exist`);
        } else if (duplicateIds.has(dependencyId)) {
          blockers.push({ kind: "task", id: dependencyId });
          notes.push(`prerequisite "${dependencyId}" is ambiguous (duplicate ID)`);
        } else {
          const dependency = outcomeById.get(dependencyId);
          if (dependency && dependency.status !== "resolved") {
            blockers.push({ kind: "task", id: dependencyId });
            notes.push(
              `prerequisite ${taskName(dependencyId)} is ${dependency.status}` +
                (dependency.reasonCode ? ` (${dependency.reasonCode})` : ""),
            );
          }
        }
      }

      if (blockers.length > 0) {
        record(
          index,
          task,
          "blocked",
          "DEPENDENCY_BLOCKED",
          `Cannot run: ${notes.join("; ")}.`,
          blockers,
        );
        changed = true;
      }
    });
  }

  // Pass 3: anything left is collateral of a plan-level failure, or unknown.
  tasks.forEach((task, index) => {
    if (outcomes[index] !== undefined) return;

    if (recoveredPlan.schedulingErrors.length > 0) {
      record(
        index,
        task,
        "unresolved",
        "SCHEDULING_FAILED",
        `The plan-level schedule failed, so no task was scheduled: ${recoveredPlan.schedulingErrors.join("; ")}.`,
      );
    } else if (!recoveredPlan.validation.valid) {
      record(
        index,
        task,
        "unresolved",
        "SCHEDULING_FAILED",
        `The schedule failed independent validation: ${recoveredPlan.validation.violations
          .map((v) => v.message)
          .join("; ")}.`,
      );
    } else {
      record(
        index,
        task,
        "unresolved",
        "UNDIAGNOSED",
        "The task was not scheduled, but the engine reported no specific cause.",
      );
    }
  });

  return outcomes.filter((o): o is TaskOutcome => o !== undefined);
}

export function summarizeOutcomes(
  outcomes: readonly TaskOutcome[],
): OutcomeSummary {
  const required = outcomes.filter((o) => o.required);
  const optional = outcomes.filter((o) => !o.required);
  const unresolvedIds = (list: readonly TaskOutcome[]) =>
    sortedUnique(
      list.filter((o) => o.status !== "resolved").map((o) => o.taskId),
    );

  const requiredUnresolvedTaskIds = unresolvedIds(required);
  const optionalUnresolvedTaskIds = unresolvedIds(optional);
  const requiredResolved = required.filter((o) => o.status === "resolved").length;
  const optionalResolved = optional.filter((o) => o.status === "resolved").length;

  return {
    requiredTotal: required.length,
    requiredResolved,
    requiredUnresolved: required.length - requiredResolved,
    optionalTotal: optional.length,
    optionalResolved,
    optionalUnresolved: optional.length - optionalResolved,
    requiredUnresolvedTaskIds,
    optionalUnresolvedTaskIds,
  };
}

/**
 * Derives the recovery status purely from task outcomes (see `RecoveryStatus`).
 * No UI state, colors, or free-text reasons are consulted.
 */
export function deriveRecoveryStatus(
  summary: OutcomeSummary,
): RecoveryStatus {
  const anyResolved = summary.requiredResolved + summary.optionalResolved > 0;

  if (summary.requiredUnresolved === 0 && anyResolved) {
    return "fully_recovered";
  }
  if (summary.requiredResolved > 0) {
    return "partially_recovered";
  }
  return "recovery_failed";
}
