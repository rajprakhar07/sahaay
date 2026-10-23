import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon, type IconKind } from "./icons";
import {
  buildMapModel,
  describeNode,
  eligiblePeople,
  nameOf,
  neighbor,
  reasonTitle,
  recoveryCondition,
  type Direction,
  type Household,
  type MapEdge,
  type MapModel,
  type MapNode,
  type PlanView,
  type Reference,
} from "./model";

const KEY_DIRECTION: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function iconFor(node: MapNode): IconKind | undefined {
  switch (node.state) {
    case "resolved":
      return "check";
    case "unresolved":
      return "cross";
    case "blocked":
      return "ban";
    case "disrupted":
      return "warn";
    case "baseline-unavailable":
      return "minus";
    default:
      return undefined;
  }
}

const EMPHASES = ["normal", "affected", "new", "ghost", "eligible"] as const;

export interface ResilienceMapProps {
  household: Household;
  current: PlanView;
  reference?: Reference | undefined;
  /** Changes whenever new planner data arrives; replays entrance effects. */
  updateKey: string;
  reducedMotion: boolean;
}

export function ResilienceMap({
  household,
  current,
  reference,
  updateKey,
  reducedMotion,
}: ResilienceMapProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [focusKey, setFocusKey] = useState<string | undefined>();
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  const model = useMemo(
    () => buildMapModel(household, current, reference, { selectedKey }),
    [household, current, reference, selectedKey],
  );

  const selected = model.nodes.find((n) => n.key === selectedKey);
  const rovingKey =
    focusKey && model.nodes.some((n) => n.key === focusKey)
      ? focusKey
      : model.nodes[0]?.key;

  function moveTo(key: string | undefined) {
    if (!key) return;
    setFocusKey(key);
    nodeRefs.current.get(key)?.focus();
  }

  function onNodeKeyDown(event: KeyboardEvent<SVGGElement>, node: MapNode) {
    const direction = KEY_DIRECTION[event.key];
    if (direction) {
      event.preventDefault();
      moveTo(neighbor(model.nodes, node.key, direction));
    } else if (event.key === "Home") {
      event.preventDefault();
      moveTo(model.nodes[0]?.key);
    } else if (event.key === "End") {
      event.preventDefault();
      moveTo(model.nodes[model.nodes.length - 1]?.key);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedKey((k) => (k === node.key ? undefined : node.key));
    } else if (event.key === "Escape") {
      setSelectedKey(undefined);
    }
  }

  if (model.nodes.length === 0) {
    return (
      <p className="muted" role="status">
        The household model has no people, tasks, resources or locations to
        map yet.
      </p>
    );
  }

  const relationshipEdges = model.edges.filter((e) => e.kind !== "eligible");

  return (
    <div
      className="rm"
      data-reduced-motion={reducedMotion ? "true" : "false"}
    >
      <div
        className="rm-scroll"
        role="region"
        aria-label="Household resilience map, scrollable"
        // Scrollable regions must be reachable by keyboard.
        tabIndex={0}
      >
        <svg
          className="rm-svg"
          viewBox={`0 0 ${model.width} ${model.height}`}
          role="group"
          aria-labelledby={`${uid}t`}
          aria-describedby={`${uid}d`}
        >
          <title id={`${uid}t`}>Household resilience map</title>
          <desc id={`${uid}d`}>
            {`${household.people.length} people, ${household.tasks.length} tasks, ${household.resources.length} resources and ${household.locations.length} locations. Lines show assignments, resource needs, locations and dependencies. Use the arrow keys to move between items and Enter to select one.`}
          </desc>

          <defs>
            {EMPHASES.map((emphasis) => (
              <marker
                key={emphasis}
                id={`${uid}-arrow-${emphasis}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M0 0 8 4 0 8Z"
                  className={`rm-arrow rm-arrow--${emphasis}`}
                />
              </marker>
            ))}
          </defs>

          {model.headers.map((h) => (
            <text key={h.title} className="rm-col-title" x={h.x} y={h.y}>
              {h.title}
            </text>
          ))}

          <g className="rm-edges" aria-hidden="true">
            {model.edges.map((edge) => (
              <EdgeShape
                key={`${edge.key}@${edge.emphasis}@${updateKey}`}
                edge={edge}
                uid={uid}
                selectedKey={selected?.key}
              />
            ))}
          </g>

          <g className="rm-nodes">
            {model.nodes.map((node) => (
              <NodeShape
                key={node.key}
                node={node}
                household={household}
                current={current}
                model={model}
                selected={node.key === selected?.key}
                dimmed={
                  selected !== undefined &&
                  node.key !== selected.key &&
                  !model.edges.some(
                    (e) =>
                      (e.from === selected.key && e.to === node.key) ||
                      (e.to === selected.key && e.from === node.key),
                  )
                }
                tabIndex={node.key === rovingKey ? 0 : -1}
                updateKey={updateKey}
                register={(el) => {
                  if (el) nodeRefs.current.set(node.key, el);
                  else nodeRefs.current.delete(node.key);
                }}
                onSelect={() =>
                  setSelectedKey((k) => (k === node.key ? undefined : node.key))
                }
                onFocus={() => setFocusKey(node.key)}
                onKeyDown={(e) => onNodeKeyDown(e, node)}
              />
            ))}
          </g>
        </svg>
      </div>

      <Legend />

      <div
        className="rm-details"
        role="region"
        aria-label="Selection details"
        aria-live="polite"
      >
        {selected ? (
          <Details
            node={selected}
            household={household}
            current={current}
            model={model}
            reference={reference}
            onClose={() => {
              setSelectedKey(undefined);
              nodeRefs.current.get(selected.key)?.focus();
            }}
          />
        ) : (
          <p className="muted">
            Select a person, task, resource or location (click, or Enter on a
            focused item) to trace its connections and see the planner's
            explanation. Selecting a task also shows who else has the skills
            to do it.
          </p>
        )}
      </div>

      <details className="rm-text-alt">
        <summary>
          Relationships as a text list ({relationshipEdges.length})
        </summary>
        <ul>
          {relationshipEdges.map((e) => (
            <li key={e.key}>{e.description}.</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ pieces ---

function EdgeShape({
  edge,
  uid,
  selectedKey,
}: {
  edge: MapEdge;
  uid: string;
  selectedKey: string | undefined;
}) {
  const related =
    selectedKey !== undefined &&
    (edge.from === selectedKey || edge.to === selectedKey);
  const className = [
    "rm-edge",
    `rm-edge--${edge.kind}`,
    `rm-edge--${edge.emphasis}`,
    edge.affected ? "rm-edge--hot" : "",
    selectedKey !== undefined && !related ? "rm-edge--dim" : "",
    related ? "rm-edge--focus" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g>
      <path
        className={className}
        d={edge.d}
        fill="none"
        markerEnd={
          edge.kind === "depends" || edge.kind === "assigned"
            ? `url(#${uid}-arrow-${edge.emphasis})`
            : undefined
        }
        // Normalised length only for the draw-in animation of new edges.
        {...(edge.emphasis === "new" ? { pathLength: 1 } : {})}
      />
      {edge.label && (
        <text
          className={`rm-edge-label${selectedKey !== undefined && !related ? " rm-edge--dim" : ""}`}
          x={edge.labelX}
          y={edge.labelY - 5}
          textAnchor="middle"
        >
          {edge.label}
        </text>
      )}
    </g>
  );
}

interface NodeShapeProps {
  node: MapNode;
  household: Household;
  current: PlanView;
  model: MapModel;
  selected: boolean;
  dimmed: boolean;
  tabIndex: number;
  updateKey: string;
  register: (el: SVGGElement | null) => void;
  onSelect: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>) => void;
}

function NodeShape({
  node,
  household,
  current,
  model,
  selected,
  dimmed,
  tabIndex,
  updateKey,
  register,
  onSelect,
  onFocus,
  onKeyDown,
}: NodeShapeProps) {
  const icon = iconFor(node);
  const label = describeNode(household, current, model, node);
  const [l1, l2, l3] = node.lines;
  const ys = node.h > 60 ? [24, 43, 60] : [21, 36, 49];
  const tx = node.x + 14;
  const { x, y, w, h } = node;

  const shapeProps = { className: "rm-shape" };
  const shape =
    node.kind === "resource" ? (
      <polygon
        {...shapeProps}
        points={`${x + 10},${y} ${x + w - 10},${y} ${x + w},${y + 10} ${x + w},${y + h - 10} ${x + w - 10},${y + h} ${x + 10},${y + h} ${x},${y + h - 10} ${x},${y + 10}`}
      />
    ) : (
      <rect
        {...shapeProps}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={node.kind === "person" ? 20 : node.kind === "task" ? 9 : 3}
      />
    );

  const className = [
    "rm-node",
    `rm-node--${node.kind}`,
    `rm-node--${node.state}`,
    node.affected ? "rm-node--affected" : "",
    node.change ? `rm-node--changed rm-node--change-${node.change}` : "",
    selected ? "rm-node--selected" : "",
    dimmed ? "rm-node--dim" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g
      ref={register}
      className={className}
      role="button"
      tabIndex={tabIndex}
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      data-node={node.key}
      data-state={node.state}
    >
      <title>{label}</title>
      {node.state === "disrupted" && (
        <rect
          key={`pulse@${updateKey}`}
          className="rm-halo rm-halo--pulse"
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={node.kind === "person" ? 23 : 8}
        />
      )}
      {node.change && (
        <rect
          key={`flash@${updateKey}`}
          className="rm-halo rm-halo--flash"
          x={x - 3}
          y={y - 3}
          width={w + 6}
          height={h + 6}
          rx={12}
        />
      )}
      <rect
        className="rm-focus"
        x={x - 5}
        y={y - 5}
        width={w + 10}
        height={h + 10}
        rx={node.kind === "person" ? 25 : 12}
      />
      {shape}
      {icon && (
        <Icon kind={icon} size={14} x={x + w - 24} y={y + 8} className="rm-node-icon" />
      )}
      <text className="rm-l1" x={tx} y={y + (ys[0] ?? 21)}>
        {l1}
      </text>
      <text className="rm-l2" x={tx} y={y + (ys[1] ?? 36)}>
        {l2}
      </text>
      {l3 && (
        <text className="rm-l3" x={tx} y={y + (ys[2] ?? 49)}>
          {l3}
        </text>
      )}
    </g>
  );
}

function Legend() {
  const states: [IconKind, string][] = [
    ["check", "Resolved"],
    ["ban", "Blocked"],
    ["cross", "Unresolved"],
    ["warn", "Disrupted"],
    ["minus", "Unavailable in model"],
  ];
  const lines: [string, string][] = [
    ["assigned", "Assigned"],
    ["needs", "Needs resource"],
    ["at", "Takes place at"],
    ["depends", "Depends on"],
    ["ghost", "Was assigned (before)"],
    ["eligible", "Could do (selected task)"],
  ];
  return (
    <div className="rm-legend" aria-label="Legend">
      <ul>
        {states.map(([kind, text]) => (
          <li key={text}>
            <Icon kind={kind} size={13} className={`rm-legend-icon rm-legend-icon--${kind}`} />
            {text}
          </li>
        ))}
      </ul>
      <ul>
        {lines.map(([kind, text]) => (
          <li key={text}>
            <svg width="30" height="8" aria-hidden="true" focusable="false">
              <line
                className={`rm-edge rm-edge--${kind === "ghost" ? "assigned rm-edge--ghost" : kind}${kind === "eligible" ? " rm-edge--eligible" : ""}`}
                x1="1"
                y1="4"
                x2="29"
                y2="4"
              />
            </svg>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Details({
  node,
  household,
  current,
  model,
  reference,
  onClose,
}: {
  node: MapNode;
  household: Household;
  current: PlanView;
  model: MapModel;
  reference: Reference | undefined;
  onClose: () => void;
}) {
  const stateOf = (taskId: string) => current.tasks.find((t) => t.taskId === taskId);
  const taskLabel = (taskId: string) => {
    const s = stateOf(taskId);
    return `${taskId} ${nameOf(household, "task", taskId)} (${s ? s.status : "no result"})`;
  };

  let body: React.ReactNode = null;
  let title = "";
  let badge: React.ReactNode = null;

  if (node.kind === "task") {
    const task = household.tasks.find((t) => t.id === node.id);
    const s = stateOf(node.id);
    const change = model.changes.find((c) => c.taskId === node.id);
    const eligible = task ? eligiblePeople(household, task) : [];
    const before = change?.before?.assignedPersonId;
    title = `${node.id} · ${task?.title ?? ""}`;
    badge = s && (
      <span className={`rm-badge rm-badge--${s.status}`}>
        <Icon
          kind={s.status === "resolved" ? "check" : s.status === "blocked" ? "ban" : "cross"}
          size={12}
        />
        {s.status.toUpperCase()}
      </span>
    );
    body = (
      <dl>
        <Row label="Planner explanation">{s?.explanation || "No explanation reported."}</Row>
        <Row label="Reason">
          {s?.reasonCode ? (
            <>
              <code>{s.reasonCode}</code> · {reasonTitle(s.reasonCode)}
            </>
          ) : null}
        </Row>
        <Row label="Assigned now">
          {s?.status === "resolved" && s.assignedPersonId
            ? nameOf(household, "person", s.assignedPersonId)
            : "Nobody (not resolved)"}
        </Row>
        <Row label={`Before${reference ? ` (${reference.label.toLowerCase()})` : ""}`}>
          {reference
            ? before
              ? nameOf(household, "person", before)
              : change?.before
                ? change.before.status === "resolved"
                  ? "Resolved without a named assignee"
                  : `Not resolved (${change.before.status})`
                : "Not in the reference plan"
            : null}
        </Row>
        <Row label="Blocked by">
          {s && s.blockedBy.length > 0
            ? s.blockedBy
                .map((b) => (b.kind === "skill" ? `skill: ${b.id}` : `${b.kind}: ${nameOf(household, b.kind, b.id)}`))
                .join(" · ")
            : null}
        </Row>
        <Row label="What would make it feasible">
          {s && s.status !== "resolved" ? recoveryCondition(s, household) : null}
        </Row>
        <Row label="Needs">
          {task && task.resourceNeeds.length > 0
            ? task.resourceNeeds
                .map((n) => `${nameOf(household, "resource", n.resourceId)} ×${n.quantity}`)
                .join(" · ")
            : null}
        </Row>
        <Row label="Location">
          {task?.locationId ? nameOf(household, "location", task.locationId) : null}
        </Row>
        <Row label="Depends on">
          {task && task.dependsOnTaskIds.length > 0
            ? task.dependsOnTaskIds.map(taskLabel).join(" · ")
            : null}
        </Row>
        <Row label="Skills needed">
          {task && task.requiredSkills.length > 0 ? task.requiredSkills.join(", ") : "None specified"}
        </Row>
        <Row label="People with those skills">
          {task && task.requiredSkills.length > 0
            ? eligible.length > 0
              ? eligible
                  .map((p) => {
                    const off =
                      model.nodes.find((n) => n.key === `person:${p.id}`)?.state !== "ok";
                    return `${p.name} (${off ? "unavailable" : "available"})`;
                  })
                  .join(" · ")
              : "Nobody"
            : null}
        </Row>
      </dl>
    );
  } else if (node.kind === "person") {
    const p = household.people.find((x) => x.id === node.id);
    title = p?.name ?? node.id;
    badge = (
      <span className={`rm-badge rm-badge--${node.state === "ok" ? "resolved" : "blocked"}`}>
        <Icon kind={node.state === "ok" ? "check" : node.state === "disrupted" ? "warn" : "minus"} size={12} />
        {node.lines[1]}
      </span>
    );
    const assigned = current.tasks.filter(
      (t) => t.status === "resolved" && t.assignedPersonId === node.id,
    );
    body = (
      <dl>
        <Row label="Skills">{p && p.skills.length > 0 ? p.skills.join(", ") : "None listed"}</Row>
        <Row label="Assigned now">
          {assigned.length > 0 ? assigned.map((t) => taskLabel(t.taskId)).join(" · ") : "No tasks"}
        </Row>
        <Row label="Could also do">
          {household.tasks
            .filter(
              (t) =>
                eligiblePeople(household, t).some((e) => e.id === node.id) &&
                !assigned.some((a) => a.taskId === t.id),
            )
            .map((t) => t.id)
            .join(", ") || null}
        </Row>
      </dl>
    );
  } else {
    const isResource = node.kind === "resource";
    const r = household.resources.find((x) => x.id === node.id);
    const l = household.locations.find((x) => x.id === node.id);
    title = (isResource ? r?.name : l?.name) ?? node.id;
    badge = (
      <span className={`rm-badge rm-badge--${node.state === "ok" ? "resolved" : "blocked"}`}>
        <Icon kind={node.state === "ok" ? "check" : "warn"} size={12} />
        {node.lines[1]}
      </span>
    );
    const users = household.tasks.filter((t) =>
      isResource
        ? t.resourceNeeds.some((n) => n.resourceId === node.id)
        : t.locationId === node.id,
    );
    body = (
      <dl>
        {isResource && r && (
          <Row label="Stock">{`${r.quantity} ${r.unit} · ${r.kind}`.trim()}</Row>
        )}
        <Row label={isResource ? "Needed by" : "Tasks here"}>
          {users.length > 0 ? users.map((t) => taskLabel(t.id)).join(" · ") : "No tasks"}
        </Row>
      </dl>
    );
  }

  return (
    <div className="rm-detail-card">
      <div className="rm-detail-head">
        <div>
          <span className="eyebrow">{node.kind.toUpperCase()}</span>
          <h3>{title}</h3>
        </div>
        {badge}
        <button type="button" className="rm-close" onClick={onClose}>
          CLOSE
        </button>
      </div>
      {body}
    </div>
  );
}
