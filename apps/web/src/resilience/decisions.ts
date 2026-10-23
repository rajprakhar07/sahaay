/**
 * Recovery decisions: pure derivations that explain WHY the planner ended up
 * where it did.
 *
 * Everything here is computed from two real inputs only: the household model
 * and the engine's own task outcomes (plus the independent validation result
 * it reports). Nothing is invented. When the data cannot support a statement,
 * the statement is not made.
 *
 * What this module does NOT know: the planner's running workload at the moment
 * it picked a person. It can say who was eligible and who was not, and quote
 * the planner's documented tie-break rule, but it never claims a workload
 * number the engine did not report.
 */

import {
  describeDisruption,
  nameOf,
  normalizeSkill,
  reasonTitle,
  recoveryCondition,
  type Household,
  type Person,
  type PlanView,
  type Reference,
  type Task,
  type TaskChange,
  type TaskState,
} from "./model";

// ------------------------------------------------------------ candidates ---

export type CandidateVerdict =
  | "selected"
  | "eligible_not_selected"
  | "disrupted"
  | "unavailable_in_model"
  | "missing_skills";

export interface Candidate {
  personId: string;
  verdict: CandidateVerdict;
  /** Required skills this person lacks (only for `missing_skills`). */
  missingSkills: string[];
  detail: string;
}

/** The planner's documented tie-break (see `assignTasks` in the engine). */
export const TIE_BREAK_RULE =
  "When several people are eligible, the planner picks the one with the least time assigned so far, then the lowest ID.";

function disruptedPersonIds(view: PlanView): Set<string> {
  return new Set(view.disruptions.flatMap((d) => (d.personId ? [d.personId] : [])));
}
function disruptedResourceIds(view: PlanView): Set<string> {
  return new Set(view.disruptions.flatMap((d) => (d.resourceId ? [d.resourceId] : [])));
}
function disruptedLocationIds(view: PlanView): Set<string> {
  return new Set(view.disruptions.flatMap((d) => (d.locationId ? [d.locationId] : [])));
}

function missingSkillsOf(task: Task, person: Person): string[] {
  const owned = new Set(person.skills.map(normalizeSkill));
  return task.requiredSkills.filter((s) => !owned.has(normalizeSkill(s)));
}

/**
 * Classifies every person in the household for one task, using the same
 * criteria as the planner: available (not disrupted, not unavailable in the
 * model) and holding every required skill.
 */
export function classifyCandidates(
  household: Household,
  task: Task,
  view: PlanView,
  selectedPersonId?: string,
): Candidate[] {
  const disrupted = disruptedPersonIds(view);
  return household.people.map((person): Candidate => {
    if (disrupted.has(person.id)) {
      return {
        personId: person.id,
        verdict: "disrupted",
        missingSkills: [],
        detail: "Unavailable: disrupted in this simulated scenario.",
      };
    }
    if (!person.available) {
      return {
        personId: person.id,
        verdict: "unavailable_in_model",
        missingSkills: [],
        detail: "Unavailable: marked unavailable in the household model.",
      };
    }
    const missing = missingSkillsOf(task, person);
    if (missing.length > 0) {
      return {
        personId: person.id,
        verdict: "missing_skills",
        missingSkills: missing,
        detail: `Available, but lacks: ${missing.join(", ")}.`,
      };
    }
    const chosen = person.id === selectedPersonId;
    return {
      personId: person.id,
      verdict: chosen ? "selected" : "eligible_not_selected",
      missingSkills: [],
      detail: chosen
        ? "Available and has every required skill. Selected."
        : "Available and has every required skill. Not selected.",
    };
  });
}

// ----------------------------------------------------------- constraints ---

export interface ConstraintCheck {
  kind: "skill" | "resource" | "location" | "dependency";
  met: boolean;
  text: string;
}

/**
 * The constraints that bear on a task in the current scenario, each checked
 * against real data. Skill checks need an assignee; without one they are
 * omitted rather than guessed.
 */
