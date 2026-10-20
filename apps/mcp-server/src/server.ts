import { createServer } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { handler } from "./index.js";

const port = Number(process.env.PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new RangeError(`Invalid PORT value: ${process.env.PORT}`);
}

const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((req, res) => {
  if (req.url?.split("?")[0] !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (!validateHost(req, res) || !validateOrigin(req, res)) {
    return;
  }

  void nodeHandler(req, res);
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`Sahaay MCP server listening at http://127.0.0.1:${port}/mcp`);
});