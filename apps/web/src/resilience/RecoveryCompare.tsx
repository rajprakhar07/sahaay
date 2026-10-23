import { useMemo } from "react";
import { countChanges, incompleteReasons } from "./decisions";
import { Icon, type IconKind } from "./icons";
import {
  STATUS_DEFINITION,
  STATUS_TEXT,
  buildMapModel,
  describeDisruption,
  nameOf,
  reasonTitle,
  recoveryCondition,
  summarizeIncident,
  type ChangeKind,
  type Household,
  type OutcomeStatus,
  type PlanView,
  type RecoveryStatus,
  type Reference,
} from "./model";

const STATUS_ICON: Record<RecoveryStatus, IconKind> = {
  fully_recovered: "check",
  partially_recovered: "half",
  recovery_failed: "cross",
};

export function RecoveryStatusBadge({ status }: { status: RecoveryStatus | undefined }) {
  if (!status) {
    return <span className="rc-status rc-status--none">NOT REPORTED</span>;
  }
  return (
    <span className={`rc-status rc-status--${status}`}>
      <Icon kind={STATUS_ICON[status]} size={14} />
      {STATUS_TEXT[status]}
    </span>
  );
}

function OutcomeBadge({ status }: { status: OutcomeStatus | undefined }) {
  if (!status) return <span className="rm-badge">NO RESULT</span>;
  const icon: IconKind =
    status === "resolved" ? "check" : status === "blocked" ? "ban" : "cross";
  return (
    <span className={`rm-badge rm-badge--${status}`}>
      <Icon kind={icon} size={12} />
      {status.toUpperCase()}
    </span>
  );
}

const CHANGE_TEXT: Record<ChangeKind, string> = {
  reassigned: "REASSIGNED",
  newly_blocked: "NEWLY BLOCKED",
  newly_unresolved: "NEWLY UNRESOLVED",
  recovered: "RECOVERED",
  outcome_changed: "OUTCOME CHANGED",
  new_task: "NEW TASK",
  unchanged: "UNCHANGED",
};

export interface RecoveryCompareProps {
  household: Household;
  current: PlanView;
  reference: Reference | undefined;
}

