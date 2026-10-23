# Stage 4: End-to-end resilience validation

The MCP smoke test exercises the running Sahaay MCP server over Streamable HTTP. It verifies tool discovery, baseline planning, helper reassignment after a disruption, idempotent repeated disruptions, honest validation of unresolved risks, invalid-target state preservation, resource and inaccessible-location failures, and restoration of the baseline household.

## Run locally

Install the repository dependencies first:

```bash
npm ci
```

In terminal 1, start the MCP server:

```bash
npm run dev --workspace=@sahaay/mcp-server
```

In terminal 2, run the end-to-end smoke test:

```bash
npm run test:e2e --workspace=@sahaay/mcp-server
```

The test connects to `http://127.0.0.1:3001/mcp`; keep the server running while it executes. The script resets the simulated scenario at the beginning and restores the baseline household at the end. It uses fictional demo data only.

## Other project checks

From the repository root:

```bash
npm test
npm run typecheck:all
npm run build
```

These checks are separate from the running-server MCP end-to-end smoke test.
