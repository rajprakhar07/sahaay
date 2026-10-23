/**
 * Household Resilience Map: pure model layer.
 *
 * Everything here is derived from real backend data (the household model and
 * the planner's task outcomes). Nothing is simulated or hardcoded: if a
 * relationship or outcome is not present in the data, it does not appear.
 */

// ---------------------------------------------------------------- types ---

export type DisruptionType =
  | "person_unavailable"
  | "resource_unavailable"
  | "location_inaccessible";

export interface Disruption {
  type: DisruptionType;
  personId?: string;
  resourceId?: string;
  locationId?: string;
}

export interface Person {
  id: string;
  name: string;
  skills: string[];
  available: boolean;
}
export interface Resource {
  id: string;
  name: string;
  kind: string;
  quantity: number;
  unit: string;
}
export interface Location {
  id: string;
  name: string;
}
export interface Task {
  id: string;
  title: string;
  priority: string;
  required: boolean;
  requiredSkills: string[];
  resourceNeeds: { resourceId: string; quantity: number }[];
  locationId?: string;
  dependsOnTaskIds: string[];
}
export interface Household {
  people: Person[];
  resources: Resource[];
  locations: Location[];
  tasks: Task[];
}

export type OutcomeStatus = "resolved" | "blocked" | "unresolved";
export type RecoveryStatus =
  | "fully_recovered"
  | "partially_recovered"
  | "recovery_failed";

export interface Blocker {
  kind: "person" | "resource" | "location" | "task" | "skill";
  id: string;
}

export interface TaskState {
  taskId: string;
  required: boolean;
  status: OutcomeStatus;
  /** Stable engine code. Absent for resolved tasks and for legacy data. */
  reasonCode?: string;
  explanation: string;
  blockedBy: Blocker[];
  assignedPersonId?: string;
  /** Assignee in the engine's no-disruption plan, when reported. */
  baselineAssignedPersonId?: string;
}

export interface PlanSummary {
  requiredTotal: number;
  requiredResolved: number;
  requiredUnresolved: number;
  optionalTotal: number;
  optionalResolved: number;
  optionalUnresolved: number;
  requiredUnresolvedTaskIds: string[];
  optionalUnresolvedTaskIds: string[];
}

export interface PlanView {
  disruptions: Disruption[];
  recoveryStatus?: RecoveryStatus;
  summary?: PlanSummary;
  tasks: TaskState[];
  /** `outcomes`: engine taskOutcomes. `legacy`: derived from plan fields. */
  source: "outcomes" | "legacy";
}

export type ReferenceKind = "snapshot" | "baseline";

export interface Reference {
  kind: ReferenceKind;
  label: string;
  /** ISO timestamp, snapshots only. */
  capturedAt?: string;
  /** What was injected right after this snapshot, snapshots only. */
  trigger?: string;
  view: PlanView;
}

// -------------------------------------------------------------- parsing ---

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asStringArray(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}

const DISRUPTION_TYPES: DisruptionType[] = [
  "person_unavailable",
  "resource_unavailable",
  "location_inaccessible",
];

export function parseHousehold(raw: unknown): Household | null {
  const r = asRecord(raw);
  if (!r) return null;

  const people: Person[] = [];
  for (const item of asArray(r.people)) {
    const p = asRecord(item);
    if (p && typeof p.id === "string") {
      people.push({
        id: p.id,
        name: asString(p.name, p.id),
        skills: asStringArray(p.skills),
        available: p.available !== false,
      });
    }
  }

  const resources: Resource[] = [];
  for (const item of asArray(r.resources)) {
    const x = asRecord(item);
    if (x && typeof x.id === "string") {
      resources.push({
        id: x.id,
        name: asString(x.name, x.id),
        kind: asString(x.kind, "reusable"),
        quantity: asNumber(x.quantity),
        unit: asString(x.unit),
      });
    }
  }

  const locations: Location[] = [];
  for (const item of asArray(r.locations)) {
    const l = asRecord(item);
    if (l && typeof l.id === "string") {
      locations.push({ id: l.id, name: asString(l.name, l.id) });
    }
  }

  const tasks: Task[] = [];
  for (const item of asArray(r.tasks)) {
    const t = asRecord(item);
    if (t && typeof t.id === "string") {
      tasks.push({
        id: t.id,
        title: asString(t.title, t.id),
        priority: asString(t.priority, "medium"),
        required: t.required !== false,
        requiredSkills: asStringArray(t.requiredSkills),
        resourceNeeds: asArray(t.resourceNeeds).flatMap((n) => {
          const need = asRecord(n);
          return need && typeof need.resourceId === "string"
            ? [{ resourceId: need.resourceId, quantity: asNumber(need.quantity, 1) }]
            : [];
        }),
        ...(typeof t.locationId === "string" ? { locationId: t.locationId } : {}),
        dependsOnTaskIds: asStringArray(t.dependsOnTaskIds),
      });
    }
  }

  return { people, resources, locations, tasks };
}