export function checkConstraints(
  household: Household,
  task: Task,
  view: PlanView,
): ConstraintCheck[] {
  const checks: ConstraintCheck[] = [];
  const state = view.tasks.find((t) => t.taskId === task.id);
  const assignee = state?.assignedPersonId
    ? household.people.find((p) => p.id === state.assignedPersonId)
    : undefined;

  if (assignee) {
    for (const skill of task.requiredSkills) {
      const has = !missingSkillsOf({ ...task, requiredSkills: [skill] }, assignee).length;
      checks.push({
        kind: "skill",
        met: has,
        text: has
          ? `Needs ${skill}: ${assignee.name} has it.`
          : `Needs ${skill}: ${assignee.name} does not have it.`,
      });
    }
  }

  const disruptedRes = disruptedResourceIds(view);
  for (const need of task.resourceNeeds) {
    const resource = household.resources.find((r) => r.id === need.resourceId);
    const label = nameOf(household, "resource", need.resourceId);
    const unit = resource?.unit ? ` ${resource.unit}` : "";
    if (disruptedRes.has(need.resourceId)) {
      checks.push({
        kind: "resource",
        met: false,
        text: `Needs ${label} (${need.quantity}${unit}): unavailable in this scenario.`,
      });
    } else if (resource && resource.quantity < need.quantity) {
      checks.push({
        kind: "resource",
        met: false,
        text: `Needs ${label} (${need.quantity}${unit}): only ${resource.quantity} exist.`,
      });
    } else {
      checks.push({
        kind: "resource",
        met: true,
        text: `Needs ${label} (${need.quantity}${unit}): available${
          resource ? ` (${resource.quantity}${unit} in the model)` : ""
        }.`,
      });
    }
  }

  if (task.locationId !== undefined) {
    const label = nameOf(household, "location", task.locationId);
    const blocked = disruptedLocationIds(view).has(task.locationId);
    checks.push({
      kind: "location",
      met: !blocked,
      text: blocked
        ? `Takes place at ${label}: inaccessible in this scenario.`
        : `Takes place at ${label}: accessible.`,
    });
  }

  for (const depId of task.dependsOnTaskIds) {
    const dep = view.tasks.find((t) => t.taskId === depId);
    const resolved = dep?.status === "resolved";
    checks.push({
      kind: "dependency",
      met: resolved,
      text: `Must follow ${depId} ${nameOf(household, "task", depId)}: ${
        dep ? dep.status : "no result reported"
      }.`,
    });
  }

  return checks;
}

// ----------------------------------------------------------- assignments ---

export type AssignmentKind = "reassigned" | "assigned" | "kept" | "explicit";

export interface AssignmentDecision {
  kind: AssignmentKind;
  from?: string;
  to: string;
  candidates: Candidate[];
  eligibleCount: number;
  /** Set only when more than one person was eligible. */
  tieBreak?: string;
  /** False when the household data does not show `to` as eligible. */
  consistent: boolean;
  /** Plain-language account of the decision, from the data above. */
  summary: string;
}

function listNames(household: Household, ids: string[]): string {
  return ids.map((id) => nameOf(household, "person", id)).join(", ");
}

/**
 * Explains one resolved task's assignment. `previousPersonId` is the assignee
 * in whatever plan the user is comparing against (or the engine's baseline).
 */
