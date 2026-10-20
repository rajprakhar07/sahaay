
import type { HouseholdPlan, Person, Resource, Task } from "./index";
import { createPlan, type PlanResult, type PlanningIssue } from "./planner";

export type Disruption =
  | { type: "person_unavailable"; personId: string }
  | { type: "resource_unavailable"; resourceId: string }
  | { type: "location_inaccessible"; locationId: string };

export interface RecoveryChange {
  taskId: string;
  kind: "reassigned" | "unresolved" | "assignment_changed";
  message: string;
}

export interface RecoveryResult {
  /** True when every original task is planned and the resulting plan validates. */
  complete: boolean;
  /** True when every required task is scheduled and the schedule validates. */
  recovered: boolean;
  disruptionsApplied: Disruption[];
  scenario: {
    people: Person[];
    resources: Resource[];
    inaccessibleLocationIds: string[];
  };
  originalPlan: PlanResult;
  recoveryPlan: PlanResult;
  changes: RecoveryChange[];
  unresolvedRisks: PlanningIssue[];
}

function assertKnownTarget(


  disruption: Disruption,
  plan: HouseholdPlan,
): void {
      const type = (disruption as { type?: unknown } | null)?.type;

  if (
    type !== "person_unavailable" &&
    type !== "resource_unavailable" &&
    type !== "location_inaccessible"
  ) {
    throw new RangeError(
      `Unsupported disruption type "${String(type)}".`,
    );
  }
  if (
    disruption.type === "person_unavailable" &&
    !plan.people.some((person) => person.id === disruption.personId)
  ) {
    throw new RangeError(
      `Unknown person ID "${disruption.personId}" in disruption.`,
    );
  }

  if (
    disruption.type === "resource_unavailable" &&
    !plan.resources.some((resource) => resource.id === disruption.resourceId)
  ) {
    throw new RangeError(
      `Unknown resource ID "${disruption.resourceId}" in disruption.`,
    );
  }

  if (
    disruption.type === "location_inaccessible" &&
    !plan.locations.some((location) => location.id === disruption.locationId)
  ) {
    throw new RangeError(
      `Unknown location ID "${disruption.locationId}" in disruption.`,
    );
  }
}