function parseDisruptions(raw: unknown): Disruption[] {
  const out: Disruption[] = [];
  for (const item of asArray(raw)) {
    const d = asRecord(item);
    if (d && DISRUPTION_TYPES.includes(d.type as DisruptionType)) {
      out.push({
        type: d.type as DisruptionType,
        ...(typeof d.personId === "string" ? { personId: d.personId } : {}),
        ...(typeof d.resourceId === "string" ? { resourceId: d.resourceId } : {}),
        ...(typeof d.locationId === "string" ? { locationId: d.locationId } : {}),
      });
    }
  }
  return out;
}

function parseBlockers(raw: unknown): Blocker[] {
  const kinds = ["person", "resource", "location", "task", "skill"];
  const out: Blocker[] = [];
  for (const item of asArray(raw)) {
    const b = asRecord(item);
    if (b && kinds.includes(b.kind as string) && typeof b.id === "string") {
      out.push({ kind: b.kind as Blocker["kind"], id: b.id });
    }
  }
  return out;
}

function parseSummary(raw: unknown): PlanSummary | undefined {
  const s = asRecord(raw);
  if (!s) return undefined;
  return {
    requiredTotal: asNumber(s.requiredTotal),
    requiredResolved: asNumber(s.requiredResolved),
    requiredUnresolved: asNumber(s.requiredUnresolved),
    optionalTotal: asNumber(s.optionalTotal),
    optionalResolved: asNumber(s.optionalResolved),
    optionalUnresolved: asNumber(s.optionalUnresolved),
    requiredUnresolvedTaskIds: asStringArray(s.requiredUnresolvedTaskIds),
    optionalUnresolvedTaskIds: asStringArray(s.optionalUnresolvedTaskIds),
  };
}

const RECOVERY_STATUSES: RecoveryStatus[] = [
  "fully_recovered",
  "partially_recovered",
  "recovery_failed",
];

/** Parses the response of GET /api/plan into the plan the user is in now. */
export function parsePlanView(raw: unknown): PlanView | null {
  const r = asRecord(raw);
  if (!r) return null;

  const status = RECOVERY_STATUSES.includes(r.recoveryStatus as RecoveryStatus)
    ? (r.recoveryStatus as RecoveryStatus)
    : undefined;
  const summary = parseSummary(r.summary);
  const disruptions = parseDisruptions(r.disruptions);

  const base = {
    disruptions,
    ...(status ? { recoveryStatus: status } : {}),
    ...(summary ? { summary } : {}),
  };

  if (Array.isArray(r.taskOutcomes)) {
    const tasks: TaskState[] = [];
    for (const item of r.taskOutcomes) {
      const o = asRecord(item);
      if (!o || typeof o.taskId !== "string") continue;
      const st = o.status;
      if (st !== "resolved" && st !== "blocked" && st !== "unresolved") continue;
      tasks.push({
        taskId: o.taskId,
        required: o.required !== false,
        status: st,
        ...(typeof o.reasonCode === "string" ? { reasonCode: o.reasonCode } : {}),
        explanation: asString(o.explanation),
        blockedBy: parseBlockers(o.blockedBy),
        ...(typeof o.assignedPersonId === "string"
          ? { assignedPersonId: o.assignedPersonId }
          : {}),
        ...(typeof o.baselineAssignedPersonId === "string"
          ? { baselineAssignedPersonId: o.baselineAssignedPersonId }
          : {}),
      });
    }
    return { ...base, tasks, source: "outcomes" };
  }

  // Legacy backend without taskOutcomes: derive what the plan itself states.
  const plan = asRecord(r.currentPlan ?? r.recoveryPlan);
  if (!plan) return null;
  return { ...base, tasks: tasksFromPlanResult(plan), source: "legacy" };
}

function tasksFromPlanResult(plan: Rec): TaskState[] {
  const scheduled = new Set(
    asArray(plan.schedule).flatMap((e) => {
      const entry = asRecord(e);
      return entry && typeof entry.taskId === "string" ? [entry.taskId] : [];
    }),
  );
  const hasSchedule = Array.isArray(plan.schedule);
  const tasks: TaskState[] = [];

  for (const item of asArray(plan.assignedTasks)) {
    const t = asRecord(item);
    if (!t || typeof t.id !== "string") continue;
    const ok = !hasSchedule || scheduled.has(t.id);
    tasks.push({
      taskId: t.id,
      required: t.required !== false,
      status: ok ? "resolved" : "unresolved",
      explanation: ok ? "Scheduled." : "Assigned, but not scheduled.",
      blockedBy: [],
      ...(typeof t.assignedPersonId === "string" && ok
        ? { assignedPersonId: t.assignedPersonId }
        : {}),
    });
  }
  for (const item of asArray(plan.unassignedTasks)) {
    const u = asRecord(item);
    if (u && typeof u.taskId === "string") {
      tasks.push({
        taskId: u.taskId,
        required: true,
        status: "unresolved",
        explanation: asString(u.reason, "Not assigned."),
        blockedBy: [],
      });
    }
  }
  return tasks;
}