export function explainAssignment(
  household: Household,
  task: Task,
  view: PlanView,
  previousPersonId?: string,
): AssignmentDecision | undefined {
  const state = view.tasks.find((t) => t.taskId === task.id);
  const to = state?.status === "resolved" ? state.assignedPersonId : undefined;
  if (!to) return undefined;

  const disrupted = disruptedPersonIds(view);
  const name = (id: string) => nameOf(household, "person", id);
  const candidates = classifyCandidates(household, task, view, to);
  const eligible = candidates.filter(
    (c) => c.verdict === "selected" || c.verdict === "eligible_not_selected",
  );
  const consistent = eligible.some((c) => c.personId === to);

  // An explicit assignment in the model is preserved unless its person was
  // disrupted, in which case the planner clears it and chooses again.
  if (
    task.assignedPersonId !== undefined &&
    task.assignedPersonId === to &&
    !disrupted.has(task.assignedPersonId)
  ) {
    return {
      kind: "explicit",
      to,
      candidates,
      eligibleCount: eligible.length,
      consistent,
      summary: `${name(to)} was assigned to this task in the household model, and the planner keeps explicit assignments.`,
    };
  }

  const eligibleNames = listNames(
    household,
    eligible.map((c) => c.personId),
  );
  const skills = task.requiredSkills;
  const skillText = skills.length > 0 ? ` with the required skill${skills.length > 1 ? "s" : ""} (${skills.join(", ")})` : "";

  let why: string;
  if (!consistent) {
    why = `The plan assigns ${name(to)}, but the household data does not show them as eligible, so the data may be out of sync.`;
  } else if (eligible.length === 1) {
    why = `${name(to)} is the only available person${skillText}.`;
  } else {
    why = `${name(to)} was chosen from ${eligible.length} eligible people (${eligibleNames}). ${TIE_BREAK_RULE}`;
  }

  if (previousPersonId !== undefined && previousPersonId !== to) {
    const prev = candidates.find((c) => c.personId === previousPersonId);
    const cause =
      prev?.verdict === "disrupted"
        ? `${name(previousPersonId)} is unavailable in this scenario.`
        : prev?.verdict === "unavailable_in_model"
          ? `${name(previousPersonId)} is marked unavailable in the household model.`
          : prev?.verdict === "missing_skills"
            ? `${name(previousPersonId)} lacks: ${prev.missingSkills.join(", ")}.`
            : prev
              ? `${name(previousPersonId)} is still eligible, but assignments are recomputed after every change and balanced by assigned time, so this task moved.`
              : `${name(previousPersonId)} is not in the household model.`;
    return {
      kind: "reassigned",
      from: previousPersonId,
      to,
      candidates,
      eligibleCount: eligible.length,
      ...(eligible.length > 1 ? { tieBreak: TIE_BREAK_RULE } : {}),
      consistent,
      summary: `Reassigned from ${name(previousPersonId)} to ${name(to)}. ${cause} ${why}`,
    };
  }

  if (previousPersonId === to) {
    return {
      kind: "kept",
      from: previousPersonId,
      to,
      candidates,
      eligibleCount: eligible.length,
      ...(eligible.length > 1 ? { tieBreak: TIE_BREAK_RULE } : {}),
      consistent,
      summary: `Stays with ${name(to)}. ${why}`,
    };
  }

  return {
    kind: "assigned",
    to,
    candidates,
    eligibleCount: eligible.length,
    ...(eligible.length > 1 ? { tieBreak: TIE_BREAK_RULE } : {}),
    consistent,
    summary: why,
  };
}

// ----------------------------------------------------------- task impact ---

/** Why a task counts as affected, from the same data the map uses. */
export function impactReasons(
  household: Household,
  task: Task,
  view: PlanView,
  reference: Reference | undefined,
  affectedTaskIds: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  const disruptedP = disruptedPersonIds(view);
  const state = view.tasks.find((t) => t.taskId === task.id);

  const previous = new Set<string>();
  if (state?.baselineAssignedPersonId) previous.add(state.baselineAssignedPersonId);
  const refAssignee = reference?.view.tasks.find((t) => t.taskId === task.id)?.assignedPersonId;
  if (refAssignee) previous.add(refAssignee);
  for (const id of previous) {
    if (disruptedP.has(id)) {
      reasons.push(`Was assigned to ${nameOf(household, "person", id)}, who is unavailable.`);
    }
  }

  for (const need of task.resourceNeeds) {
    if (disruptedResourceIds(view).has(need.resourceId)) {
      reasons.push(`Needs ${nameOf(household, "resource", need.resourceId)}, which is unavailable.`);
    }
  }

  if (task.locationId !== undefined && disruptedLocationIds(view).has(task.locationId)) {
    reasons.push(`Takes place at ${nameOf(household, "location", task.locationId)}, which is inaccessible.`);
  }

  for (const depId of task.dependsOnTaskIds) {
    if (affectedTaskIds.has(depId)) {
      reasons.push(`Depends on ${depId} ${nameOf(household, "task", depId)}, which is affected.`);
    }
  }
  return reasons;
}

// ----------------------------------------------------------------- trace ---

export interface TaskDecision {
  taskId: string;
  title: string;
  required: boolean;
  status: TaskState["status"];
  reasonCode?: string;
  headline: string;
  impact: string[];
  assignment?: AssignmentDecision;
  /** Why no person qualified; only for assignment-related failures. */
  alternatives?: Candidate[];
  constraints: ConstraintCheck[];
  /** Engine's explanation, for tasks that were not resolved. */
  engineExplanation?: string;
  /** What would have to change; for tasks that were not resolved. */
  nextStep?: string;
}

