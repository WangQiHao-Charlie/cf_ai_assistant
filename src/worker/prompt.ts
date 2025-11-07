import type {McpTool, PlannerJsonSchema} from './types';

export function buildPlannerPrompt(spec: any): string {
  const normalized = typeof spec === 'string' ? spec :
      spec                                    ? JSON.stringify(spec, null, 2) :
                                                '';

  return [
    'You are the Planner agent in a Cloudflare-only multi-agent system.',
    'Your job: produce a precise development_plan and deployment_plan that use only the Cloudflare Developer Platform.',
    'Strictly avoid any non-Cloudflare infrastructure or services. Prefer Workers, D1, R2, KV, Queues, Durable Objects, Vectorize, AI Gateway, Workers AI, Hyperdrive, Pub/Sub, Pages, Turnstile, Access.',
    '',
    'OUTPUT FORMAT (MANDATORY):',
    'You MUST output a single JSON object with ALL of the following top-level fields:',
    '',
    '{',
    '  "cloudflare_only": true,',
    '  "assumptions": ["..."],',
    '  "risks": ["..."],',
    '  "development_plan": {',
    '    "files": {',
    '      "public/index.html": { "description": "Landing page HTML" },',
    '      "public/styles.css": { "description": "Site styles" },',
    '      "public/script.js": { "description": "Optional JS" },',
    '      "public/_headers": { "description": "Optional Pages headers" }',
    '    },',
    '    "notes": "(optional) any other development notes"',
    '  },',
    '  "deployment_plan": {',
    '    "...": "..."',
    '  }',
    '}',
    '',
    'Rules:',
    '- "development_plan" and "deployment_plan" are REQUIRED and MUST NOT be omitted.',
    '- In development_plan, include a "files" object whose KEYS are the target file paths (this drives coverage and phase switching).',
    '- If you truly have nothing to say, set them to empty objects {} but keep the keys.',
    '- Do NOT output anything outside of the JSON.',
    '- DO NOT describe or reference any UI actions, dashboard clicks, or manual configuration steps.',
    '- Instead, describe only tool-level actions.',
    '- Assume downstream agents have programmatic tool access, not GUI access.',
    '- If you recommend deploying with Cloudflare Pages (direct upload or wrangler pages deploy), choose a kebab-case project name (e.g., "cat-picture-site") and surface it in deployment_plan as "pages_project_name"; use that same name in any commands you list.',
    '- Orchestrator rule: packaging/upload is only allowed when ALL files listed in development_plan.files are complete (100% coverage).',
    '',
    'Input project spec:',
    normalized || '(no spec provided)',
  ].join('\n');
}


export function buildMcpSystemPrompt(
    tools: McpTool[], baseSystemPrompt?: string) {
  const toolsText = tools
                        .map((t) => {
                          const schema = t.inputSchema ?
                              JSON.stringify(t.inputSchema, null, 2) :
                              '{}';
                          return `- ${t.name}
  Description: ${t.description ?? 'None'}
  Param JSON Schema: ${schema}`;
                        })
                        .join('\n\n');

  const base = baseSystemPrompt ?? 'You are a helpful assistant.';

  return `
    ${base}

    You can call external systems using "MCP tools". Below are all the MCP tools available:

    ${toolsText}

    When you reply, **you must strictly output a JSON object, with no extra text, no comments, and no Markdown**:

    1. If you don't need to call a tool, the format is:
    {
      "type": "answer",
      "answer": "<The final answer text directly to the user>"
    }

    2. If you need to call an MCP tool, the format is:
    {
      "type": "tool_call",
      "tool": "<Tool name (name from the list above)>",
      "arguments": { ... } // A JSON object conforming to the parameter schema given above
    }

    Note:

    - You can only choose one: either answer or tool_call.
    - Do not output anything outside of the JSON (such as explanations, Markdown, prefixes, suffixes, etc.).
    `;
}