export function RecoveryCompare({ household, current, reference }: RecoveryCompareProps) {
  const model = useMemo(
    () => buildMapModel(household, current, reference),
    [household, current, reference],
  );
  const summary = useMemo(
    () =>
      summarizeIncident(household, reference, current, model.changes, model.affectedTaskIds),
    [household, reference, current, model],
  );

  const person = (id: string | undefined) =>
    id ? nameOf(household, "person", id) : "nobody";
  const taskName = (id: string) => `${id} ${nameOf(household, "task", id)}`;
  const requiredUnresolved = summary.stillUnresolved.filter((t) => t.required);
  const optionalUnresolved = summary.stillUnresolved.filter((t) => !t.required);

  const changed = model.changes.filter((c) => c.kind !== "unchanged");
  const refView = reference?.view;
  const counts = countChanges(model.changes, current);
  const incomplete = incompleteReasons(current);

  return (
    <section className="rc" aria-labelledby="rc-title">
      <div className="rc-head">
        <div>
          <div className="eyebrow">BEFORE / AFTER</div>
          <h2 id="rc-title">What the planner did</h2>
        </div>
        <div className="rc-transition" aria-label="Recovery status before and after">
          <div>
            <small>{reference ? reference.label.toUpperCase() : "REFERENCE"}</small>
            <RecoveryStatusBadge status={refView?.recoveryStatus} />
          </div>
          <span className="rc-arrow" aria-hidden="true">→</span>
          <div>
            <small>NOW</small>
            <RecoveryStatusBadge status={current.recoveryStatus} />
          </div>
        </div>
      </div>

      {current.recoveryStatus && (
        <p className="rc-definition">{STATUS_DEFINITION[current.recoveryStatus]}</p>
      )}

      {incomplete.length > 0 && (
        <p className="rc-incomplete" data-testid="incomplete-reasons">
          <strong>Why recovery is incomplete:</strong>{" "}
          {incomplete.map((r) => `${r.title} (${r.taskIds.join(", ")})`).join(" · ")}
        </p>
      )}

      <ul className="rc-glance" aria-label="Plan changes at a glance">
        {reference && (
          <>
            <li data-count="recovered">
              <strong>{counts.recovered}</strong> recovered
            </li>
            <li data-count="reassigned">
              <strong>{counts.reassigned}</strong> reassigned
            </li>
            <li data-count="newly-failed">
              <strong>{counts.newlyFailed}</strong> newly failed
            </li>
          </>
        )}
        <li data-count="unresolved">
          <strong>{counts.stillUnresolved}</strong> unresolved now
        </li>
      </ul>

      <p className="muted rc-source">
        {!reference
          ? "No reference plan is available to compare against."
          : reference.kind === "snapshot"
            ? `Compared with the plan captured at ${new Date(reference.capturedAt ?? "").toLocaleTimeString()}, immediately before ${reference.trigger ?? "the last disruption"} was injected.`
            : "Compared with the baseline plan (no disruptions). The planner reports the baseline's assignments but not its recovery status."}
      </p>

      <div className="rc-cards">
        <article className="rc-card">
          <h3>What happened</h3>
          <ul>
            {summary.addedDisruptions.map((d, i) => (
              <li key={`a${i}`}>{describeDisruption(d, household)}.</li>
            ))}
            {summary.removedDisruptions.map((d, i) => (
              <li key={`r${i}`}>Cleared: {describeDisruption(d, household)}.</li>
            ))}
            {summary.addedDisruptions.length === 0 &&
              summary.removedDisruptions.length === 0 && (
                <li>No disruption was added or cleared compared with the reference.</li>
              )}
            <li>
              {summary.affectedTaskIds.length > 0
                ? `Tasks connected to a disruption: ${summary.affectedTaskIds.map(taskName).join(", ")}.`
                : "No task is connected to an active disruption."}
            </li>
          </ul>
        </article>

        <article className="rc-card">
          <h3>What Sahaay changed</h3>
          <ul>
            {summary.reassigned.map((r) => (
              <li key={r.taskId}>
                <strong>{taskName(r.taskId)}</strong>: reassigned from {person(r.from)} to{" "}
                {person(r.to)}.
              </li>
            ))}
            {summary.newlyFailed.map((c) => (
              <li key={c.taskId}>
                <strong>{taskName(c.taskId)}</strong>: was resolved, now{" "}
                {c.after?.status ?? "unresolved"}
                {c.after?.reasonCode ? ` (${reasonTitle(c.after.reasonCode)})` : ""}.
              </li>
            ))}
            {summary.recovered.map((c) => (
              <li key={c.taskId}>
                <strong>{taskName(c.taskId)}</strong>: now resolved
                {c.after?.assignedPersonId ? `, assigned to ${person(c.after.assignedPersonId)}` : ""}.
              </li>
            ))}
            {model.changes
              .filter((c) => c.kind === "outcome_changed" || c.kind === "new_task")
              .map((c) => (
                <li key={c.taskId}>
                  <strong>{taskName(c.taskId)}</strong>:{" "}
                  {c.kind === "new_task" ? "not in the reference plan" : `outcome changed to ${c.after?.status}`}
                  {c.after?.reasonCode ? ` (${reasonTitle(c.after.reasonCode)})` : ""}.
                </li>
              ))}
            {changed.length === 0 && <li>No task assignment or outcome changed.</li>}
          </ul>
        </article>

        <article className="rc-card rc-card--human">
          <h3>What still needs human intervention</h3>
          {requiredUnresolved.length === 0 && optionalUnresolved.length === 0 && (
            <p>Nothing: every task is resolved.</p>
          )}
          {requiredUnresolved.length === 0 && optionalUnresolved.length > 0 && (
            <p>No required task is unresolved.</p>
          )}
          <ul>
            {requiredUnresolved.map((t) => (
              <li key={t.taskId}>
                <strong>{taskName(t.taskId)}</strong>
                {t.reasonCode ? ` — ${reasonTitle(t.reasonCode)}` : ""}.
                <span className="rc-explain">{t.explanation}</span>
                <span className="rc-fix">To make it feasible: {recoveryCondition(t, household)}</span>
              </li>
            ))}
          </ul>
          {optionalUnresolved.length > 0 && (
            <>
              <h4>Optional tasks (not required for recovery)</h4>
              <ul>
                {optionalUnresolved.map((t) => (
                  <li key={t.taskId}>
                    <strong>{taskName(t.taskId)}</strong>
                    {t.reasonCode ? ` — ${reasonTitle(t.reasonCode)}` : ""}.
                    <span className="rc-explain">{t.explanation}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      </div>

      <div className="rc-table-wrap">
        <table className="rc-table">
          <caption className="rc-caption">
            Task-by-task comparison
            {reference ? ` against ${reference.label.toLowerCase()}` : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Priority</th>
              <th scope="col">Previous assignment</th>
              <th scope="col">Current assignment</th>
              <th scope="col">Outcome</th>
              <th scope="col">Planner explanation</th>
            </tr>
          </thead>
          <tbody>
            {household.tasks.map((task) => {
              const change = model.changes.find((c) => c.taskId === task.id);
              const now = current.tasks.find((t) => t.taskId === task.id);
              const was = change?.before;
              const kind = change?.kind ?? "unchanged";
              return (
                <tr key={task.id} data-change={kind} className={kind !== "unchanged" ? "rc-row--changed" : ""}>
                  <th scope="row">
                    <code>{task.id}</code> {task.title}
                    {!task.required && <small> · optional</small>}
                    {kind !== "unchanged" && (
                      <span className={`rc-change rc-change--${kind}`}>{CHANGE_TEXT[kind]}</span>
                    )}
                  </th>
                  <td>{task.priority}</td>
                  <td>
                    {!reference
                      ? "—"
                      : was?.status === "resolved"
                        ? person(was.assignedPersonId)
                        : was
                          ? `Not resolved (${was.status})`
                          : "Not in reference"}
                  </td>
                  <td>
                    {now?.status === "resolved" ? person(now.assignedPersonId) : "Not assigned"}
                  </td>
                  <td>
                    <OutcomeBadge status={now?.status} />
                    {now?.reasonCode && <code className="rc-code">{now.reasonCode}</code>}
                  </td>
                  <td className="rc-why">{now?.explanation || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
