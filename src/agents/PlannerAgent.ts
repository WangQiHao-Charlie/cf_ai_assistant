import {type Server} from 'partyserver';

import {buildPlannerJsonSchema, buildPlannerPrompt} from '../worker/prompt';
import {Env} from '../worker/types';

import {BaseAgent, type BaseAgentEnv} from './BaseAgent';

export class PlannerAgent extends BaseAgent<Env> {
  constructor(state: DurableObjectState, env: Env) {
    const schemaDef = buildPlannerJsonSchema();
    super(state, env, {
      defaultModel: 'gpt-5',
      temperature: 1,
      systemPrompt: 'Return ONLY via function call arguments. No extra text.',
      getUserPrompt: (payload: any) =>
          buildPlannerPrompt(payload?.prompt ?? ''),
      tool: {
        name: schemaDef.name,
        description: 'Cloudflare-only planner output JSON.',
        parameters: schemaDef.schema as any,
      },
      mcp: {
        enabled: true,
        agentId: 'planner-agent',
        version: '0.0.0',
        serverUrl: 'https://docs.mcp.cloudflare.com/mcp',
      },
    });
  }
}
