
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const client = new Client(
  {
    name: "sahaay-smoke-test",
    version: "1.0.0",
  },
  {
    versionNegotiation: {
      mode: "auto",
    },
  },
);

function parseToolJson<T>(
  result: { content: Array<{ type: string; text?: string }> },
  label: string,
): T {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} did not return valid JSON: ${text}`);
  }
}

try {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:3001/mcp"),
  );

  await client.connect(transport);
  console.log("Negotiated MCP protocol era:", client.getProtocolEra());
  console.log(
  "Negotiated MCP protocol version:",
  client.getNegotiatedProtocolVersion(),
);


  const { tools } = await client.listTools();
  const expected = [
    "update_household_state",
    "get_household_state",
    "get_current_plan",
    "simulate_disruption",
    "rebuild_response_plan",
    "validate_plan",
    "get_unresolved_risks",
    "reset_household_state",
    "reset_scenario",
  ];

  const actual = tools.map((tool) => tool.name);
  console.log("Discovered tools:", actual);

  for (const name of expected) {
    if (!actual.includes(name)) {
      throw new Error(`Missing MCP tool: ${name}`);
    }
  }

  const initialReset = await client.callTool({ name: "reset_household_state" });
  if (initialReset.isError) {
    throw new Error("Could not reset scenario before end-to-end validation.");
  }

  for (const name of [
    "get_household_state",
    "get_current_plan",
    "validate_plan",
    "get_unresolved_risks",
  ]) {
    const result = await client.callTool({ name });
    if (result.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
    }
    console.log(`PASS: ${name}`);
  }

  const baselineResult = await client.callTool({ name: "get_current_plan" });
  if (baselineResult.isError) {
    throw new Error("Could not retrieve the baseline plan.");
  }
  const baseline = parseToolJson<{
    complete: boolean;
    currentPlan: { assignedTasks?: Array<{ id?: string; assignedPersonId?: string }> };
  }>(baselineResult, "Baseline plan");
  if (!baseline.complete) {
    throw new Error("Expected the baseline scenario to be complete before disruption.");
  }
  const baselineT01 = baseline.currentPlan.assignedTasks?.find(
    (task) => task.id === "T01",
  );
  if (baselineT01?.assignedPersonId !== "sam") {
    throw new Error(`Expected baseline T01 assignment to Sam, got ${JSON.stringify(baselineT01)}.`);
  }
  console.log("PASS: baseline plan assigns T01 to Sam");

  const simulation = await client.callTool({
    name: "simulate_disruption",
    arguments: {
      type: "person_unavailable",
      targetId: "sam",
    },
  });

  if (simulation.isError) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.content)}`);
  }
  console.log("PASS: simulate_disruption");

  const recoveredPlanResult = await client.callTool({ name: "get_current_plan" });
  if (recoveredPlanResult.isError) {
    throw new Error("Could not retrieve the plan after person disruption.");
  }
  const recoveredPlan = parseToolJson<{
    currentPlan: { assignedTasks?: Array<{ id?: string; assignedPersonId?: string }> };
  }>(recoveredPlanResult, "Recovered plan");
  const recoveredT01 = recoveredPlan.currentPlan.assignedTasks?.find(
    (task) => task.id === "T01",
  );
  if (recoveredT01?.assignedPersonId !== "taylor") {
    throw new Error(`Expected T01 to be reassigned to Taylor after Sam becomes unavailable, got ${JSON.stringify(recoveredT01)}.`);
  }
  console.log("PASS: unavailable helper triggers real reassignment to Taylor");

  const duplicateSimulation = await client.callTool({
    name: "simulate_disruption",
    arguments: { type: "person_unavailable", targetId: "sam" },
  });
  if (duplicateSimulation.isError) {
    throw new Error("Repeating an active disruption should be accepted idempotently.");
  }
  const householdAfterDuplicate = await client.callTool({ name: "get_current_plan" });
  const duplicatePlan = parseToolJson<{
    disruptions: Array<{ type: string; personId?: string }>;
  }>(householdAfterDuplicate, "Plan after duplicate disruption");
  if (
    duplicatePlan.disruptions.filter(
      (item) => item.type === "person_unavailable" && item.personId === "sam",
    ).length !== 1
  ) {
    throw new Error("Repeated identical disruption was recorded more than once.");
  }
  console.log("PASS: repeated disruption is idempotent");

  const validationAfterDisruption = await client.callTool({
    name: "validate_plan",
  });

  if (validationAfterDisruption.isError) {
    throw new Error(
      `Validation after disruption failed: ${JSON.stringify(
        validationAfterDisruption.content,
      )}`,
    );
  }

  const validationText = validationAfterDisruption.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  let validationData: {
    complete?: boolean;
    recovered?: boolean;
    unresolvedRisks?: unknown[];
    scheduledTasksValidation?: unknown;
  };

  try {
    validationData = JSON.parse(validationText);
  } catch {
    throw new Error(
      "validate_plan did not return the expected structured JSON.",
    );
  }

  if (
    typeof validationData.complete !== "boolean" ||
    typeof validationData.recovered !== "boolean" ||
    !Array.isArray(validationData.unresolvedRisks) ||
    validationData.scheduledTasksValidation === undefined
  ) {
    throw new Error(
      "validate_plan did not include validation, completion, recovery, and unresolved-risk fields.",
    );
  }
    console.log("Recovery status:", {
    complete: validationData.complete,
    recovered: validationData.recovered,
    unresolvedRisks: validationData.unresolvedRisks.length,
  });
  console.log("PASS: validation reports current recovery status");
    const resourceDisruption = await client.callTool({
    name: "simulate_disruption",
    arguments: {
      type: "resource_unavailable",
      targetId: "water",
    },
  });

  if (resourceDisruption.isError) {
    throw new Error(
      `Resource disruption failed: ${JSON.stringify(resourceDisruption.content)}`,
    );
  }

  const impossibleValidation = await client.callTool({
    name: "validate_plan",
  });

  if (impossibleValidation.isError) {
    throw new Error("Validation failed after the water kit became unavailable.");
  }

  const impossibleText = impossibleValidation.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const impossibleData = JSON.parse(impossibleText) as {
    complete: boolean;
    recovered: boolean;
    unresolvedRisks: unknown[];
  };

  if (
    impossibleData.complete ||
    impossibleData.recovered ||
    impossibleData.unresolvedRisks.length === 0
  ) {
    throw new Error(
      `Expected incomplete recovery with unresolved risks, got: ${impossibleText}`,
    );
  }


  console.log("PASS: impossible recovery reported honestly");


