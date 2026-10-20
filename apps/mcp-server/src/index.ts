import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HouseholdPlanSchema, recoverPlan } from "@sahaay/engine";


const household = HouseholdPlanSchema.parse({
  id: "demo-household",
  people: [
    { id: "alex", name: "Alex", skills: ["first-aid"], available: true },
    { id: "sam", name: "Sam", skills: ["communication"], available: true },
  ],
  tasks: [
    {
      id: "T01",
      title: "Check household members",
      priority: "critical",
      required: true,
      estimatedMinutes: 10,
      requiredSkills: ["communication"],
      locationId: "home",
    },
    {
      id: "T02",
      title: "Prepare emergency supplies",
      priority: "high",
      required: true,
      estimatedMinutes: 20,
      locationId: "home",
      resourceNeeds: [{ resourceId: "water", quantity: 1 }],
    },
  ],
  resources: [
    { id: "water", name: "Water kit", kind: "reusable", quantity: 1, unit: "kit" },
  ],
  locations: [
    { id: "home", name: "Home", description: "Fictional demo location" },
  ],
});

type Disruption =
  | { type: "person_unavailable"; personId: string }
  | { type: "resource_unavailable"; resourceId: string }
  | { type: "location_inaccessible"; locationId: string };

// Shared scenario state; each HTTP request gets a fresh MCP server instance.
let disruptions: Disruption[] = [];

function createServer() {
  const server = new McpServer({
    name: "sahaay-mcp-server",
    version: "0.1.0",
  });

  server.registerTool(
    "get_household_state",
    { description: "Get the current fictional household state." },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(household, null, 2) }],
    }),
  );

  server.registerTool(
    "get_current_plan",
    {
      description:
        "Calculate the current scenario plan and include the original baseline for comparison.",
    },
    async () => {
      const result = recoverPlan(household, disruptions);
      const status = result.complete
        ? "complete"
        : result.recovered
          ? "partial"
          : "failed";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status,
            baselinePlan: result.originalPlan,
            currentPlan: result.recoveryPlan,
            complete: result.complete,
            recovered: result.recovered,
            unresolvedRisks: result.unresolvedRisks,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "simulate_disruption",
    {
      description: "Apply a simulated person, resource, or location disruption.",
      inputSchema: z.object({
        type: z.enum([
          "person_unavailable",
          "resource_unavailable",
          "location_inaccessible",
        ]),
        targetId: z.string().min(1),
      }),
    },
    async ({ type, targetId }) => {
      const disruption: Disruption =
        type === "person_unavailable"
          ? { type, personId: targetId }
          : type === "resource_unavailable"
            ? { type, resourceId: targetId }
            : { type, locationId: targetId };

      // Validate the target before changing scenario state.
      recoverPlan(household, [disruption]);
      disruptions = [...disruptions, disruption];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ simulated: true, disruptions }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "rebuild_response_plan",
    { description: "Rebuild the plan after recorded disruptions." },
    async () => {
      const result = recoverPlan(household, disruptions);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "validate_plan",
    {
      description:
        "Validate the current scenario and report recovery status separately from schedule validation.",
    },
    async () => {
      const result = recoverPlan(household, disruptions);
      const status = result.complete
        ? "complete"
        : result.recovered
          ? "partial"
          : "failed";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status,
            scheduledTasksValidation: result.recoveryPlan.validation,
            complete: result.complete,
            recovered: result.recovered,
            unresolvedRisks: result.unresolvedRisks,
          }, null, 2),
        }],
      };
    },
  );
  server.registerTool(
    "get_unresolved_risks",
    { description: "List unresolved risks in the current scenario." },
    async () => {
      const result = recoverPlan(household, disruptions);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result.unresolvedRisks, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    "reset_scenario",
    { description: "Reset simulated disruptions to baseline." },
    async () => {
      disruptions = [];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ reset: true, disruptions }, null, 2),
        }],
      };
    },
  );

  return server;
}

export const handler = createMcpHandler(createServer);