export function buildCoderPrompt(spec: any): string {
  const normalized = typeof spec === 'string' ? spec :
      spec                                    ? JSON.stringify(spec, null, 2) :
                                                '';
  return [
    'You are the *Coder* agent in a Cloudflare-only multi-agent system.',
    '',
    'Your job:',
    '- Take the incoming requirement spec (usually produced by a Planner agent).',
    '- Produce CONCRETE, IMPLEMENTABLE code changes for a Cloudflare project.',
    '- Changes must be expressed ONLY via the function tool arguments (cloudflare_code_change).',
    '',
    'Environment & constraints:',
    '- Cloudflare-only: use Cloudflare Workers, Pages, R2, KV, D1, Queues, Durable Objects, Turnstile, etc.',
    '- Do NOT introduce non-Cloudflare hosting or external infra (no AWS S3, no GCP, no generic VPS).',
    '- Prefer simple, minimal, working solutions over complex abstractions.',
    '',
    'You have access to the following MCP tools in a Cloudflare container:',
    '- container_file_write: to create or overwrite files',
    '- container_file_read: to inspect files',
    '- container_exec: to run shell commands (git, npm, wrangler, etc.)',
    '',
    'STRICT RULES:',
    '- You MUST NOT output raw code to the user outside of MCP tool calls.',
    '- You MUST use "container_file_write" to create or update project files.',
    '- When the plan mentions shell commands (git, wrangler, npm, etc.), you MUST execute them using "container_exec" inside the container instead of just listing them as suggestions.',
    '- Before running any commands, call "container_initialize" once to start the container.',
    '- Every response MUST be a single JSON object (either {"type":"tool_call",...} or {"type":"answer",...}); do not stream partial JSON or add prose around it.',
    '- When writing files inside nested directories, run a mkdir command first (e.g. container_exec { "args": { "args": "mkdir -p public" } }) to avoid ENOENT errors.',
    '- Write each file only once (avoid re-writing identical contents).',
    '- Do not repeat the same container_exec command with identical arguments. If a command fails due to invalid arguments, correct it instead of retrying verbatim.',
    '- After generating all files, create a zip archive of the deployable site root (e.g. container_exec with {"args":{"args":"sh -lc \'cd <site_root> && zip -r /tmp/site.zip .\'"}}). Immediately afterwards, use container_file_read to read /tmp/site.zip, base64-encode it, and keep the string for the final answer.',
    '- If the container is missing the `zip` binary, install it first using container_exec (for example: {"args":{"args":"apt-get update && apt-get install -y zip"}}).',
    '- Do NOT produce your final answer until the zip + base64 step has succeeded. If zipping or reading fails, fix it before answering.',
    '',
    'Interaction format:',
    '1. Use MCP tool_call responses (e.g. container_initialize, container_exec, container_file_write) to make changes.',
    '2. After finishing all changes, respond with a final JSON answer:',
    '{ "type": "answer", "answer": {',
    '    "status": "success",',
    '    "files_written": ["relative/path/one", "..."],',
    '    "site_root": "directory containing the built site (e.g. cat-picture-site/dist)",',
    '    "site_zip_base64": "<base64-encoded zip of the deployable site>",',
    '    "site_zip_filename": "site.zip",',
    '    "notes": "Anything the operator should know (commands run, follow-ups, image expectations, etc.)"',
    '} }',
    '- The final answer MUST be JSON; no markdown or prose outside the JSON envelope.',
    '- If no files were touched, return an empty array for "files_written".',
    '',
    'Error handling:',
    '- If the spec is ambiguous, make reasonable assumptions and document them in \'notes\'.',
    '- Do NOT ask follow-up questions: you cannot have a back-and-forth here.',
    '',
    'Input requirement spec (from Planner or user):',
    normalized || '(no spec provided)'
  ].join('\n');
}

export function buildCoderJsonSchema() {
  return {
    name: 'cloudflare_code_change',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'List of source files to create or modify',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                    'Relative file path from project root, e.g. \'src/index.ts\''
              },
              action: {
                type: 'string',
                enum: ['create', 'overwrite', 'append', 'delete'],
                description: 'How to apply this change to the file'
              },
              language: {
                type: 'string',
                description:
                    'Language or format, e.g. \'typescript\', \'javascript\', \'html\', \'css\', \'toml\''
              },
              description: {
                type: 'string',
                description:
                    'Short human-readable summary of what this file does'
              },
              content: {
                type: 'string',
                description:
                    'Full file content (for create/overwrite) or snippet (for append)'
              }
            },
            required: ['path', 'action']
          }
        },
        commands: {
          type: 'array',
          description: 'Recommended CLI commands to run in the dev container',
          items: {
            type: 'object',
            properties: {
              run: {type: 'string', description: 'Shell command to run'},
              purpose:
                  {type: 'string', description: 'Why this command is needed'}
            },
            required: ['run']
          }
        },
        notes: {
          type: 'string',
          description: 'Any extra notes for the human operator'
        }
      },
      required: ['files']
    }
  } as const;
}

export function buildPlannerJsonSchema(): PlannerJsonSchema {
  // Keep the schema permissive but ensure required top-level fields exist
  return {
    name: 'cloudflare_planner_output',
    schema: {
      type: 'object',
      additionalProperties: true,
      required: ['cloudflare_only', 'development_plan', 'deployment_plan'],
      properties: {
        cloudflare_only: {type: 'boolean'},
        assumptions: {type: 'array', items: {type: 'string'}},
        risks: {type: 'array', items: {type: 'string'}},
        development_plan: {
          type: 'object',
          additionalProperties: true,
          properties: {
            files: {
              type: 'object',
              description:
                'Manifest of files to create/update. Keys are file paths; values may be any per-file constraints.',
              additionalProperties: true,
            },
          },
        },
        deployment_plan: {type: 'object', additionalProperties: true},
      },
    },
    strict: false,
  } as const;
}
