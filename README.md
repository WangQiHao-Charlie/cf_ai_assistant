Cloudflare AI Assistant — Modularized

- Entry: `src/index.ts` delegates to `src/worker/warmup.ts` and `src/worker/router.ts`.
- Router: `src/worker/router.ts` handles all HTTP routes, MCP OAuth callbacks, DO proxying, workflows, and static assets.
- Warmup: `src/worker/warmup.ts` warms Planner/Coder/Operator DOs on first request with opt-in flags for Coder/Operator.
- Agents: `src/agents` contain `BaseAgent` and specializations. Shared MCP parsing helpers live in `src/agents/mcpUtils.ts`.
- Providers: `src/providers` implement chat model interfaces (Workers AI / OpenAI / Cached).
- MCP: `src/mcp/publish.ts` exposes Cloudflare publish tools via MCP.
- Workflows: `src/workflows/build_site.ts` orchestrates Planner → Coder → Operator via `/run/*` endpoints.

Notable changes
- Removed hard-coded OpenAI API key; `BaseAgent` now reads `OPENAI_API_KEY` from env when using OpenAI models.
- Extracted bulky MCP/text parsing helpers from `BaseAgent` to `src/agents/mcpUtils.ts`.
- Consolidated all route handling into a single router for clarity and easier maintenance.
- Removed an unused import in `CoderAgent`.

Common routes
- OAuth callbacks: `/agents/{planner-agent|coder-agent|operator-agent}/.../callback/*`
- WebSockets: `/ws/plan`, `/ws/code`, `/ws/op`
- One‑shot runs: `/run/plan`, `/run/code`, `/run/op`
- MCP debug: `/debug/mcp/{planner|coder|operator}`
- Workflows: `POST /workflows/build-site`, `GET /workflows/status?id=...`
- MCP publish: `/mcp/publish`
- Demo: `/message`

