import { useEffect, useMemo, useState } from "react";
import { RecoveryCompare, RecoveryStatusBadge } from "./RecoveryCompare";
import { RecoveryDecisions } from "./RecoveryDecisions";
import { ResilienceMap } from "./ResilienceMap";
import {
  parseBaselineReference,
  parseHousehold,
  parsePlanView,
  type PlanView,
  type Reference,
  type RequestPhase,
} from "./model";
import { useReducedMotion } from "./useReducedMotion";

/** The real plan captured from the server immediately before a disruption. */
export interface Snapshot {
  capturedAt: string;
  /** Human-readable description of what was injected right afterwards. */
  trigger: string;
  /** Unmodified GET /api/plan payload. */
  plan: unknown;
}

export interface ResilienceWorkspaceProps {
  household: unknown;
  plan: unknown;
  snapshot: Snapshot | null;
  phase: RequestPhase;
  /** `map`: the map only (Overview). `full`: map, comparison and explanations. */
  mode: "map" | "full";
}

/** Small stable hash, used only to replay entrance effects on new data. */
function signature(view: PlanView): string {
  const text = JSON.stringify([
    view.disruptions,
    view.tasks.map((t) => [t.taskId, t.status, t.reasonCode, t.assignedPersonId]),
  ]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function ResilienceWorkspace({
  household,
  plan,
  snapshot,
  phase,
  mode,
}: ResilienceWorkspaceProps) {
  const reducedMotion = useReducedMotion();
  const hh = useMemo(() => parseHousehold(household), [household]);
  const current = useMemo(() => parsePlanView(plan), [plan]);
  const baselineRef = useMemo(() => parseBaselineReference(plan), [plan]);

  const snapshotRef = useMemo<Reference | undefined>(() => {
    if (!snapshot) return undefined;
    const view = parsePlanView(snapshot.plan);
    if (!view) return undefined;
    return {
      kind: "snapshot",
      label: "Before last disruption",
      capturedAt: snapshot.capturedAt,
      trigger: snapshot.trigger,
      view,
    };
  }, [snapshot]);

  const [choice, setChoice] = useState<"snapshot" | "baseline">("snapshot");
  // A new capture becomes the default comparison again.
  useEffect(() => {
    setChoice("snapshot");
  }, [snapshot?.capturedAt]);

  const reference: Reference | undefined =
    choice === "snapshot" && snapshotRef ? snapshotRef : (baselineRef ?? undefined);

  const phaseText =
    phase.state === "idle"
      ? "Idle · showing the planner's current state"
      : phase.state === "processing"
        ? `Processing · ${phase.step}`
        : phase.state === "succeeded"
          ? `Updated at ${new Date(phase.at).toLocaleTimeString()}`
          : `Failed · ${phase.message}`;

  return (
    <section className="rw" aria-labelledby="rw-title" data-phase={phase.state}>
      <div className="rw-head">
        <div>
          <div className="eyebrow">LIVE RECOVERY NETWORK</div>
          <h2 id="rw-title">Household Resilience Map</h2>
          <p className="muted">
            Built from the household model and the planner's own results.
            Nothing here is simulated for effect.
          </p>
        </div>
        {current && <RecoveryStatusBadge status={current.recoveryStatus} />}
      </div>

      <div
        className={`rw-phase rw-phase--${phase.state}`}
        role="status"
        aria-live="polite"
      >
        <span className="rw-phase-dot" aria-hidden="true" />
        <span>{phaseText}</span>
        {phase.state === "processing" && (
          <span className="rw-bar" aria-hidden="true">
            <span />
          </span>
        )}
      </div>

      {!hh || !current ? (
        <p className="muted" role="status">
          Household or planner data is not available yet.
        </p>
      ) : (
        <>
          {mode === "full" && snapshotRef && (
            <fieldset className="rw-choice">
              <legend>Compare against</legend>
              <label>
                <input
                  type="radio"
                  name="rw-reference"
                  checked={choice === "snapshot"}
                  onChange={() => setChoice("snapshot")}
                />
                Before the last disruption
                <small>
                  captured {new Date(snapshotRef.capturedAt ?? "").toLocaleTimeString()}
                </small>
              </label>
              <label>
                <input
                  type="radio"
                  name="rw-reference"
                  checked={choice === "baseline"}
                  onChange={() => setChoice("baseline")}
                />
                Baseline (no disruptions)
              </label>
            </fieldset>
          )}

          <ResilienceMap
            household={hh}
            current={current}
            reference={mode === "full" ? reference : undefined}
            updateKey={signature(current)}
            reducedMotion={reducedMotion}
          />

          {mode === "full" && (
            <RecoveryDecisions household={hh} current={current} reference={reference} />
          )}

          {mode === "full" && (
            <RecoveryCompare household={hh} current={current} reference={reference} />
          )}
        </>
      )}
    </section>
  );
}
