import { useMemo } from "react";
import {
  buildDecisionTrace,
  computeInsights,
  type Candidate,
  type CandidateVerdict,
  type ConstraintCheck,
  type TaskDecision,
} from "./decisions";
import { Icon, type IconKind } from "./icons";
import { buildMapModel, nameOf, reasonTitle, type Household, type PlanView, type Reference } from "./model";

const VERDICT_TEXT: Record<CandidateVerdict, string> = {
  selected: "SELECTED",
  eligible_not_selected: "ELIGIBLE",
  disrupted: "DISRUPTED",
  unavailable_in_model: "UNAVAILABLE",
  missing_skills: "LACKS SKILL",
};

const VERDICT_ICON: Record<CandidateVerdict, IconKind> = {
  selected: "check",
  eligible_not_selected: "minus",
  disrupted: "warn",
  unavailable_in_model: "minus",
  missing_skills: "cross",
};

function Candidates({ household, list }: { household: Household; list: Candidate[] }) {
  return (
    <ul className="rd-list rd-cands">
      {list.map((c) => (
        <li key={c.personId} data-verdict={c.verdict}>
          <span className={`rd-tag rd-tag--${c.verdict}`}>
            <Icon kind={VERDICT_ICON[c.verdict]} size={12} />
            {VERDICT_TEXT[c.verdict]}
          </span>{" "}
          <strong>{nameOf(household, "person", c.personId)}</strong>
          <span className="rd-note">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function Constraints({ list }: { list: ConstraintCheck[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="rd-list rd-constraints">
      {list.map((c, i) => (
        <li key={i} data-met={c.met}>
          <Icon kind={c.met ? "check" : "cross"} size={12} />
          <span className="rd-tag">{c.met ? "MET" : "NOT MET"}</span> {c.text}
        </li>
      ))}
    </ul>
  );
}

function Decision({ household, d, open }: { household: Household; d: TaskDecision; open: boolean }) {
  const resolved = d.status === "resolved";
  return (
    <details className="rd-decision" open={open} data-status={d.status} data-task={d.taskId}>
      <summary>
        <code>{d.taskId}</code> {d.title}
        {!d.required && <small> · optional</small>}
        <span className="rd-headline">{d.headline}</span>
      </summary>

      {d.impact.length > 0 && (
        <>
          <h5>Why it was affected</h5>
          <ul className="rd-list">
            {d.impact.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {resolved && d.assignment && (
        <>
          <h5>Why this person</h5>
          <p className="rd-summary">{d.assignment.summary}</p>
          <Candidates household={household} list={d.assignment.candidates} />
        </>
      )}

      {!resolved && (
        <>
          <h5>Why it could not be recovered</h5>
          <p className="rd-summary">{d.engineExplanation}</p>
          {d.alternatives && (
            <>
              <h5>Why nobody else could take it</h5>
              <Candidates household={household} list={d.alternatives} />
            </>
          )}
        </>
      )}

      {d.constraints.length > 0 && (
        <>
          <h5>Constraints checked</h5>
          <Constraints list={d.constraints} />
        </>
      )}

      {!resolved && d.nextStep && <p className="rd-next">To make it feasible: {d.nextStep}</p>}
    </details>
  );
}

export interface RecoveryDecisionsProps {
  household: Household;
  current: PlanView;
  reference: Reference | undefined;
}

export function RecoveryDecisions({ household, current, reference }: RecoveryDecisionsProps) {
  const affected = useMemo(
    () => buildMapModel(household, current, reference).affectedTaskIds,
    [household, current, reference],
  );
  const trace = useMemo(
    () => buildDecisionTrace(household, current, reference, affected),
    [household, current, reference, affected],
  );
  const insights = useMemo(
    () => computeInsights(household, current, affected),
    [household, current, affected],
  );

  const taskLabel = (id: string) => `${id} ${nameOf(household, "task", id)}`;
  const person = (id: string) => nameOf(household, "person", id);
  const hasBottleneck =
    insights.uncoveredSkills.length > 0 ||
    insights.singleHolderSkills.length > 0 ||
    insights.resourcePressure.length > 0;
  const v = trace.validation;

  return (
    <section className="rd" aria-labelledby="rd-title">
      <div className="rd-head">
        <div>
          <div className="eyebrow">DECISION TRACE</div>
          <h2 id="rd-title">Why Sahaay did what it did</h2>
        </div>
        <span className="rd-sim">SIMULATED SCENARIO · FICTIONAL HOUSEHOLD</span>
      </div>
      <p className="muted rd-lead">
        Every line below is derived from the household model and the planner's own results.
        The disruptions are simulated; this is not real emergency data.
      </p>

      <div className="rd-insights">
        <h3>Resilience insights</h3>
        <dl className="rd-metrics">
          <div>
            <dt>Required tasks recovered</dt>
            <dd data-metric="required">
              {insights.requiredResolved} of {insights.requiredTotal}
            </dd>
          </div>
          {insights.optionalTotal > 0 && (
            <div>
              <dt>Optional tasks recovered</dt>
              <dd data-metric="optional">
                {insights.optionalResolved} of {insights.optionalTotal}
              </dd>
            </div>
          )}
          <div>
            <dt>Tasks affected by a disruption</dt>
            <dd data-metric="affected">
              {insights.affectedCount} of {insights.taskCount}
            </dd>
          </div>
          <div>
            <dt>Tasks not resolved</dt>
            <dd data-metric="open">{insights.openRiskCount}</dd>
          </div>
        </dl>

        <h4>Bottlenecks</h4>
        <ul className="rd-list" data-testid="bottlenecks">
          {insights.uncoveredSkills.map((s) => (
            <li key={`u-${s.skill}`}>
              <strong>No available person has {s.skill}.</strong> Needed by{" "}
              {s.taskIds.map(taskLabel).join(", ")}.
            </li>
          ))}
          {insights.singleHolderSkills.map((s) => (
            <li key={`s-${s.skill}`}>
              <strong>
                Only {s.holderIds.map(person).join(", ")} can provide {s.skill}.
              </strong>{" "}
              Needed by {s.taskIds.map(taskLabel).join(", ")}. If they become unavailable, no one
              else can take it.
            </li>
          ))}
          {insights.resourcePressure.map((r) => (
            <li key={`r-${r.resourceId}`}>
              <strong>
                {r.name}: {r.disrupted ? "unavailable" : `${r.supply} ${r.unit} in the model`}.
              </strong>{" "}
              Needed by {r.taskIds.map(taskLabel).join(", ")}
              {r.blockedTaskIds.length > 0
                ? `; not resolved: ${r.blockedTaskIds.join(", ")}.`
                : "."}
            </li>
          ))}
          {!hasBottleneck && (
            <li>
              No single-holder skill, uncovered skill or resource shortfall was found for the tasks
              in this scenario.
            </li>
          )}
        </ul>

        {insights.workload.length > 0 && (
          <>
            <h4>Workload in the current plan</h4>
            <ul className="rd-list" data-testid="workload">
              {insights.workload.map((w) => (
                <li key={w.personId}>
                  <strong>{w.name}</strong>: {w.minutes} min · {Math.round(w.share * 100)}% of
                  scheduled time ({w.taskIds.join(", ")})
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <ol className="rd-trace" aria-label="Recovery decision trace">
        <li className="rd-step" data-step="disruption">
          <h3>
            <span className="rd-num">1</span> Disruption
          </h3>
          {trace.disruptions.length === 0 ? (
            <p>
              No disruption is active, so this is the baseline plan. Inject a disruption in the
              controls to see how Sahaay responds.
            </p>
          ) : (
            <ul className="rd-list">
              {trace.disruptions.map((d, i) => (
                <li key={i}>
                  {d.description}.{d.added && <span className="rd-tag rd-tag--new">NEW</span>}
                </li>
              ))}
            </ul>
          )}
        </li>

        <li className="rd-step" data-step="affected">
          <h3>
            <span className="rd-num">2</span> Affected tasks
          </h3>
          {trace.impacted.length === 0 ? (
            <p>{trace.hasDisruptions ? "No task is connected to an active disruption." : "Nothing is affected."}</p>
          ) : (
            <ul className="rd-list">
              {trace.impacted.map((t) => (
                <li key={t.taskId}>
                  <strong>{taskLabel(t.taskId)}</strong>
                  {t.reasons.length > 0 && <span className="rd-note">{t.reasons.join(" ")}</span>}
                </li>
              ))}
            </ul>
          )}
        </li>

        <li className="rd-step" data-step="action">
          <h3>
            <span className="rd-num">3</span> Recovery action
          </h3>
          {trace.decisions.length === 0 ? (
            <p>
              {trace.hasDisruptions
                ? "No task needed a different assignment, and none failed."
                : "Nothing to recover."}
            </p>
          ) : (
            trace.decisions.map((d) => (
              <Decision key={d.taskId} household={household} d={d} open={trace.decisions.length <= 3} />
            ))
          )}
        </li>

        <li className="rd-step" data-step="validation">
          <h3>
            <span className="rd-num">4</span> Validation
          </h3>
          {v.state === "not_reported" ? (
            <p>The planner did not report a validation result for this plan.</p>
          ) : (
            <>
              <p>
                <span className={`rd-tag rd-tag--${v.state}`}>
                  <Icon kind={v.state === "passed" ? "check" : "cross"} size={12} />
                  {v.state === "passed" ? "PASSED" : "FAILED"}
                </span>{" "}
                The independent schedule validator checked {v.scheduledCount} of {v.taskCount} tasks.
              </p>
              {v.messages.length > 0 && (
                <ul className="rd-list">
                  {v.messages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
              {v.state === "passed" && v.scheduledCount < v.taskCount && (
                <p className="rd-note">
                  Validation covers only the tasks that were scheduled. It does not mean the
                  remaining tasks are handled.
                </p>
              )}
            </>
          )}
        </li>

        <li className="rd-step" data-step="risks">
          <h3>
            <span className="rd-num">5</span> Remaining risks
          </h3>
          {trace.risks.required.length === 0 && trace.risks.optional.length === 0 ? (
            <p>No unresolved tasks.</p>
          ) : (
            <ul className="rd-list">
              {trace.risks.required.map((r) => (
                <li key={r.taskId}>
                  <strong>{taskLabel(r.taskId)}</strong> (required)
                  {r.reasonCode ? `: ${reasonTitle(r.reasonCode)}` : ""}
                </li>
              ))}
              {trace.risks.optional.map((r) => (
                <li key={r.taskId}>
                  <strong>{taskLabel(r.taskId)}</strong> (optional)
                  {r.reasonCode ? `: ${reasonTitle(r.reasonCode)}` : ""}
                </li>
              ))}
            </ul>
          )}
          {(trace.risks.required.length > 0 || trace.risks.optional.length > 0) && (
            <p className="rd-note">What a person must do next is listed under “What still needs human intervention” below.</p>
          )}
        </li>
      </ol>
    </section>
  );
}