export interface TraceDisruption {
  description: string;
  /** True when this disruption is new compared with the reference. */
  added: boolean;
}

export interface TraceValidation {
  state: "passed" | "failed" | "not_reported";
  scheduledCount: number;
  taskCount: number;
  messages: string[];
}

export interface DecisionTrace {
  hasDisruptions: boolean;
  disruptions: TraceDisruption[];
  impacted: { taskId: string; title: string; reasons: string[] }[];
  decisions: TaskDecision[];
  validation: TraceValidation;
  risks: {
    required: { taskId: string; title: string; reasonCode?: string }[];
    optional: { taskId: string; title: string; reasonCode?: string }[];
  };
}

const ASSIGNMENT_CODES = new Set([
  "PERSON_UNAVAILABLE",
  "REQUIRED_SKILL_MISSING",
  "NO_FEASIBLE_ASSIGNMENT",
]);

function previousAssignee(
  task: Task,
  state: TaskState | undefined,
  reference: Reference | undefined,
): string | undefined {
  const fromRef = reference?.view.tasks.find((t) => t.taskId === task.id);
  if (fromRef) {
    return fromRef.status === "resolved" ? fromRef.assignedPersonId : undefined;
  }
  return state?.baselineAssignedPersonId;
}

export function buildDecisionTrace(
  household: Household,
  current: PlanView,
  reference: Reference | undefined,
  affectedTaskIds: readonly string[],
): DecisionTrace {
  const affected = new Set(affectedTaskIds);
  const taskById = new Map(household.tasks.map((t) => [t.id, t]));
  const stateById = new Map(current.tasks.map((t) => [t.taskId, t]));
  const title = (id: string) => taskById.get(id)?.title ?? id;

  // 1. Disruptions
  const before = reference?.view.disruptions ?? [];
  const same = (a: PlanView["disruptions"][number], b: PlanView["disruptions"][number]) =>
    a.type === b.type &&
    a.personId === b.personId &&
    a.resourceId === b.resourceId &&
    a.locationId === b.locationId;
  const disruptions: TraceDisruption[] = current.disruptions.map((d) => ({
    description: describeDisruption(d, household),
    added: reference ? !before.some((x) => same(x, d)) : false,
  }));

  // 2. Impact
  const impacted = household.tasks
    .filter((t) => affected.has(t.id))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      reasons: impactReasons(household, t, current, reference, affected),
    }));

  // 3. Decisions: every task that was affected, changed, or not resolved.
  const decisions: TaskDecision[] = [];
  for (const task of household.tasks) {
    const state = stateById.get(task.id);
    if (!state) continue;
    const prev = previousAssignee(task, state, reference);
    const movedOrLost =
      state.status !== "resolved" ||
      (prev !== undefined && prev !== state.assignedPersonId);
    if (!affected.has(task.id) && !movedOrLost) continue;

    const base = {
      taskId: task.id,
      title: task.title,
      required: state.required,
      status: state.status,
      ...(state.reasonCode ? { reasonCode: state.reasonCode } : {}),
      impact: impactReasons(household, task, current, reference, affected),
      constraints: checkConstraints(household, task, current),
    };

    if (state.status === "resolved") {
      const assignment = explainAssignment(household, task, current, prev);
      const name = (id: string | undefined) => (id ? nameOf(household, "person", id) : "nobody");
      decisions.push({
        ...base,
        headline:
          assignment?.kind === "reassigned"
            ? `Reassigned from ${name(assignment.from)} to ${name(assignment.to)}`
            : `Kept: assigned to ${name(state.assignedPersonId)}`,
        ...(assignment ? { assignment } : {}),
      });
    } else {
      decisions.push({
        ...base,
        headline: `Could not be recovered: ${reasonTitle(state.reasonCode) || state.status}`,
        ...(state.reasonCode && ASSIGNMENT_CODES.has(state.reasonCode)
          ? { alternatives: classifyCandidates(household, task, current) }
          : {}),
        engineExplanation: state.explanation,
        nextStep: recoveryCondition(state, household),
      });
    }
  }

  // 4. Validation (of the schedule the planner produced)
  const v = current.validation;
  const validation: TraceValidation = !v
    ? { state: "not_reported", scheduledCount: 0, taskCount: household.tasks.length, messages: [] }
    : {
        state: v.valid && v.schedulingErrors.length === 0 ? "passed" : "failed",
        scheduledCount: v.scheduledTaskIds.length,
        taskCount: household.tasks.length,
        messages: [...v.schedulingErrors, ...v.violations.map((x) => x.message)],
      };

  // 5. Remaining risks
  const open = current.tasks.filter((t) => t.status !== "resolved");
  const risk = (t: TaskState) => ({
    taskId: t.taskId,
    title: title(t.taskId),
    ...(t.reasonCode ? { reasonCode: t.reasonCode } : {}),
  });

  return {
    hasDisruptions: current.disruptions.length > 0,
    disruptions,
    impacted,
    decisions,
    validation,
    risks: {
      required: open.filter((t) => t.required).map(risk),
      optional: open.filter((t) => !t.required).map(risk),
    },
  };
}

