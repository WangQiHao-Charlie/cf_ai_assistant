import type {McpTool, PlannerJsonSchema} from './types';


export function buildPlannerPrompt(spec: any): string {
  const normalized = typeof spec === 'string' ? spec :
      spec                                    ? JSON.stringify(spec, null, 2) :
                                                '';
  return [
    'You are the Planner agent in a Cloudflare-only multi-agent system.',
    'Your job: produce a precise development_plan and deployment_plan that use only the Cloudflare Developer Platform.',
    'Strictly avoid any non-Cloudflare infrastructure or services. Prefer Workers, D1, R2, KV, Queues, Durable Objects, Vectorize, AI Gateway, Workers AI, Hyperdrive, Pub/Sub, Pages, Turnstile, Access.',
    'Provide the minimum applicable plan; avoid overcomplicating the problem.',
    'The output MUST be pure JSON. Do not include explanations outside JSON.',
    '', 'Input project spec:', normalized || '(no spec provided)'
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
    '- You MUST NOT output code or file contents directly to the user.',
    '- You MUST use "container_file_write" to create or update project files.',
    '- When the plan mentions shell commands (git, wrangler, npm, etc.), you MUST execute them using "container_exec" inside the container instead of just listing them as suggestions.',
    '- Before running any commands, call "container_initialize" once to start the container.',
    '',
    'When you reply, you must output ONLY MCP tool calls as JSON, never free-form text.',
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
        development_plan: {type: 'object', additionalProperties: true},
        deployment_plan: {type: 'object', additionalProperties: true},
      },
    },
    strict: false,
  } as const;
}