/**
 * The backend's no-disruption plan, as a reference to compare against.
 * Only what that plan states is used: no reason codes or statuses are
 * invented for it.
 */
export function parseBaselineReference(raw: unknown): Reference | null {
  const r = asRecord(raw);
  if (!r) return null;
  const plan = asRecord(r.baselinePlan ?? r.originalPlan);
  if (!plan) return null;
  return {
    kind: "baseline",
    label: "Baseline (no disruptions)",
    view: { disruptions: [], tasks: tasksFromPlanResult(plan), source: "legacy" },
  };
}

// --------------------------------------------------------------- naming ---

export function normalizeSkill(skill: string): string {
  return skill.trim().replace(/\s+/g, " ").toLowerCase();
}

export function nameOf(
  household: Household,
  kind: Blocker["kind"],
  id: string,
): string {
  const list: { id: string; name?: string; title?: string }[] =
    kind === "person"
      ? household.people
      : kind === "resource"
        ? household.resources
        : kind === "location"
          ? household.locations
          : kind === "task"
            ? household.tasks
            : [];
  const found = list.find((item) => item.id === id);
  return found ? (found.name ?? found.title ?? id) : id;
}

export function describeDisruption(d: Disruption, household: Household): string {
  if (d.type === "person_unavailable" && d.personId !== undefined) {
    return `${nameOf(household, "person", d.personId)} is unavailable`;
  }
  if (d.type === "resource_unavailable" && d.resourceId !== undefined) {
    return `${nameOf(household, "resource", d.resourceId)} is unavailable`;
  }
  if (d.type === "location_inaccessible" && d.locationId !== undefined) {
    return `${nameOf(household, "location", d.locationId)} is inaccessible`;
  }
  return "Unknown disruption";
}

export function disruptionTargetId(d: Disruption): string | undefined {
  return d.type === "person_unavailable"
    ? d.personId
    : d.type === "resource_unavailable"
      ? d.resourceId
      : d.locationId;
}

function sameDisruption(a: Disruption, b: Disruption): boolean {
  return a.type === b.type && disruptionTargetId(a) === disruptionTargetId(b);
}

export const REASON_TITLES: Record<string, string> = {
  PERSON_UNAVAILABLE: "Person unavailable",
  REQUIRED_SKILL_MISSING: "Required skill missing",
  RESOURCE_UNAVAILABLE: "Resource unavailable",
  RESOURCE_INSUFFICIENT: "Resource insufficient",
  LOCATION_INACCESSIBLE: "Location inaccessible",
  DEPENDENCY_BLOCKED: "Prerequisite not resolved",
  DEPENDENCY_CYCLE: "Dependency cycle",
  NO_FEASIBLE_ASSIGNMENT: "No feasible assignment",
  AMBIGUOUS_INPUT: "Ambiguous input",
  SCHEDULING_FAILED: "Plan-level scheduling failed",
  UNDIAGNOSED: "Cause not diagnosed",
};

export function reasonTitle(code: string | undefined): string {
  if (!code) return "";
  return REASON_TITLES[code] ?? code.replace(/_/g, " ").toLowerCase();
}

export const STATUS_TEXT: Record<RecoveryStatus, string> = {
  fully_recovered: "FULLY RECOVERED",
  partially_recovered: "PARTIALLY RECOVERED",
  recovery_failed: "RECOVERY FAILED",
};

export const STATUS_DEFINITION: Record<RecoveryStatus, string> = {
  fully_recovered: "Every required task is resolved.",
  partially_recovered:
    "Some required work is resolved, but at least one required task is not.",
  recovery_failed: "No required task could be resolved.",
};

// --------------------------------------------------------------- guidance ---

/**
 * What would have to change for a task to become feasible. Derived only from
 * the task's reason code and the entities it names as blockers.
 */