// -------------------------------------------------------------- insights ---

export interface WorkloadEntry {
  personId: string;
  name: string;
  /** Minutes of tasks resolved to this person, where durations are known. */
  minutes: number;
  taskIds: string[];
  /** Share of all scheduled minutes, 0..1. */
  share: number;
  available: boolean;
}

export interface SkillExposure {
  skill: string;
  taskIds: string[];
  /** Available people holding the skill. */
  holderIds: string[];
}

export interface ResourcePressure {
  resourceId: string;
  name: string;
  /** Supply in this scenario: 0 when the resource is disrupted. */
  supply: number;
  unit: string;
  disrupted: boolean;
  taskIds: string[];
  /** Tasks needing it that are not resolved. */
  blockedTaskIds: string[];
}

export interface Insights {
  recoveryStatus?: PlanView["recoveryStatus"];
  requiredResolved: number;
  requiredTotal: number;
  optionalResolved: number;
  optionalTotal: number;
  affectedCount: number;
  taskCount: number;
  openRiskCount: number;
  workload: WorkloadEntry[];
  /** Skills needed by tasks that exactly one available person holds. */
  singleHolderSkills: SkillExposure[];
  /** Skills needed by tasks that no available person holds. */
  uncoveredSkills: SkillExposure[];
  /** Resources that are disrupted, short, or blocking tasks. */
  resourcePressure: ResourcePressure[];
}