const beforeInvalid = await client.callTool({
  name: "get_unresolved_risks",
});

if (beforeInvalid.isError) {
  throw new Error("Could not inspect scenario before invalid input.");
}

const invalidTarget = await client.callTool({
  name: "simulate_disruption",
  arguments: {
    type: "person_unavailable",
    targetId: "unknown-person",
  },
});

if (!invalidTarget.isError) {
  throw new Error("An unknown person ID was incorrectly accepted.");
}

const afterInvalid = await client.callTool({
  name: "get_unresolved_risks",
});

if (afterInvalid.isError) {
  throw new Error("Could not inspect scenario after invalid input.");
}

if (
  JSON.stringify(beforeInvalid.content) !==
  JSON.stringify(afterInvalid.content)
) {
  throw new Error("Scenario risks changed after invalid input.");
}

console.log("PASS: invalid input leaves scenario risks unchanged");





  const recovery = await client.callTool({
    name: "rebuild_response_plan",
  });

  if (recovery.isError) {
    throw new Error(`Recovery failed: ${JSON.stringify(recovery.content)}`);
  }
  console.log("PASS: rebuild_response_plan");

  const reset = await client.callTool({ name: "reset_scenario" });
  if (reset.isError) {
    throw new Error(`Reset failed: ${JSON.stringify(reset.content)}`);
  }
  console.log("PASS: reset_scenario");
    const risksAfterReset = await client.callTool({
    name: "get_unresolved_risks",
  });

  if (risksAfterReset.isError) {
    throw new Error("Could not inspect risks after reset.");
  }

  const risksText = risksAfterReset.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const risks = JSON.parse(risksText);

  if (!Array.isArray(risks) || risks.length !== 0) {
    throw new Error(
      `Expected no unresolved risks after reset, got: ${risksText}`,
    );
  }

  console.log("PASS: reset clears scenario risks");

  const locationReset = await client.callTool({
    name: "reset_scenario",
  });

  if (locationReset.isError) {
    throw new Error("Could not reset before location-disruption test.");
  }

  const locationDisruption = await client.callTool({
    name: "simulate_disruption",
    arguments: {
      type: "location_inaccessible",
      targetId: "home",
    },
  });

  if (locationDisruption.isError) {
    throw new Error(
      `Location disruption failed: ${JSON.stringify(locationDisruption.content)}`,
    );
  }

  const locationPlanResult = await client.callTool({
    name: "get_current_plan",
  });

  if (locationPlanResult.isError) {
    throw new Error("Could not retrieve the plan after location disruption.");
  }

  const locationPlanText = locationPlanResult.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  const locationPlan = JSON.parse(locationPlanText) as {
    complete: boolean;
    recovered: boolean;
    unresolvedRisks: unknown[];
    currentPlan: {
      tasks?: Array<{
        taskId?: string;
        id?: string;
        status?: string;
        reason?: string;
        issues?: Array<{ message?: string; reason?: string }>;
      }>;
    };
  };

  if (locationPlan.complete || locationPlan.recovered) {
    throw new Error(
      `Expected location disruption to prevent full recovery: ${locationPlanText}`,
    );
  }

  if (locationPlan.unresolvedRisks.length === 0) {
    throw new Error(
      `Expected unresolved risks after location disruption: ${locationPlanText}`,
    );
  }

  const locationRisks = locationPlan.unresolvedRisks as Array<{
    taskId: string;
    reason: string;
  }>;

  for (const taskId of ["T01", "T02"]) {
    const issue = locationRisks.find((risk) => risk.taskId === taskId);

    if (!issue || !issue.reason.toLowerCase().includes("location")) {
      throw new Error(
        `Expected ${taskId} to remain unresolved because its location is inaccessible: ${locationPlanText}`,
      );
    }
  }

  console.log("PASS: inaccessible demo location prevents full recovery");

  const finalReset = await client.callTool({
    name: "reset_scenario",
  });

  if (finalReset.isError) {
    throw new Error("Final scenario reset failed.");
  }

  console.log("PASS: location test scenario reset");


  console.log("SUCCESS: MCP HTTP connection and all seven tools verified.");
} finally {
  await client.close();
}
