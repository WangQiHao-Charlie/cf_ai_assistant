import {getServerByName, type Server} from 'partyserver';

import {WorkersAIChatModel} from '../providers/WorkersAIProvider';
import {buildCoderPrompt, buildCoderJsonSchema} from '../worker/prompt';
import {Env} from '../worker/types';

import {BaseAgent} from './BaseAgent';


export class CoderAgent extends BaseAgent<Env> {
  constructor(state: DurableObjectState, env: Env) {
    const schemaDef = buildCoderJsonSchema();
    super(state, env, {
      defaultModel: '@cf/qwen/qwen2.5-coder-32b-instruct',
      temperature: 0,
      systemPrompt: 'Return ONLY codes. No extra text.',
      getUserPrompt: (payload: any) => buildCoderPrompt(payload?.prompt ?? ''),
      tool: {
        name: schemaDef.name,
        description: 'Cloudflare-only coder output code.',
        parameters: schemaDef.schema as any,
      },
      mcp: {
        enabled: true,
        agentId: 'coder-agent',
        version: '0.0.0',
        serverUrl: 'https://containers.mcp.cloudflare.com/mcp',
      },
    });
    // Use Cloudflare Workers AI provider for the coder agent
    this.chatModel = new WorkersAIChatModel('');
  }
}