export function computeInsights(
  household: Household,
  current: PlanView,
  affectedTaskIds: readonly string[],
): Insights {
  const stateById = new Map(current.tasks.map((t) => [t.taskId, t]));
  const disruptedP = disruptedPersonIds(current);
  const disruptedR = disruptedResourceIds(current);

  // Counts come from the engine's summary when present; otherwise from outcomes.
  const required = current.tasks.filter((t) => t.required);
  const optional = current.tasks.filter((t) => !t.required);
  const resolvedCount = (list: TaskState[]) => list.filter((t) => t.status === "resolved").length;
  const s = current.summary;

  const isAvailable = (p: Person) => p.available && !disruptedP.has(p.id);

  // Workload: only resolved tasks whose duration the backend reported.
  const minutesByPerson = new Map<string, { minutes: number; taskIds: string[] }>();
  for (const task of household.tasks) {
    const state = stateById.get(task.id);
    if (state?.status !== "resolved" || !state.assignedPersonId) continue;
    if (task.estimatedMinutes === undefined) continue;
    const entry = minutesByPerson.get(state.assignedPersonId) ?? { minutes: 0, taskIds: [] };
    entry.minutes += task.estimatedMinutes;
    entry.taskIds.push(task.id);
    minutesByPerson.set(state.assignedPersonId, entry);
  }
  const totalMinutes = [...minutesByPerson.values()].reduce((n, e) => n + e.minutes, 0);
  const workload: WorkloadEntry[] = household.people
    .filter((p) => minutesByPerson.has(p.id))
    .map((p) => {
      const entry = minutesByPerson.get(p.id)!;
      return {
        personId: p.id,
        name: p.name,
        minutes: entry.minutes,
        taskIds: entry.taskIds,
        share: totalMinutes > 0 ? entry.minutes / totalMinutes : 0,
        available: isAvailable(p),
      };
    });

  // Skills: grouped by normalised name, reported with the household's wording.
  const needed = new Map<string, { skill: string; taskIds: string[] }>();
  for (const task of household.tasks) {
    for (const skill of task.requiredSkills) {
      const key = normalizeSkill(skill);
      const entry = needed.get(key) ?? { skill, taskIds: [] };
      if (!entry.taskIds.includes(task.id)) entry.taskIds.push(task.id);
      needed.set(key, entry);
    }
  }
  const singleHolderSkills: SkillExposure[] = [];
  const uncoveredSkills: SkillExposure[] = [];
  for (const [key, entry] of needed) {
    const holderIds = household.people
      .filter((p) => isAvailable(p) && p.skills.some((x) => normalizeSkill(x) === key))
      .map((p) => p.id);
    const exposure = { skill: entry.skill, taskIds: entry.taskIds, holderIds };
    if (holderIds.length === 1) singleHolderSkills.push(exposure);
    else if (holderIds.length === 0) uncoveredSkills.push(exposure);
  }

  // Resources some task needs, reported only when they are a real pressure.
  const resourcePressure: ResourcePressure[] = [];
  for (const resource of household.resources) {
    const users = household.tasks.filter((t) =>
      t.resourceNeeds.some((n) => n.resourceId === resource.id),
    );
    if (users.length === 0) continue;
    const disrupted = disruptedR.has(resource.id);
    const supply = disrupted ? 0 : resource.quantity;
    const blockedTaskIds = users
      .filter((t) => stateById.get(t.id)?.status !== "resolved")
      .map((t) => t.id);
    const short = users.some((t) =>
      t.resourceNeeds.some((n) => n.resourceId === resource.id && n.quantity > supply),
    );
    if (disrupted || short || blockedTaskIds.length > 0) {
      resourcePressure.push({
        resourceId: resource.id,
        name: resource.name,
        supply,
        unit: resource.unit,
        disrupted,
        taskIds: users.map((t) => t.id),
        blockedTaskIds,
      });
    }
  }

  return {
    ...(current.recoveryStatus ? { recoveryStatus: current.recoveryStatus } : {}),
    requiredResolved: s ? s.requiredResolved : resolvedCount(required),
    requiredTotal: s ? s.requiredTotal : required.length,
    optionalResolved: s ? s.optionalResolved : resolvedCount(optional),
    optionalTotal: s ? s.optionalTotal : optional.length,
    affectedCount: affectedTaskIds.length,
    taskCount: household.tasks.length,
    openRiskCount: current.tasks.filter((t) => t.status !== "resolved").length,
    workload,
    singleHolderSkills,
    uncoveredSkills,
    resourcePressure,
  };
}

// -------------------------------------------------------------- compare ---

export interface ChangeCounts {
  /** Tasks that were not resolved in the reference and are now. */
  recovered: number;
  /** Tasks resolved in both plans but now done by someone else. */
  reassigned: number;
  /** Tasks that were resolved in the reference and are not now. */
  newlyFailed: number;
  /** Tasks that are not resolved now, whatever the reference said. */
  stillUnresolved: number;
}

export function countChanges(changes: readonly TaskChange[], current: PlanView): ChangeCounts {
  return {
    recovered: changes.filter((c) => c.kind === "recovered").length,
    reassigned: changes.filter((c) => c.kind === "reassigned").length,
    newlyFailed: changes.filter(
      (c) => c.kind === "newly_blocked" || c.kind === "newly_unresolved",
    ).length,
    stillUnresolved: current.tasks.filter((t) => t.status !== "resolved").length,
  };
}

export interface IncompleteReason {
  code: string;
  title: string;
  taskIds: string[];
}

/**
 * Why a recovery is incomplete: the distinct engine reason codes among the
 * required tasks that are still not resolved, with the tasks behind each.
 */
export function incompleteReasons(current: PlanView): IncompleteReason[] {
  const groups = new Map<string, IncompleteReason>();
  for (const t of current.tasks) {
    if (t.required && t.status !== "resolved") {
      const code = t.reasonCode ?? "UNSPECIFIED";
      const group = groups.get(code) ?? {
        code,
        title: t.reasonCode ? reasonTitle(t.reasonCode) : "Reason not reported",
        taskIds: [],
      };
      group.taskIds.push(t.taskId);
      groups.set(code, group);
    }
  }
  return [...groups.values()];
}
