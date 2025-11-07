import type {Env} from './worker/types';
import {ensureAgentsWarmed} from './worker/warmup';
import {handleRequest} from './worker/router';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    await ensureAgentsWarmed(env);
    return handleRequest(req, env, ctx);
  },
};

// Export Durable Object classes referenced by wrangler bindings
export {PlannerAgent} from './agents/PlannerAgent';
export {CoderAgent} from './agents/CoderAgent';
export {OperatorAgent} from './agents/OperatorAgent';
export {FullStackAgent} from './agents/FullStackAgent';
export {BuildSiteFlow} from './workflows/build_site'
