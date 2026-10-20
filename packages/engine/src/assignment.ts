
import type { Person, Task } from "./index";


export type AssignmentFailureReason =
  | "UNKNOWN_PERSON"
  | "PERSON_UNAVAILABLE"
  | "MISSING_REQUIRED_SKILLS"
  | "NO_ELIGIBLE_PERSON"
  | "DUPLICATE_TASK_ID"
  | "DUPLICATE_PERSON_ID"
  | "ASSIGNMENT_ABORTED";


export interface TaskAssignment {
  taskId: string;
  personId?: string;
  assigned: boolean;
  reason?: AssignmentFailureReason;
  explanation?: string;
}

export interface AssignmentResult {
  assignments: TaskAssignment[];
  complete: boolean;
}

const PRIORITY_RANK: Record<Task["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeSkill(skill: string): string {
  return skill.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasRequiredSkills(task: Task, person: Person): boolean {
  const skills = new Set(person.skills.map(normalizeSkill));

  return task.requiredSkills.every((skill) =>
    skills.has(normalizeSkill(skill)),
  );
}

/**
 * Assigns people to tasks without scheduling them in time.
 *
 * Existing explicit assignments are preserved, never silently replaced.
 * Remaining tasks are considered by fewest eligible candidates, priority,
 * then task ID. Candidate selection balances assigned minutes, then person ID.
 *
 * This function does not mutate its inputs.
 */
export function assignTasks( 
  tasks: readonly Task[],
  people: readonly Person[],
):
 AssignmentResult {
    
  const taskIds = new Set<string>();
  const duplicateTaskIds = new Set<string>();

  for (const task of tasks) {
    if (taskIds.has(task.id)) duplicateTaskIds.add(task.id);
    taskIds.add(task.id);
  }

  const personIds = new Set<string>();
  const duplicatePersonIds = new Set<string>();

  for (const person of people) {
    if (personIds.has(person.id)) duplicatePersonIds.add(person.id);
    personIds.add(person.id);
  }

  if (duplicateTaskIds.size > 0 || duplicatePersonIds.size > 0) {
    return {
      assignments: tasks.map((task) => {
        if (duplicateTaskIds.has(task.id)) {
          return {
            taskId: task.id,
            assigned: false,
            reason: "DUPLICATE_TASK_ID" as const,
            explanation: `Task ID "${task.id}" appears more than once.`,
          };
        }

        if (duplicatePersonIds.size > 0) {
          return {
            taskId: task.id,
            assigned: false,
            reason: "DUPLICATE_PERSON_ID" as const,
            explanation: "Duplicate person IDs make assignments ambiguous.",
          };
        }

        return {
          taskId: task.id,
          assigned: false,
          reason: "ASSIGNMENT_ABORTED" as const,
          explanation:
            "Assignment stopped because duplicate task IDs make the overall assignment ambiguous.",
        };
      }),
      complete: false,
    };
  }

  const assignments = new Map<string, TaskAssignment>();
  const assignedMinutes = new Map<string, number>();
  const peopleById = new Map<string, Person>();

  const orderedPeople = [...people].sort((a, b) =>
    compareText(a.id, b.id),
  );

  for (const person of orderedPeople) {
    if (!peopleById.has(person.id)) {
      peopleById.set(person.id, person);
    }
    assignedMinutes.set(person.id, 0);
  }

  const orderedTasks = [...tasks].sort((a, b) =>
    compareText(a.id, b.id),
  );

  const seenTaskIds = new Set<string>();

  // Preserve and validate explicit assignments first.
  for (const task of orderedTasks) {
    if (seenTaskIds.has(task.id)) {
      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason: "NO_ELIGIBLE_PERSON",
        explanation: "Duplicate task ID prevents an unambiguous assignment.",
      });
      continue;
    }
    seenTaskIds.add(task.id);

    if (task.assignedPersonId === undefined) continue;

    const person = peopleById.get(task.assignedPersonId);

    if (!person) {
      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason: "UNKNOWN_PERSON",
        explanation: `Explicitly assigned person "${task.assignedPersonId}" does not exist.`,
      });
    } else if (!person.available) {
      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason: "PERSON_UNAVAILABLE",
        explanation: `Explicitly assigned person "${person.id}" is unavailable.`,
      });
    } else if (!hasRequiredSkills(task, person)) {
      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason: "MISSING_REQUIRED_SKILLS",
        explanation: `Explicitly assigned person "${person.id}" lacks one or more required skills.`,
      });
    } else {
      assignments.set(task.id, {
        taskId: task.id,
        personId: person.id,
        assigned: true,
      });
      assignedMinutes.set(
        person.id,
        (assignedMinutes.get(person.id) ?? 0) + task.estimatedMinutes,
      );
    }
  }

  const pending = orderedTasks.filter(
    (task) =>
      !assignments.has(task.id) &&
      task.assignedPersonId === undefined,
  );

  const eligibleByTask = new Map<string, Person[]>();

  for (const task of pending) {
    const eligible = orderedPeople.filter(
      (person) => person.available && hasRequiredSkills(task, person),
    );
    eligibleByTask.set(task.id, eligible);
  }

  pending.sort((a, b) => {
    const aCount = eligibleByTask.get(a.id)?.length ?? 0;
    const bCount = eligibleByTask.get(b.id)?.length ?? 0;

    return (
      aCount - bCount ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      compareText(a.id, b.id)
    );
  });

  for (const task of pending) {
    const eligible = eligibleByTask.get(task.id) ?? [];

    if (eligible.length === 0) {
      const knownSkillHolders = orderedPeople.filter((person) =>
        hasRequiredSkills(task, person),
      );

      const reason: AssignmentFailureReason =
        knownSkillHolders.length > 0
          ? "PERSON_UNAVAILABLE"
          : "NO_ELIGIBLE_PERSON";

      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason,
        explanation:
          reason === "PERSON_UNAVAILABLE"
            ? "People with the required skills exist, but none are available."
            : task.requiredSkills.length > 0
              ? `No person has all required skills: ${task.requiredSkills.join(", ")}.`
              : "No available person can be assigned to this task.",
      });
      continue;
    }

    eligible.sort(
      (a, b) =>
        (assignedMinutes.get(a.id) ?? 0) -
          (assignedMinutes.get(b.id) ?? 0) ||
        compareText(a.id, b.id),
    );

    const chosen = eligible[0];

    if (!chosen) {
      assignments.set(task.id, {
        taskId: task.id,
        assigned: false,
        reason: "NO_ELIGIBLE_PERSON",
        explanation: "No eligible person could be selected.",
      });
      continue;
    }

    assignments.set(task.id, {
      taskId: task.id,
      personId: chosen.id,
      assigned: true,
    });

    assignedMinutes.set(
      chosen.id,
      (assignedMinutes.get(chosen.id) ?? 0) + task.estimatedMinutes,
    );
  }

  const results = orderedTasks.map(
    (task) =>
      assignments.get(task.id) ?? {
        taskId: task.id,
        assigned: false,
        reason: "NO_ELIGIBLE_PERSON" as const,
        explanation: "Task could not be assigned unambiguously.",
      },
  );

  return {
    assignments: results,
    complete: results.every((result) => result.assigned),
  };
}