function mergeIssues(
  issues: readonly PlanningIssue[],
): PlanningIssue[] {
  const byTaskId = new Map<string, PlanningIssue>();

  for (const issue of issues) {
    // Keep the first explanation for each task.
    if (!byTaskId.has(issue.taskId)) {
      byTaskId.set(issue.taskId, issue);
    }
  }

  return [...byTaskId.values()].sort((a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
  );
}

/**
 * Applies simulated disruptions to a cloned household state, then runs the
 * existing deterministic assignment, scheduling, and validation pipeline.
 *
 * The input plan is never mutated. An unavailable location or resource blocks
 * tasks that directly depend on it. The planner then blocks dependent tasks
 * whose prerequisites are no longer available.
 */
export function recoverPlan(
  household: HouseholdPlan,
  disruptions: readonly Disruption[],
): RecoveryResult {
  // Reject invalid event targets before making any scenario changes.
  for (const disruption of disruptions) {
    assertKnownTarget(disruption, household);
  }

  const unavailablePersonIds = new Set<string>();
  const unavailableResourceIds = new Set<string>();
  const inaccessibleLocationIds = new Set<string>();

  for (const disruption of disruptions) {
    switch (disruption.type) {
      case "person_unavailable":
        unavailablePersonIds.add(disruption.personId);
        break;
      case "resource_unavailable":
        unavailableResourceIds.add(disruption.resourceId);
        break;
      case "location_inaccessible":
        inaccessibleLocationIds.add(disruption.locationId);
        break;
    }
  }
const scenarioPeople = household.people.map((person) => ({
  ...person,
  available: unavailablePersonIds.has(person.id)
    ? false
    : person.available,
  skills: [...person.skills],
}));


  const scenarioResources = household.resources.map((resource) =>
    unavailableResourceIds.has(resource.id)
      ? { ...resource, quantity: 0 }
      : { ...resource },
  );

  const originalPlan = createPlan(
    household.tasks,
    household.people,
    household.resources,
  );

  const excludedIssues: PlanningIssue[] = [];

  const plannableTasks = household.tasks
    .filter((task) => {
      const blockedLocation =
        task.locationId !== undefined &&
        inaccessibleLocationIds.has(task.locationId);

      const unavailableNeed = task.resourceNeeds.find((need) =>
        unavailableResourceIds.has(need.resourceId),
      );

      if (blockedLocation) {
        excludedIssues.push({
          taskId: task.id,
          reason: `Blocked because location "${task.locationId}" is inaccessible in this simulated scenario.`,
        });
        return false;
      }

      if (unavailableNeed) {
        excludedIssues.push({
          taskId: task.id,
          reason: `Blocked because required resource "${unavailableNeed.resourceId}" is unavailable in this simulated scenario.`,
        });
        return false;
      }

      return true;
    })
    .map((task) => {
      // Existing explicit assignments are normally preserved. During recovery,
      // clear an assignment only when that assigned person was disrupted.
      if (
        task.assignedPersonId !== undefined &&
        unavailablePersonIds.has(task.assignedPersonId)
      ) {
        const { assignedPersonId: _removedAssignment, ...unassignedTask } =
          task;
        return unassignedTask;
      }

      return { ...task };
    });

  const plannedRecovery = createPlan(
    plannableTasks as Task[],
    scenarioPeople,
    scenarioResources,
  );

const schedulingFailureIssues: PlanningIssue[] =
  plannedRecovery.schedulingErrors.length > 0
    ? household.tasks.map((task) => ({
        taskId: task.id,
        reason: `Plan-level scheduling failure: ${plannedRecovery.schedulingErrors.join("; ")}`,
      }))
    : [];

const unresolvedRisks = mergeIssues([
  ...plannedRecovery.unassignedTasks,
  ...schedulingFailureIssues,
  ...excludedIssues,
]);
  // A recovery is complete only if every original task is scheduled.
  const scheduledIds = new Set(
  plannedRecovery.schedule.map((entry) => entry.taskId),
);

// Duplicate IDs make task-level completion ambiguous. Never claim recovery
// when the original household contains duplicate task IDs.
const taskIds = household.tasks.map((task) => task.id);
const hasDuplicateTaskIds = new Set(taskIds).size !== taskIds.length;

  const complete =
  household.tasks.length > 0 &&
  !hasDuplicateTaskIds &&
  household.tasks.every((task) => scheduledIds.has(task.id)) &&
  plannedRecovery.validation.valid &&
  plannedRecovery.schedulingErrors.length === 0 &&
  unresolvedRisks.length === 0;

  // Optional tasks may remain unresolved without making the required portion
  // impossible. This flag checks every required task explicitly.
  const requiredTasks = household.tasks.filter((task) => task.required);

  const recovered =
  household.tasks.length > 0 &&
  plannedRecovery.schedule.length > 0 &&
  !hasDuplicateTaskIds &&
  requiredTasks.every((task) => scheduledIds.has(task.id)) &&
  plannedRecovery.validation.valid &&
  plannedRecovery.schedulingErrors.length === 0;

  const recoveryPlan: PlanResult = {
    ...plannedRecovery,
    complete,
    feasible: complete,
    unassignedTasks: unresolvedRisks,
  };

  const originalAssignments = new Map(
    originalPlan.assignedTasks.map((task) => [
      task.id,
      task.assignedPersonId,
    ]),
  );

  const recoveredAssignments = new Map(
    plannedRecovery.assignedTasks.map((task) => [
      task.id,
      task.assignedPersonId,
    ]),
  );

  const changes: RecoveryChange[] = [];

  for (const task of household.tasks) {
    const before = originalAssignments.get(task.id);
    const after = recoveredAssignments.get(task.id);
    const unresolved = unresolvedRisks.find(
      (issue) => issue.taskId === task.id,
    );

    if (unresolved) {
      changes.push({
        taskId: task.id,
        kind: "unresolved",
        message: unresolved.reason,
      });
    } else if (before !== after) {
      changes.push({
        taskId: task.id,
        kind: before === undefined ? "assignment_changed" : "reassigned",
        message:
          before === undefined
            ? `Task "${task.id}" now has an assignment.`
            : `Task "${task.id}" changed assignment from "${before}" to "${after}".`,
      });
    }
  }

  return {
    complete,
    recovered,
    disruptionsApplied: disruptions.map((disruption) => ({ ...disruption })),
    scenario: {
      people: scenarioPeople,
      resources: scenarioResources,
      inaccessibleLocationIds: [...inaccessibleLocationIds].sort(),
    },
    originalPlan,
    recoveryPlan,
    changes,
    unresolvedRisks,
  };
}