export function recoveryCondition(
  state: TaskState,
  household: Household,
): string {
  if (state.status === "resolved") return "";
  const names = (kind: Blocker["kind"]) =>
    state.blockedBy
      .filter((b) => b.kind === kind)
      .map((b) => (kind === "skill" ? b.id : nameOf(household, kind, b.id)));
  const join = (list: string[]) => list.join(", ");

  switch (state.reasonCode) {
    case "PERSON_UNAVAILABLE": {
      const who = names("person");
      return who.length > 0
        ? `Make at least one of these people available: ${join(who)}.`
        : "Make someone with the required skills available.";
    }
    case "REQUIRED_SKILL_MISSING": {
      const skills = names("skill");
      return skills.length > 0
        ? `Add a person who has: ${join(skills)}.`
        : "Add a person who has every skill this task requires.";
    }
    case "RESOURCE_UNAVAILABLE":
      return `Restore: ${join(names("resource"))}.`;
    case "RESOURCE_INSUFFICIENT":
      return `Increase the supply of ${join(names("resource"))}, or reduce what tasks need.`;
    case "LOCATION_INACCESSIBLE": {
      const loc = names("location");
      const res = names("resource");
      return [
        loc.length > 0 ? `Restore access to ${join(loc)}.` : "",
        res.length > 0 ? `Restore ${join(res)}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "DEPENDENCY_BLOCKED":
      return `Resolve the prerequisite task(s) first: ${join(names("task"))}.`;
    case "DEPENDENCY_CYCLE":
      return `Remove the circular dependency between: ${join(names("task"))}.`;
    case "AMBIGUOUS_INPUT":
      return "Fix duplicate task or person IDs in the household model.";
    case "SCHEDULING_FAILED":
      return "Fix the plan-level scheduling problem described above, then replan.";
    default:
      return "Review this task and the household model; the planner could not place it.";
  }
}

// ---------------------------------------------------------------- changes ---

export type ChangeKind =
  | "reassigned"
  | "newly_blocked"
  | "newly_unresolved"
  | "recovered"
  | "outcome_changed"
  | "new_task"
  | "unchanged";

export interface TaskChange {
  taskId: string;
  kind: ChangeKind;
  before?: TaskState;
  after?: TaskState;
}

export function diffTasks(
  household: Household,
  before: PlanView | undefined,
  after: PlanView,
): TaskChange[] {
  const b = new Map((before?.tasks ?? []).map((t) => [t.taskId, t]));
  const a = new Map(after.tasks.map((t) => [t.taskId, t]));

  return household.tasks.map((task) => {
    const prev = b.get(task.id);
    const next = a.get(task.id);
    const change = (kind: ChangeKind): TaskChange => ({
      taskId: task.id,
      kind,
      ...(prev ? { before: prev } : {}),
      ...(next ? { after: next } : {}),
    });

    if (!before || !next) return change("unchanged");
    if (!prev) return change("new_task");

    if (prev.status === "resolved" && next.status === "resolved") {
      return change(
        prev.assignedPersonId !== next.assignedPersonId ? "reassigned" : "unchanged",
      );
    }
    if (prev.status === "resolved") {
      return change(next.status === "blocked" ? "newly_blocked" : "newly_unresolved");
    }
    if (next.status === "resolved") return change("recovered");
    return change(
      prev.status !== next.status || prev.reasonCode !== next.reasonCode
        ? "outcome_changed"
        : "unchanged",
    );
  });
}

export interface IncidentSummary {
  addedDisruptions: Disruption[];
  removedDisruptions: Disruption[];
  affectedTaskIds: string[];
  reassigned: { taskId: string; from?: string; to?: string }[];
  newlyFailed: TaskChange[];
  recovered: TaskChange[];
  stillUnresolved: TaskState[];
}

export function summarizeIncident(
  household: Household,
  reference: Reference | undefined,
  current: PlanView,
  changes: TaskChange[],
  affectedTaskIds: string[],
): IncidentSummary {
  const before = reference?.view.disruptions ?? [];
  return {
    addedDisruptions: current.disruptions.filter(
      (d) => !before.some((x) => sameDisruption(x, d)),
    ),
    removedDisruptions: before.filter(
      (d) => !current.disruptions.some((x) => sameDisruption(x, d)),
    ),
    affectedTaskIds,
    reassigned: changes
      .filter((c) => c.kind === "reassigned")
      .map((c) => ({
        taskId: c.taskId,
        ...(c.before?.assignedPersonId ? { from: c.before.assignedPersonId } : {}),
        ...(c.after?.assignedPersonId ? { to: c.after.assignedPersonId } : {}),
      })),
    newlyFailed: changes.filter(
      (c) => c.kind === "newly_blocked" || c.kind === "newly_unresolved",
    ),
    recovered: changes.filter((c) => c.kind === "recovered"),
    stillUnresolved: current.tasks.filter((t) => t.status !== "resolved"),
  };
}

// --------------------------------------------------------------- the graph ---

export type NodeKind = "person" | "task" | "resource" | "location";
export type NodeState =
  | "ok"
  | "disrupted"
  | "baseline-unavailable"
  | "resolved"
  | "blocked"
  | "unresolved"
  | "unknown";

export interface MapNode {
  key: string;
  kind: NodeKind;
  id: string;
  state: NodeState;
  /** Up to three short text lines drawn inside the node. */
  lines: [string, string, string?];
  x: number;
  y: number;
  w: number;
  h: number;
  /** A disruption touches this node directly or through a relationship. */
  affected: boolean;
  change?: ChangeKind;
}

export type EdgeKind = "assigned" | "needs" | "at" | "depends" | "eligible";
export type EdgeEmphasis = "normal" | "affected" | "new" | "ghost" | "eligible";

export interface MapEdge {
  key: string;
  kind: EdgeKind;
  from: string;
  to: string;
  emphasis: EdgeEmphasis;
  /** A ghost edge is amber when the person it came from was disrupted. */
  affected: boolean;
  d: string;
  label?: string;
  labelX: number;
  labelY: number;
  /** Plain-language description, also used for the text alternative. */
  description: string;
}

export interface MapModel {
  nodes: MapNode[];
  edges: MapEdge[];
  headers: { title: string; x: number; y: number }[];
  width: number;
  height: number;
  changes: TaskChange[];
  affectedTaskIds: string[];
}

export function nodeKey(kind: NodeKind, id: string): string {
  return `${kind}:${id}`;
}

const L = {
  person: { x: 16, w: 184, h: 56, pitch: 80 },
  task: { x: 356, w: 252, h: 72, pitch: 100 },
  right: { x: 764, w: 184, h: 56, pitch: 80 },
  top: 56,
  width: 964,
};

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function cubic(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { d: string; mx: number; my: number } {
  const dx = Math.max(48, Math.abs(x2 - x1) / 2);
  const c1x = x1 + dx;
  const c2x = x2 - dx;
  return {
    d: `M${round(x1)} ${round(y1)} C${round(c1x)} ${round(y1)}, ${round(c2x)} ${round(y2)}, ${round(x2)} ${round(y2)}`,
    mx: round((x1 + 3 * c1x + 3 * c2x + x2) / 8),
    my: round((y1 + y2) / 2),
  };
}

function loopLeft(
  x: number,
  ya: number,
  yb: number,
): { d: string; mx: number; my: number } {
  const bulge = 84;
  return {
    d: `M${round(x)} ${round(ya)} C${round(x - bulge)} ${round(ya)}, ${round(x - bulge)} ${round(yb)}, ${round(x)} ${round(yb)}`,
    mx: round(x - (6 * bulge) / 8),
    my: round((ya + yb) / 2),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** People who hold every skill a task needs (same matching as the planner). */
export function eligiblePeople(household: Household, task: Task): Person[] {
  if (task.requiredSkills.length === 0) return [];
  return household.people.filter((person) => {
    const owned = new Set(person.skills.map(normalizeSkill));
    return task.requiredSkills.every((s) => owned.has(normalizeSkill(s)));
  });
}

export interface BuildOptions {
  /** Node key of the current selection; its eligible backups are drawn. */
  selectedKey?: string | undefined;
}

export function buildMapModel(
  household: Household,
  current: PlanView,
  reference: Reference | undefined,
  options: BuildOptions = {},
): MapModel {
  const disruptedPeople = new Set(
    current.disruptions.flatMap((d) => (d.personId ? [d.personId] : [])),
  );
  const disruptedResources = new Set(
    current.disruptions.flatMap((d) => (d.resourceId ? [d.resourceId] : [])),
  );
  const disruptedLocations = new Set(
    current.disruptions.flatMap((d) => (d.locationId ? [d.locationId] : [])),
  );

  const stateByTask = new Map(current.tasks.map((t) => [t.taskId, t]));
  const changes = diffTasks(household, reference?.view, current);
  const changeByTask = new Map(changes.map((c) => [c.taskId, c]));

  // Tasks touched by a disruption: directly, or through a prerequisite.
  const direct = new Set<string>();
  for (const task of household.tasks) {
    const state = stateByTask.get(task.id);
    const baselineAssignee = state?.baselineAssignedPersonId;
    if (
      (task.locationId !== undefined && disruptedLocations.has(task.locationId)) ||
      task.resourceNeeds.some((n) => disruptedResources.has(n.resourceId)) ||
      (baselineAssignee !== undefined && disruptedPeople.has(baselineAssignee)) ||
      (reference &&
        reference.view.tasks.some(
          (t) =>
            t.taskId === task.id &&
            t.assignedPersonId !== undefined &&
            disruptedPeople.has(t.assignedPersonId),
        ))
    ) {
      direct.add(task.id);
    }
  }
  const affected = new Set(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of household.tasks) {
      if (
        !affected.has(task.id) &&
        task.dependsOnTaskIds.some((dep) => affected.has(dep))
      ) {
        affected.add(task.id);
        grew = true;
      }
    }
  }
  const affectedTaskIds = household.tasks
    .filter((t) => affected.has(t.id))
    .map((t) => t.id);

  // ---- nodes (deterministic columns, in household order) ----
  const nodes: MapNode[] = [];
  const byKey = new Map<string, MapNode>();
  const push = (node: MapNode) => {
    nodes.push(node);
    byKey.set(node.key, node);
  };

  household.people.forEach((p, i) => {
    const state: NodeState = disruptedPeople.has(p.id)
      ? "disrupted"
      : p.available
        ? "ok"
        : "baseline-unavailable";
    push({
      key: nodeKey("person", p.id),
      kind: "person",
      id: p.id,
      state,
      lines: [
        truncate(p.name, 22),
        state === "ok"
          ? "AVAILABLE"
          : state === "disrupted"
            ? "UNAVAILABLE · DISRUPTED"
            : "UNAVAILABLE · IN MODEL",
        truncate(p.skills.join(", ") || "no skills listed", 28),
      ],
      x: L.person.x,
      y: L.top + i * L.person.pitch,
      w: L.person.w,
      h: L.person.h,
      affected: disruptedPeople.has(p.id),
    });
  });

  household.tasks.forEach((t, i) => {
    const s = stateByTask.get(t.id);
    const change = changeByTask.get(t.id);
    const state: NodeState = s ? s.status : "unknown";
    const assignee = s?.assignedPersonId
      ? nameOf(household, "person", s.assignedPersonId)
      : undefined;

    const line2 =
      state === "resolved"
        ? "RESOLVED"
        : state === "blocked"
          ? "BLOCKED"
          : state === "unresolved"
            ? "UNRESOLVED"
            : "NO RESULT";
    const line3 =
      state === "resolved"
        ? `${assignee ?? "unassigned"}${change?.kind === "reassigned" ? " · reassigned" : ""}`
        : (s?.reasonCode ?? (state === "unknown" ? "not reported" : "no code reported"));

    push({
      key: nodeKey("task", t.id),
      kind: "task",
      id: t.id,
      state,
      lines: [
        truncate(`${t.id} ${t.title}`, 29),
        `${line2}${t.required ? "" : " · OPTIONAL"}`,
        truncate(line3, 32),
      ],
      x: L.task.x,
      y: L.top + i * L.task.pitch,
      w: L.task.w,
      h: L.task.h,
      affected: affected.has(t.id),
      ...(change && change.kind !== "unchanged" ? { change: change.kind } : {}),
    });
  });

  let rightY = L.top;
  const headers: MapModel["headers"] = [
    { title: "PEOPLE", x: L.person.x, y: 30 },
    { title: "TASKS", x: L.task.x, y: 30 },
  ];
  if (household.resources.length > 0) {
    headers.push({ title: "RESOURCES", x: L.right.x, y: 30 });
  }
  household.resources.forEach((r) => {
    const gone = disruptedResources.has(r.id);
    push({
      key: nodeKey("resource", r.id),
      kind: "resource",
      id: r.id,
      state: gone ? "disrupted" : "ok",
      lines: [
        truncate(r.name, 22),
        gone ? "UNAVAILABLE · DISRUPTED" : "AVAILABLE",
        truncate(`${r.quantity} ${r.unit} · ${r.kind}`.trim(), 28),
      ],
      x: L.right.x,
      y: rightY,
      w: L.right.w,
      h: L.right.h,
      affected: gone,
    });
    rightY += L.right.pitch;
  });
  if (household.locations.length > 0) {
    rightY += household.resources.length > 0 ? 36 : 0;
    headers.push({ title: "LOCATIONS", x: L.right.x, y: rightY - 26 });
    household.locations.forEach((l) => {
      const blocked = disruptedLocations.has(l.id);
      push({
        key: nodeKey("location", l.id),
        kind: "location",
        id: l.id,
        state: blocked ? "disrupted" : "ok",
        lines: [
          truncate(l.name, 22),
          blocked ? "INACCESSIBLE · DISRUPTED" : "ACCESSIBLE",
          truncate(l.id, 28),
        ],
        x: L.right.x,
        y: rightY,
        w: L.right.w,
        h: L.right.h,
        affected: blocked,
      });
      rightY += L.right.pitch;
    });
  }

  // ---- edges: only relationships that exist in the data ----
  const edges: MapEdge[] = [];
  const taskNode = (id: string) => byKey.get(nodeKey("task", id));
  const mid = (n: MapNode) => n.y + n.h / 2;

  // Fan-out offsets so several right-hand edges of one task do not overlap.
  const rightEdgesByTask = new Map<string, number>();
  for (const t of household.tasks) {
    const count =
      t.resourceNeeds.filter((n) => byKey.has(nodeKey("resource", n.resourceId))).length +
      (t.locationId !== undefined && byKey.has(nodeKey("location", t.locationId)) ? 1 : 0);
    rightEdgesByTask.set(t.id, count);
  }
  const rightIndex = new Map<string, number>();
  const nextOffset = (taskId: string): number => {
    const i = rightIndex.get(taskId) ?? 0;
    rightIndex.set(taskId, i + 1);
    const n = rightEdgesByTask.get(taskId) ?? 1;
    return (i - (n - 1) / 2) * 9;
  };

  // Assignment edges (current) and ghost edges (what the reference had).
  for (const t of household.tasks) {
    const tn = taskNode(t.id);
    if (!tn) continue;
    const now = stateByTask.get(t.id);
    const before = changeByTask.get(t.id)?.before;
    const change = changeByTask.get(t.id)?.kind;

    if (now?.status === "resolved" && now.assignedPersonId) {
      const pn = byKey.get(nodeKey("person", now.assignedPersonId));
      if (pn) {
        const c = cubic(pn.x + pn.w, mid(pn), tn.x, mid(tn));
        const isNew = change === "reassigned" || change === "recovered";
        edges.push({
          key: `assigned:${pn.id}>${t.id}`,
          kind: "assigned",
          from: pn.key,
          to: tn.key,
          emphasis: isNew ? "new" : "normal",
          affected: false,
          d: c.d,
          labelX: c.mx,
          labelY: c.my,
          description: `${pn.lines[0]} is assigned to ${t.id}${isNew ? " (new in this plan)" : ""}`,
        });
      }
    }

    if (
      before?.status === "resolved" &&
      before.assignedPersonId &&
      (now?.status !== "resolved" || now.assignedPersonId !== before.assignedPersonId)
    ) {
      const pn = byKey.get(nodeKey("person", before.assignedPersonId));
      if (pn) {
        const c = cubic(pn.x + pn.w, mid(pn), tn.x, mid(tn));
        edges.push({
          key: `was:${pn.id}>${t.id}`,
          kind: "assigned",
          from: pn.key,
          to: tn.key,
          emphasis: "ghost",
          affected: disruptedPeople.has(pn.id),
          d: c.d,
          label: "was",
          labelX: c.mx,
          labelY: c.my,
          description: `${pn.lines[0]} was assigned to ${t.id} before this change`,
        });
      }
    }
  }

  for (const t of household.tasks) {
    const tn = taskNode(t.id);
    if (!tn) continue;

    for (const need of t.resourceNeeds) {
      const rn = byKey.get(nodeKey("resource", need.resourceId));
      if (!rn) continue;
      const c = cubic(tn.x + tn.w, mid(tn) + nextOffset(t.id), rn.x, mid(rn));
      const hit = disruptedResources.has(rn.id);
      edges.push({
        key: `needs:${t.id}>${rn.id}`,
        kind: "needs",
        from: tn.key,
        to: rn.key,
        emphasis: hit ? "affected" : "normal",
        affected: hit,
        d: c.d,
        label: `×${need.quantity}`,
        labelX: c.mx,
        labelY: c.my,
        description: `${t.id} needs ${need.quantity} of ${rn.lines[0]}`,
      });
    }

    if (t.locationId !== undefined) {
      const ln = byKey.get(nodeKey("location", t.locationId));
      if (ln) {
        const c = cubic(tn.x + tn.w, mid(tn) + nextOffset(t.id), ln.x, mid(ln));
        const hit = disruptedLocations.has(ln.id);
        edges.push({
          key: `at:${t.id}>${ln.id}`,
          kind: "at",
          from: tn.key,
          to: ln.key,
          emphasis: hit ? "affected" : "normal",
          affected: hit,
          d: c.d,
          labelX: c.mx,
          labelY: c.my,
          description: `${t.id} takes place at ${ln.lines[0]}`,
        });
      }
    }

    for (const depId of t.dependsOnTaskIds) {
      const dn = taskNode(depId);
      if (!dn || dn === tn) continue;
      const c = loopLeft(tn.x, tn.y + 18, dn.y + dn.h - 18);
      const hit = affected.has(depId);
      edges.push({
        key: `depends:${t.id}>${depId}`,
        kind: "depends",
        from: tn.key,
        to: dn.key,
        emphasis: hit ? "affected" : "normal",
        affected: hit,
        d: c.d,
        labelX: c.mx,
        labelY: c.my,
        description: `${t.id} depends on ${depId}`,
      });
    }
  }

  // Eligible backups for the selected task (dashed, only when selected).
  const sel = options.selectedKey ? byKey.get(options.selectedKey) : undefined;
  if (sel?.kind === "task") {
    const task = household.tasks.find((t) => t.id === sel.id);
    if (task) {
      for (const person of eligiblePeople(household, task)) {
        const pn = byKey.get(nodeKey("person", person.id));
        if (!pn) continue;
        const c = cubic(pn.x + pn.w, mid(pn), sel.x, mid(sel));
        const up = pn.state === "ok";
        edges.push({
          key: `eligible:${person.id}>${task.id}`,
          kind: "eligible",
          from: pn.key,
          to: sel.key,
          emphasis: "eligible",
          affected: false,
          d: c.d,
          label: up ? "can do" : "can do, unavailable",
          labelX: c.mx,
          labelY: c.my,
          description: `${person.name} has the skills for ${task.id} and is ${up ? "available" : "unavailable"}`,
        });
      }
    }
  }

  const colHeight = Math.max(
    ...[
      L.top + household.people.length * L.person.pitch,
      L.top + household.tasks.length * L.task.pitch,
      rightY,
    ],
  );

  return {
    nodes,
    edges,
    headers,
    width: L.width,
    height: round(colHeight + 8),
    changes,
    affectedTaskIds,
  };
}

// --------------------------------------------------- keyboard navigation ---

export type Direction = "up" | "down" | "left" | "right";

/**
 * Next node key when moving with the arrow keys: up/down within a column,
 * left/right to the closest node in the neighbouring column.
 */
export function neighbor(
  nodes: readonly MapNode[],
  fromKey: string,
  direction: Direction,
): string | undefined {
  const from = nodes.find((n) => n.key === fromKey);
  if (!from) return nodes[0]?.key;

  if (direction === "up" || direction === "down") {
    const column = nodes
      .filter((n) => n.x === from.x)
      .sort((a, b) => a.y - b.y);
    const i = column.findIndex((n) => n.key === fromKey);
    return column[direction === "up" ? i - 1 : i + 1]?.key;
  }

  const xs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
  const next = xs[xs.indexOf(from.x) + (direction === "left" ? -1 : 1)];
  if (next === undefined) return undefined;

  return nodes
    .filter((n) => n.x === next)
    .sort(
      (a, b) =>
        Math.abs(a.y - from.y) - Math.abs(b.y - from.y) || a.y - b.y,
    )[0]?.key;
}

/** Phases of a real disruption request, surfaced by the UI. */
export type RequestPhase =
  | { state: "idle" }
  | { state: "processing"; step: string }
  | { state: "succeeded"; at: string }
  | { state: "failed"; message: string };

// ------------------------------------------------------ node descriptions ---

/** Plain-language description of a node, used for accessible labels. */
export function describeNode(
  household: Household,
  current: PlanView,
  model: MapModel,
  node: MapNode,
): string {
  const parts: string[] = [];

  if (node.kind === "person") {
    const p = household.people.find((x) => x.id === node.id);
    parts.push(`Person ${p?.name ?? node.id}`);
    parts.push(
      node.state === "ok"
        ? "available"
        : node.state === "disrupted"
          ? "unavailable, disrupted in this scenario"
          : "unavailable in the household model",
    );
    if (p && p.skills.length > 0) parts.push(`skills: ${p.skills.join(", ")}`);
    const assigned = current.tasks
      .filter((t) => t.status === "resolved" && t.assignedPersonId === node.id)
      .map((t) => t.taskId);
    if (assigned.length > 0) parts.push(`assigned to ${assigned.join(", ")}`);
  } else if (node.kind === "task") {
    const t = household.tasks.find((x) => x.id === node.id);
    const s = current.tasks.find((x) => x.taskId === node.id);
    parts.push(`Task ${node.id} ${t?.title ?? ""}`.trim());
    parts.push(t?.required === false ? "optional" : "required");
    if (!s) {
      parts.push("no planner result for this task");
    } else if (s.status === "resolved") {
      parts.push(
        `resolved${s.assignedPersonId ? `, assigned to ${nameOf(household, "person", s.assignedPersonId)}` : ""}`,
      );
    } else {
      parts.push(
        `${s.status}${s.reasonCode ? `: ${reasonTitle(s.reasonCode)}` : ""}`,
      );
    }
    const change = model.changes.find((c) => c.taskId === node.id);
    if (change?.kind === "reassigned" && change.before?.assignedPersonId) {
      parts.push(
        `reassigned from ${nameOf(household, "person", change.before.assignedPersonId)}`,
      );
    } else if (change?.kind === "newly_blocked" || change?.kind === "newly_unresolved") {
      parts.push("was resolved before this change");
    } else if (change?.kind === "recovered") {
      parts.push("was not resolved before this change");
    }
  } else if (node.kind === "resource") {
    const r = household.resources.find((x) => x.id === node.id);
    parts.push(`Resource ${r?.name ?? node.id}`);
    parts.push(node.state === "disrupted" ? "unavailable, disrupted in this scenario" : "available");
    if (r) parts.push(`${r.quantity} ${r.unit}, ${r.kind}`.trim());
  } else {
    const l = household.locations.find((x) => x.id === node.id);
    parts.push(`Location ${l?.name ?? node.id}`);
    parts.push(node.state === "disrupted" ? "inaccessible, disrupted in this scenario" : "accessible");
  }

  if (node.affected && node.kind === "task") {
    parts.push("affected by a disruption");
  }
  return `${parts.join(". ")}.`;
}
