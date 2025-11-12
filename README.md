# 🌀 Cloudflare AI Site Builder

**An agentic AI application built entirely on Cloudflare Workers, Durable Objects, and Workflows.**

This project implements a multi-agent system that can **plan, generate, and ~~deploy~~**(Deployment part should work in theory but it never worked in my test😅. I don't have more time to dive down and understand what the chatbot's thinking) complete static websites to **Cloudflare Pages** from a single natural-language prompt.

> _"Build me a site that shows random cat pictures and lets me click a button to see a new one."_  
> → The system automatically plans the project, writes the HTML/CSS/JS, and attempts to deploy it to Cloudflare Pages.

---

## 🚀 Features

- **Multi-Agent Orchestration** — Planner, Coder, and Operator agents work together to translate natural language into working web projects.
- **Cloudflare-Native Integration** — Runs fully on:
  - 🧠 **Workers** – API endpoints and logic layer  
  - 🧩 **Durable Objects** / PartyServer – multi-agent coordination  
  - ⚙️ **Workflows** – task orchestration (`BuildSiteFlow`)  
  - 📦 **MCP Containers** – isolated code generation and file management  
  - 🌐 **Pages** – target deployment platform
- **AI Model Support** — Compatible with Cloudflare’s AI models (e.g. `gpt-oss-120b`) or external models like OpenAI GPT-4/5 for higher reasoning accuracy.
- **Automatic Deployment to Cloudflare Pages** — Builds, zips, and deploys static sites directly through Pages APIs.
- **Fail-Safe Design** — If deployment fails, the system gracefully falls back to:
  - Generating full project files inside the container  
  - Returning ready-to-run `wrangler` commands for manual deployment  

---

## 🧠 Architecture Overview

| Layer | Component | Description |
|-------|------------|-------------|
| **Workflow** | `BuildSiteFlow` | Orchestrates planning → coding → deployment; normalizes results |
| **Agents** | Planner / FullStack / Operator | Planner generates a structured plan; FullStack writes code via MCP; Operator handles deployment |
| **MCP Servers** | `containers.mcp`, `bindings.mcp`, custom local MCP | Provide filesystem and Cloudflare API tool access |
| **Cloudflare Services** | Workers, Durable Objects, Workflows, Pages | Execution, coordination, orchestration, and hosting layers |

### Simplified Flow

User prompt
↓
Planner Agent → development_plan (files, structure, commands)
↓
Full-Stack Agent → writes files in MCP container
↓
Operator Agent → packages & deploys to Cloudflare Pages
↓
Workflow normalizer → wraps result into a clear status


---

## 🧩 BuildSiteFlow Output

Every workflow run returns a normalized JSON structure:

```json
{
  "status": "built-not-deployed",
  "message": "Website files generated in container. Manual deployment required.",
  "siteRoot": "cat-picture-site/dist",
  "filesWritten": ["index.html", "styles.css", "script.js", "_headers"],
  "publicUrl": "",
  "manualCommands": [
    "npx wrangler pages dev ./public",
    "npx wrangler pages deploy ./public --project-name cat-picture-site"
  ],
  "plan": { "...": "planner JSON omitted" }
}
```

Possible Status Values
Status	Meaning
plan-only	Planner generated a valid project plan, but no files were written.
built-not-deployed	Files were successfully generated in the container, but auto-deploy did not complete.
deployed	Successful deployment to Cloudflare Pages; publicUrl is available.


# Run locally
```bash
npx wrangler dev
```

Don't forget to include your cloudflare account id and api token in .dev.vars to allow Ai deploying for you! 
(Even though it never worked for me😅)

Example .dev.vars
```text
# .dev.vars
OPENAI_API_KEY=xxx
CF_API_TOKEN=xxx
CF_ACCOUNT_ID=xxx
```


# Example API call
```bash
curl -X POST http://127.0.0.1:8787/workflows/build-site \
  -H "content-type: application/json" \
  -d '{"prompt": "Create a static website that shows random cat pictures using Cloudflare Pages."}'
```


# ⚙️ Technical Notes
Uses Model Context Protocol (MCP) for secure agent tool access.

Supports multi-round tool calling and sandboxed file writes in container environments.

Includes logic for duplicate file-write suppression and graceful degradation when models misbehave.

Integrates Cloudflare Bindings MCP server for KV, D1, R2, and Pages deployment APIs.

# 🧩 Future Improvements
Improve automatic deployment success rate by packaging all files before triggering Pages upload.

Replace Python-based zipping in the container with a native MCP deployment tool.

Integrate Cloudflare’s gpt-oss-120b model to eliminate reliance on external APIs.

Add frontend UI for visualizing generated projects and deployment logs.

📜 License
MIT License – feel free to reuse or modify for research, demos, or learning purposes.


