# Explainable recovery: statuses, outcomes and reason codes

`recoverPlan` (packages/engine) now returns, in addition to its existing fields:

- `recoveryStatus`: `fully_recovered | partially_recovered | recovery_failed`
- `taskOutcomes`: one `TaskOutcome` per household task, in household order
- `summary`: required vs optional counts, with unresolved task IDs listed separately

Everything is derived deterministically and locally from the engine's own data.
No UI state, colour, or free-text parsing is involved.

## Task outcomes

| `status`     | Meaning |
|--------------|---------|
| `resolved`   | Assigned **and** present in a valid schedule. |
| `blocked`    | Something specific stands in the way: an inaccessible location, an unavailable or insufficient resource, or an unresolved prerequisite. |
| `unresolved` | Could not be assigned or scheduled for a reason about people, skills, or the schedule itself. |

`reasonCode` is present if and only if `status` is not `resolved`.
`blockedBy` lists `{ kind: person | resource | location | task | skill, id }`.

## Reason codes

| Code | Emitted when |
|------|--------------|
| `PERSON_UNAVAILABLE` | People able to do the task exist, but none are available (or the explicit assignee is unavailable). `blockedBy` names them. |
| `REQUIRED_SKILL_MISSING` | No single person has every required skill (or the explicit assignee lacks one). `blockedBy` lists skills nobody holds. |
| `RESOURCE_UNAVAILABLE` | A needed resource was disrupted (`resource_unavailable`). |
| `RESOURCE_INSUFFICIENT` | Needed quantity exceeds capacity (reusable) or combined demand exceeds stock (consumable), without a disruption. |
| `LOCATION_INACCESSIBLE` | The task's location was disrupted (`location_inaccessible`). |
| `DEPENDENCY_BLOCKED` | A prerequisite is not resolved, does not exist, or has an ambiguous (duplicate) ID. |
| `DEPENDENCY_CYCLE` | The task is part of a dependency cycle. |
| `NO_FEASIBLE_ASSIGNMENT` | Assignment failed and no more specific cause applies (e.g. nobody to assign). |
| `AMBIGUOUS_INPUT` | Duplicate task or person IDs make assignment ambiguous. |
| `SCHEDULING_FAILED` | The plan-level schedule failed and this task is **collateral** (see Limitations). |
| `UNDIAGNOSED` | Not scheduled, but the engine reports no cause. Defensive; never produced by the 128-combination invariant test. |

When several causes apply, the first in this order is used as `reasonCode`:
duplicate ID, disruption (location, then resource), assignment failure,
direct scheduling cause (cycle, then resource shortfall), prerequisite,
collateral scheduling failure. For location and resource disruptions,
`blockedBy` lists every applicable blocker.

## Recovery status

| Status | Definition |
|--------|------------|
| `fully_recovered` | Every **required** task is `resolved`, and at least one task is resolved. Unresolved optional tasks do not prevent this; they are reported in `summary.optionalUnresolvedTaskIds`. |
| `partially_recovered` | At least one required task is resolved and at least one required task is not. |
| `recovery_failed` | No required task is resolved. Scheduled optional tasks do not change this. A household with no tasks is also `recovery_failed`. |

A required task that is not resolved can never produce `fully_recovered`
(enforced by an invariant test over every combination of seven disruptions).

## Backward compatibility

| Field | Status | Notes |
|-------|--------|-------|
| `complete` | unchanged | True only if **every** original task, optional ones included, is scheduled with no risks. Stricter than `fully_recovered`. |
| `recovered` | unchanged | Equal to `recoveryStatus === "fully_recovered"` (tested). |
| `unresolvedRisks` | unchanged | Same `{ taskId, reason }` shape and strings. Note that on a plan-level scheduling failure every task is listed, as before. |
| MCP/API `status` | **changed value** | Now the engine's `recoveryStatus`. The previous value is still sent as `legacyStatus` (`complete | partial | failed`). |

Semantic differences in the old `legacyStatus`: `"partial"` meant "all required
tasks done, an optional one is not" (now `fully_recovered`), and any unresolved
required task was `"failed"` (now `partially_recovered` if other required work
is still scheduled).

## Limitations

- The scheduler is all-or-nothing: any violated constraint (cycle, resource
  over-demand) yields an empty schedule. Outcomes name the tasks that directly
  cause the failure and mark the rest `SCHEDULING_FAILED`; the engine does not
  yet isolate the failure or choose which tasks to drop.
- For consumables with combined over-demand, every consuming task is reported
  `RESOURCE_INSUFFICIENT`; no allocation priority is applied.
- Assignment balances assigned minutes and does not model per-person
  capacity beyond non-overlapping scheduled time.
- Outcome diagnosis mirrors the scheduler's resource rules in `outcomes.ts`
  (`findResourceShortfalls`). If those rules change, update both.

## Stage 3: decision trace and insights (web UI)

The Chaos Lab shows a **decision trace** (disruption, affected tasks, recovery
action, validation, remaining risks) above the before/after comparison, plus a
few **resilience insights**. Nothing here changes the engine, API or MCP
contracts: it is derived in `apps/web/src/resilience/decisions.ts` from the
household model and the fields already returned by `get_current_plan`
(`taskOutcomes`, `summary`, and `currentPlan.validation`).

- **Why this person.** Every person is classified for a task using the planner's
  own criteria: disrupted, unavailable in the household model, missing a
  required skill, or eligible. If several people were eligible, the planner's
  documented tie-break (least assigned time, then ID) is quoted. The UI does
  not state workload figures at the moment of choice, because the engine does
  not report them.
- **Alternatives** are listed only for assignment failures
  (`PERSON_UNAVAILABLE`, `REQUIRED_SKILL_MISSING`, `NO_FEASIBLE_ASSIGNMENT`).
  Tasks blocked by a resource, location or prerequisite are excluded before
  assignment, so no person alternatives are shown for them.
- **Validation** reports the independent validator's result for the tasks that
  were scheduled. A pass does not mean unscheduled tasks are handled, and the
  UI says so.
- **Insights**: required/optional tasks recovered and tasks affected (from the
  engine summary), workload (minutes of resolved tasks, only when durations are
  present), skills held by exactly one available person or by nobody, and
  resources that are disrupted, short, or blocking tasks. No score or threshold
  is invented.
- `decisions.test.ts` checks these derivations against the real engine for
  every combination of disruptions in two households.
