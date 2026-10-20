
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
    "get_household_state",
    "get_current_plan",
    "simulate_disruption",
    "rebuild_response_plan",
    "validate_plan",
    "get_unresolved_risks",
    "reset_scenario",
  ];

  const actual = tools.map((tool) => tool.name);
  console.log("Discovered tools:", actual);

  for (const name of expected) {
    if (!actual.includes(name)) {
      throw new Error(`Missing MCP tool: ${name}`);
    }
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

  const simulation = await client.callTool({
    name: "simulate_disruption",
    arguments: {
      type: "person_unavailable",
      targetId: "alex",
    },
  });

  if (simulation.isError) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.content)}`);
  }
  console.log("PASS: simulate_disruption");
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
