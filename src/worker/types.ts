// Environment bindings and shared types for the Planner agent
import {type Server} from 'partyserver';

import {BaseAgentEnv} from '../agents/BaseAgent';

export interface PlannerJsonSchema {
  name: string;
  schema: any;
  strict?: boolean;
}


export type Env = BaseAgentEnv&{
  CFA_PLAN_AGENT:
      DurableObjectNamespace<Server<unknown, Record<string, unknown>>>;
  CFA_CODE_AGENT:
      DurableObjectNamespace<Server<unknown, Record<string, unknown>>>;
};



export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;  // 某些版本会在这里带上
};
