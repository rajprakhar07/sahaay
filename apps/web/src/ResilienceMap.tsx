type Data = Record<string, any>;

type Props = {
  household: Data | null;
  plan: Data | null;
  activeDisruptions: Data[];
};

function list(value: unknown): Data[] {
  return Array.isArray(value) ? value : [];
}

function label(value: unknown, fallback = "Not specified"): string {
  return value == null || value === "" ? fallback : String(value);
}

export default function ResilienceMap({
  household,
  plan,
  activeDisruptions,
}: Props) {
  const people = list(household?.people);
  const resources = list(household?.resources);
  const locations = list(household?.locations);

  const current = plan?.currentPlan ?? plan?.recoveryPlan;
  const tasks = list(
    current?.assignedTasks ??
      current?.tasks ??
      current?.assignments ??
      current?.scheduledTasks,
  );
  const unassignedTasks = list(current?.unassignedTasks);

  const unavailablePersonIds = new Set(
    activeDisruptions
      .filter((item) => item.type === "person_unavailable")
      .map((item) => item.personId),
  );
  const unavailableResourceIds = new Set(
    activeDisruptions
      .filter((item) => item.type === "resource_unavailable")
      .map((item) => item.resourceId),
  );
  const inaccessibleLocationIds = new Set(
    activeDisruptions
      .filter((item) => item.type === "location_inaccessible")
      .map((item) => item.locationId),
  );

  const isPersonUnavailable = (person: Data) =>
    person.available === false || unavailablePersonIds.has(person.id);

  const personName = (task: Data) => {
    const assigned =
      task.assignedPersonId ??
      task.assigneeName ??
      task.personName ??
      task.assignedTo ??
      task.personId;

    const match = people.find(
      (person) => person.id === assigned || person.name === assigned,
    );

    return match?.name ?? label(assigned, "Unassigned");
  };

  const locationName = (id: unknown) =>
    locations.find((location) => location.id === id)?.name ??
    label(id, "No location specified");

  const taskReason = (taskId: unknown) =>
    unassignedTasks.find(
      (item) => item.taskId === taskId || item.id === taskId,
    );

  const unresolvedOnly = unassignedTasks.filter(
    (item) => !tasks.some((task) => task.id === (item.taskId ?? item.id)),
  );

  return (
    <section className="panel resilience-panel" aria-labelledby="resilience-title">
      <div className="resilience-heading">
        <div>
          <div className="eyebrow">SYSTEM VIEW</div>
          <h2 id="resilience-title">Resilience Map</h2>
          <p>
            See how people, tasks, resources and locations connect in the
            current plan.
          </p>
        </div>
        <span className="resilience-chip">
          {activeDisruptions.length} active disruption
          {activeDisruptions.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="resilience-grid">
        <section className="resilience-column" aria-labelledby="resilience-people">
          <h3 id="resilience-people">People</h3>
          {people.length === 0 ? (
            <p className="resilience-empty">No people in this household.</p>
          ) : (
            people.map((person) => {
              const unavailable = isPersonUnavailable(person);
              return (
                <article className="resilience-node" key={person.id}>
                  <strong className="resilience-node-title">
                    {label(person.name, person.id)}
                  </strong>
                  <span
                    className={`resilience-status ${
                      unavailable ? "is-blocked" : "is-available"
                    }`}
                  >
                    {unavailable ? "Unavailable" : "Available"}
                  </span>
                  <p className="resilience-meta">
                    Skills: {list(person.skills).join(", ") || "Not listed"}
                  </p>
                </article>
              );
            })
          )}
        </section>

        <section className="resilience-column" aria-labelledby="resilience-tasks">
          <h3 id="resilience-tasks">Tasks</h3>
          {tasks.length === 0 && unresolvedOnly.length === 0 ? (
            <p className="resilience-empty">No tasks in the current plan.</p>
          ) : (
            <>
              {tasks.map((task) => {
                const issue = taskReason(task.id);
                const needs = list(task.resourceNeeds);
                const dependencies = list(task.dependsOnTaskIds);

                return (
                  <article className="resilience-node" key={task.id}>
                    <strong className="resilience-node-title">
                      {label(task.title, task.id)}
                    </strong>
                    <span
                      className={`resilience-status ${
                        issue ? "is-blocked" : "is-available"
                      }`}
                    >
                      {issue ? "Needs attention" : "In current plan"}
                    </span>
                    <p className="resilience-meta">
                      Priority: {label(task.priority, "Not set")}
                    </p>
                    <p className="resilience-meta">
                      Assigned to: {personName(task)}
                    </p>
                    <p className="resilience-meta">
                      Location: {locationName(task.locationId)}
                    </p>
                    {needs.length > 0 && (
                      <p className="resilience-meta">
                        Resources:{" "}
                        {needs
                          .map((need) => {
                            const resource = resources.find(
                              (item) => item.id === need.resourceId,
                            );
                            return `${resource?.name ?? need.resourceId ?? "Resource"} × ${label(need.quantity, "1")}`;
                          })
                          .join(", ")}
                      </p>
                    )}
                    {dependencies.length > 0 && (
                      <p className="resilience-meta">
                        Depends on: {dependencies.join(", ")}
                      </p>
                    )}
                    {issue && (
                      <p className="resilience-unresolved">
                        Reason: {label(issue.reason, "Requires review")}
                      </p>
                    )}
                  </article>
                );
              })}

              {unresolvedOnly.map((item, index) => (
                <article
                  className="resilience-node"
                  key={item.taskId ?? item.id ?? `unresolved-${index}`}
                >
                  <strong className="resilience-node-title">
                    {label(item.title ?? item.taskId ?? item.id, "Unassigned task")}
                  </strong>
                  <span className="resilience-status is-blocked">
                    Unassigned
                  </span>
                  <p className="resilience-unresolved">
                    Reason: {label(item.reason, "Requires review")}
                  </p>
                </article>
              ))}
            </>
          )}
        </section>

        <section
          className="resilience-column"
          aria-labelledby="resilience-resources"
        >
          <h3 id="resilience-resources">Resources & locations</h3>

          {resources.length === 0 && locations.length === 0 && (
            <p className="resilience-empty">
              No resources or locations configured.
            </p>
          )}

          {resources.map((resource) => {
            const unavailable = unavailableResourceIds.has(resource.id);
            return (
              <article className="resilience-node" key={`resource-${resource.id}`}>
                <strong className="resilience-node-title">
                  {label(resource.name, resource.id)}
                </strong>
                <span
                  className={`resilience-status ${
                    unavailable ? "is-blocked" : "is-available"
                  }`}
                >
                  {unavailable ? "Unavailable" : "Available in scenario"}
                </span>
                <p className="resilience-meta">
                  Quantity: {label(resource.quantity, "Unknown")}{" "}
                  {label(resource.unit, "")}
                </p>
                {resource.locationId && (
                  <p className="resilience-meta">
                    Stored at: {locationName(resource.locationId)}
                  </p>
                )}
              </article>
            );
          })}

          {locations.map((location) => {
            const inaccessible = inaccessibleLocationIds.has(location.id);
            return (
              <article className="resilience-node" key={`location-${location.id}`}>
                <strong className="resilience-node-title">
                  {label(location.name, location.id)}
                </strong>
                <span
                  className={`resilience-status ${
                    inaccessible ? "is-blocked" : "is-available"
                  }`}
                >
                  {inaccessible ? "Inaccessible" : "Accessible in scenario"}
                </span>
                {location.description && (
                  <p className="resilience-meta">{location.description}</p>
                )}
              </article>
            );
          })}
        </section>
      </div>

      <p className="resilience-meta">
        This map reflects the available household and plan data. Statuses
        represent a simulated scenario and do not certify real-world safety.
      </p>
    </section>
  );
}
