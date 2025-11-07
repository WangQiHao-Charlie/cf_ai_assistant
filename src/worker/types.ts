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
  CFA_OP_AGENT:
      DurableObjectNamespace<Server<unknown, Record<string, unknown>>>;
  CFA_FULL_AGENT:
      DurableObjectNamespace<Server<unknown, Record<string, unknown>>>;
  // Workflows binding for BuildSiteFlow
  BUILD_SITEFLOW: any;
  // Account info and token for publishing MCP
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
};



export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
};
