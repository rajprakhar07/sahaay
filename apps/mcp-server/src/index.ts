import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HouseholdPlanSchema, recoverPlan } from "@sahaay/engine";


const baselineHousehold = HouseholdPlanSchema.parse({
  id: "demo-household",
  people: [
    { id: "alex", name: "Alex", skills: ["first-aid"], available: true },
    { id: "sam", name: "Sam", skills: ["communication"], available: true },
    // Backup with an overlapping skill so recovery can demonstrate a real
    // reassignment. "taylor" sorts after "sam", so the baseline plan still
    // assigns T01 to Sam; Taylor is used only when Sam is unavailable.
    { id: "taylor", name: "Taylor", skills: ["communication"], available: true },
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

/**
 * Pre-existing three-way status, kept as `legacyStatus` for compatibility.
 * Note its semantics differ from the engine's `recoveryStatus`: "partial"
 * here means every required task is done but an optional one is not, and any
 * unresolved required task is reported as "failed".
 */
function legacyStatus(result: { complete: boolean; recovered: boolean }) {
  return result.complete ? "complete" : result.recovered ? "partial" : "failed";
}

// Shared scenario state; each HTTP request gets a fresh MCP server instance.
// Shared state persists across MCP server instances in this process.
let disruptions: Disruption[] = [];
let household = structuredClone(baselineHousehold);

function createServer() {
  const server = new McpServer({
    name: "sahaay-mcp-server",
    version: "0.1.0",
  });
    server.registerTool(
    "update_household_state",
    {
      description:
        "Validate and save an edited fictional household model.",
      inputSchema: z.object({
        household: HouseholdPlanSchema,
      }),
    },
    async ({ household: proposedHousehold }) => {
      // Validate the candidate before modifying shared state.
      const candidate = HouseholdPlanSchema.parse(proposedHousehold);

      // Existing disruptions must still refer to valid entities.
      // If recovery validation fails, the current state is preserved.
      recoverPlan(candidate, disruptions);

      household = candidate;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                saved: true,
                household,
                activeDisruptions: disruptions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: result.recoveryStatus,
            recoveryStatus: result.recoveryStatus,
            legacyStatus: legacyStatus(result),
            disruptions,
            baselinePlan: result.originalPlan,
            currentPlan: result.recoveryPlan,
            complete: result.complete,
            recovered: result.recovered,
            unresolvedRisks: result.unresolvedRisks,
            taskOutcomes: result.taskOutcomes,
            summary: result.summary,
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

      // Avoid recording the same active disruption more than once.
      const alreadyActive = disruptions.some((active) => {
        if (active.type !== disruption.type) return false;

        if (
          active.type === "person_unavailable" &&
          disruption.type === "person_unavailable"
        ) {
          return active.personId === disruption.personId;
        }

        if (
          active.type === "resource_unavailable" &&
          disruption.type === "resource_unavailable"
        ) {
          return active.resourceId === disruption.resourceId;
        }

        if (
          active.type === "location_inaccessible" &&
          disruption.type === "location_inaccessible"
        ) {
          return active.locationId === disruption.locationId;
        }

        return false;
      });

      if (!alreadyActive) {
        disruptions = [...disruptions, disruption];
      }


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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: result.recoveryStatus,
            recoveryStatus: result.recoveryStatus,
            legacyStatus: legacyStatus(result),
            scheduledTasksValidation: result.recoveryPlan.validation,
            complete: result.complete,
            recovered: result.recovered,
            unresolvedRisks: result.unresolvedRisks,
            summary: result.summary,
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
    "reset_household_state",
    {
      description:
        "Restore the original fictional household model and clear simulated disruptions.",
    },
    async () => {
      household = structuredClone(baselineHousehold);
      disruptions = [];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                reset: true,
                household,
                disruptions,
              },
              null,
              2,
            ),
          },
        ],
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
