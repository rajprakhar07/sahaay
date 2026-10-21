
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = Number(process.env.API_PORT ?? 3002);
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp";

const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

const routes: Record<string, string> = {
  "/api/household": "get_household_state",
  "/api/plan": "get_current_plan",
  "/api/rebuild": "rebuild_response_plan",
  "/api/validate": "validate_plan",
  "/api/risks": "get_unresolved_risks",
  "/api/reset": "reset_scenario"
};

function respond(res: any, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function readBody(req: any): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 16_384) throw new Error("Request body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function callMcp(name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "sahaay-web-api", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

  try {
    await client.connect(transport);
    const result: any = await client.callTool({
      name,
      arguments: args
    });

    if (result.isError) {
      throw new Error(
        result.content?.map((item: any) => item.text ?? "").join("\n")
        || `MCP tool ${name} failed`
      );
    }

    const text = result.content
      ?.filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");

    if (!text) return result.structuredContent ?? result;

    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (origin && !allowedOrigins.has(origin)) {
    return respond(res, 403, { error: "Origin not allowed" });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin ?? "http://127.0.0.1:5173",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "vary": "Origin"
    });
    return res.end();
  }

  const path = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`
  ).pathname;

  if (path === "/api/health") {
    return respond(res, 200, { ok: true, mcpUrl: MCP_URL });
  }

  try {
    
    if (path === "/api/household/update") {
      if (req.method !== "POST") {
        return respond(res, 405, { error: "POST required" });
      }

      const body = await readBody(req);

      if (
        !body.household ||
        typeof body.household !== "object" ||
        Array.isArray(body.household)
      ) {
        return respond(res, 400, {
          error: "A household object is required."
        });
      }

      const data = await callMcp("update_household_state", {
        household: body.household
      });

      res.setHeader(
        "access-control-allow-origin",
        origin ?? "http://127.0.0.1:5173"
      );
      return respond(res, 200, { data });
    }

    if (path === "/api/household/reset") {
      if (req.method !== "POST") {
        return respond(res, 405, { error: "POST required" });
      }

      const data = await callMcp("reset_household_state");

      res.setHeader(
        "access-control-allow-origin",
        origin ?? "http://127.0.0.1:5173"
      );
      return respond(res, 200, { data });
    }

    if (path === "/api/disrupt") {
      if (req.method !== "POST") {
        return respond(res, 405, { error: "POST required" });
      }

      const body = await readBody(req);
      const validTypes = [
        "person_unavailable",
        "resource_unavailable",
        "location_inaccessible"
      ];

      if (
        !validTypes.includes(body.type) ||
        typeof body.targetId !== "string" ||
        !body.targetId.trim()
      ) {
        return respond(res, 400, {
          error: "Choose a valid disruption type and target."
        });
      }

      const data = await callMcp("simulate_disruption", {
        type: body.type,
        targetId: body.targetId.trim()
      });

      res.setHeader(
        "access-control-allow-origin",
        origin ?? "http://127.0.0.1:5173"
      );
      return respond(res, 200, { data });
    }

    const tool = routes[path];
    if (!tool) return respond(res, 404, { error: "Not found" });

    if (req.method !== "GET" && req.method !== "POST") {
      return respond(res, 405, { error: "Method not allowed" });
    }

    const data = await callMcp(tool);
    res.setHeader(
      "access-control-allow-origin",
      origin ?? "http://127.0.0.1:5173"
    );
    return respond(res, 200, { data });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unexpected API error";

    console.error(`[api] ${path}: ${message}`);
    return respond(res, 502, {
      error: message,
      hint: "Confirm the MCP server is running on port 3001."
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Sahaay API listening on http://127.0.0.1:${PORT}`);
  console.log(`MCP endpoint: ${MCP_URL}`);
});
