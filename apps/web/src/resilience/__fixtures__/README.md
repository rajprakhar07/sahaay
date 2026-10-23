# Captured API fixtures

These JSON files are the **unmodified `data` payloads** returned by the real
Sahaay API (`apps/api` -> `apps/mcp-server` -> `@sahaay/engine`), not
hand-written examples. They are the demo household (Alex, Sam, Taylor) at
Stage 1.

| File | How it was captured |
|------|---------------------|
| `household.json` | `GET /api/household` after `POST /api/reset` |
| `plan-baseline.json` | `GET /api/plan` after reset |
| `plan-sam.json` | after `disrupt person_unavailable sam` |
| `plan-sam-taylor.json` | then `disrupt person_unavailable taylor` |
| `plan-sam-taylor-water.json` | then `disrupt resource_unavailable water` |
| `plan-home.json` | after reset, `disrupt location_inaccessible home` |
| `plan-baseline-after-reset.json` | `GET /api/plan` after the final reset |

`model.test.ts` asserts that the real engine reproduces every one of these
payloads exactly, so a change in engine or API output fails the tests instead
of silently drifting from the fixtures. To recapture: start the MCP server and
API, run the sequence above with `curl`, and save each `data` object.
