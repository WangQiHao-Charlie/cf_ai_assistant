import {getServerByName, type Server} from 'partyserver';

import {WorkersAIChatModel} from '../providers/WorkersAIProvider';
import {buildCoderJsonSchema, buildCoderPrompt} from '../worker/prompt';
import {Env} from '../worker/types';

import {BaseAgent} from './BaseAgent';


export class CoderAgent extends BaseAgent<Env> {
  constructor(state: DurableObjectState, env: Env) {
    const schemaDef = buildCoderJsonSchema();
    super(state, env, {
      defaultModel: 'gpt-5-mini',
      temperature: 0,
      systemPrompt: 'Return ONLY codes. No extra text.',
      getUserPrompt: (payload: any) => buildCoderPrompt(payload?.prompt ?? ''),
      // Include MCP tool call logs in the response for visibility
      includeMcpLogsInResponse: true,
      // Require minimal container tools so we don't "hallucinate" tool calls
      // when MCP isn't connected/authorized.
      requiredTools: [
        'container_initialize',
        'container_exec',
        'container_file_read',
        'container_file_write',
      ],
      tool: {
        name: schemaDef.name,
        description: 'Cloudflare-only coder output code.',
        parameters: schemaDef.schema as any,
      },
      requireSiteZipBase64: true,
      mcp: [
        {
          enabled: true,
          agentId: 'coder-agent',
          version: '0.0.0',
          serverUrl: 'https://containers.mcp.cloudflare.com/mcp',
        },
        {
          enabled: true,
          agentId: 'coder-agent',
          version: '0.0.0',
          serverUrl: 'https://bindings.mcp.cloudflare.com/mcp',
        },
        {
          enabled: true,
          agentId: 'coder-agent',
          version: '0.0.0',
          serverUrl: `${env.SERVER_HOST}/mcp/publish`,
        },
      ],
    });
  }
}
