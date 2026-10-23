import { recoverPlan, type Disruption } from "@sahaay/engine";
import household from "../resilience/__fixtures__/household.json";

type EngineHousehold = Parameters<typeof recoverPlan>[0];

/**
 * Shape of the MCP `get_current_plan` response, computed by the REAL engine.
 * `model.test.ts` proves this reproduces the payloads captured from the real
 * API byte for byte, so UI tests exercise genuine planner behaviour.
 */
export function apiPlan(h: unknown, disruptions: Disruption[]) {
  const r = recoverPlan(h as EngineHousehold, disruptions);
  const legacy = r.complete ? "complete" : r.recovered ? "partial" : "failed";
  return JSON.parse(
    JSON.stringify({
      status: r.recoveryStatus,
      recoveryStatus: r.recoveryStatus,
      legacyStatus: legacy,
      disruptions,
      baselinePlan: r.originalPlan,
      currentPlan: r.recoveryPlan,
      complete: r.complete,
      recovered: r.recovered,
      unresolvedRisks: r.unresolvedRisks,
      taskOutcomes: r.taskOutcomes,
      summary: r.summary,
    }),
  );
}

export interface MockApi {
  fetch: typeof fetch;
  /** "METHOD /path" for every request, in order. */
  log: string[];
  disruptions: Disruption[];
  /** Make the next request to this path fail with the given status. */
  failNext(path: string, status: number, message: string): void;
  /** Delay every response, to hold a request in flight. */
  delayMs: number;
}

export function createMockApi(): MockApi {
  const h = structuredClone(household);
  const failures = new Map<string, { status: number; message: string }>();
  const api: MockApi = {
    log: [],
    disruptions: [],
    delayMs: 0,
    failNext(path, status, message) {
      failures.set(path, { status, message });
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      api.log.push(`${method} ${path}`);
      if (api.delayMs > 0) await new Promise((r) => setTimeout(r, api.delayMs));

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(status === 200 ? { data } : data), {
          status,
          headers: { "content-type": "application/json" },
        });

      const failure = failures.get(path);
      if (failure) {
        failures.delete(path);
        return json({ error: failure.message }, failure.status);
      }

      const plan = () => apiPlan(h, api.disruptions);

      // Like the real API server, these routes are matched by path only
      // (apps/api maps each path to one MCP tool, whatever the HTTP method).
      if (path === "/api/household") return json(h);
      if (path === "/api/plan") return json(plan());
      if (path === "/api/risks") return json(plan().unresolvedRisks);
      if (path === "/api/validate") {
        const p = plan();
        return json({
          status: p.status,
          recoveryStatus: p.recoveryStatus,
          legacyStatus: p.legacyStatus,
          scheduledTasksValidation: p.currentPlan.validation,
          complete: p.complete,
          recovered: p.recovered,
          unresolvedRisks: p.unresolvedRisks,
          summary: p.summary,
        });
      }
      if (path === "/api/rebuild") return json(plan());
      if (path === "/api/reset") {
        api.disruptions = [];
        return json({ ok: true });
      }
      if (method === "POST" && path === "/api/disrupt") {
        const body = JSON.parse(String(init?.body)) as { type: string; targetId: string };
        const key =
          body.type === "person_unavailable"
            ? "personId"
            : body.type === "resource_unavailable"
              ? "resourceId"
              : "locationId";
        api.disruptions = [
          ...api.disruptions,
          { type: body.type, [key]: body.targetId } as Disruption,
        ];
        return json({ ok: true });
      }
      return json({ error: `Unhandled ${method} ${path}` }, 404);
    }) as typeof fetch,
  };
  return api;
}
