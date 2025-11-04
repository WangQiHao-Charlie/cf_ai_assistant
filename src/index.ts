import {getServerByName, type Server} from 'partyserver';

import {Env} from './worker/types';

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);

    // Handle MCP OAuth callbacks and forward to the right Durable Object.
    // Note: callback path includes serverId suffix. Match by prefix.
    if (url.pathname.startsWith('/agents/planner-agent/callback/')) {
      const server = await getServerByName(env.CFA_PLAN_AGENT, 'plan');
      return server.fetch(req);
    }
    if (url.pathname.startsWith('/agents/coder-agent/callback/')) {
      const server = await getServerByName(env.CFA_CODE_AGENT, 'code');
      return server.fetch(req);
    }
    // Some MCP servers include the DO room/name segment in the callback path
    if (url.pathname.startsWith('/agents/planner-agent/plan/callback/')) {
      const server = await getServerByName(env.CFA_PLAN_AGENT, 'plan');
      return server.fetch(req);
    }
    if (url.pathname.startsWith('/agents/coder-agent/code/callback/')) {
      const server = await getServerByName(env.CFA_CODE_AGENT, 'code');
      return server.fetch(req);
    }

    if (url.pathname.startsWith('/ws/plan')) {
      const server = await getServerByName(env.CFA_PLAN_AGENT, 'plan');
      return server.fetch(req);
    }

    if (url.pathname.startsWith('/ws/code')) {
      const server = await getServerByName(env.CFA_CODE_AGENT, 'code');
      return server.fetch(req);
    }

    return new Response('not found', {status: 404});
  },
};

// Export Durable Object classes referenced by wrangler bindings
export {PlannerAgent} from './agents/PlannerAgent';
export {CoderAgent} from './agents/CoderAgent';
export {BuildSiteFlow} from './workflows/build_site'
