import {getServerByName, type Server} from 'partyserver';

import {publishMcpHandler} from '../mcp/publish';

import type {Env} from './types';

type RouteHandler = (req: Request, env: Env, ctx: ExecutionContext) =>
    Promise<Response>;

async function proxyToDo(
    req: Request, env: Env, binding: DurableObjectNamespace<Server>,
    room: string) {
  const server = await getServerByName(binding, room);
  return server.fetch(req);
}

function isPrefix(path: string, prefix: string) {
  return path.startsWith(prefix);
}

function json(data: any, init?: ResponseInit) {
  return new Response(
      JSON.stringify(data),
      {headers: {'content-type': 'application/json'}, ...init});
}

const handlers = {
  async oauthCallback(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    // Support variants with/without room in the path
    if (isPrefix(path, '/agents/planner-agent/callback/') ||
        isPrefix(path, '/agents/planner-agent/plan/callback/')) {
      return proxyToDo(req, env, env.CFA_PLAN_AGENT as any, 'plan');
    }
    if (isPrefix(path, '/agents/coder-agent/callback/') ||
        isPrefix(path, '/agents/coder-agent/code/callback/')) {
      return proxyToDo(req, env, env.CFA_CODE_AGENT as any, 'code');
    }
    if (isPrefix(path, '/agents/operator-agent/callback/') ||
        isPrefix(path, '/agents/operator-agent/op/callback/') ||
        isPrefix(path, '/agents/operator-agent/code/callback/')) {
      return proxyToDo(req, env, env.CFA_OP_AGENT as any, 'op');
    }
    if (isPrefix(path, '/agents/fullstack-agent/callback/') ||
        isPrefix(path, '/agents/fullstack-agent/full/callback/') ||
        isPrefix(path, '/agents/full-stack-agent/callback/') ||
        isPrefix(path, '/agents/full-stack-agent/full/callback/')) {
      return proxyToDo(req, env, env.CFA_FULL_AGENT as any, 'full');
    }
    return new Response('not found', {status: 404});
  },

  async ws(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (isPrefix(url.pathname, '/ws/plan'))
      return proxyToDo(req, env, env.CFA_PLAN_AGENT as any, 'plan');
    if (isPrefix(url.pathname, '/ws/code'))
      return proxyToDo(req, env, env.CFA_CODE_AGENT as any, 'code');
    if (isPrefix(url.pathname, '/ws/op'))
      return proxyToDo(req, env, env.CFA_OP_AGENT as any, 'op');
    if (isPrefix(url.pathname, '/ws/full'))
      return proxyToDo(req, env, env.CFA_FULL_AGENT as any, 'full');
    return new Response('not found', {status: 404});
  },

  async run(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run/plan')
      return proxyToDo(req, env, env.CFA_PLAN_AGENT as any, 'plan');
    if (url.pathname === '/run/code')
      return proxyToDo(req, env, env.CFA_CODE_AGENT as any, 'code');
    if (url.pathname === '/run/op')
      return proxyToDo(req, env, env.CFA_OP_AGENT as any, 'op');
    if (url.pathname === '/run/full')
      return proxyToDo(req, env, env.CFA_FULL_AGENT as any, 'full');
    return new Response('not found', {status: 404});
  },

  async mcpDebug(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/debug/mcp/planner') {
      const server = await getServerByName(env.CFA_PLAN_AGENT, 'plan');
      return server.fetch(new Request('https://mcp.local/debug', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({debug_mcp: true})
      }));
    }
    if (url.pathname === '/debug/mcp/coder') {
      const server = await getServerByName(env.CFA_CODE_AGENT, 'code');
      return server.fetch(new Request('https://mcp.local/debug', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({debug_mcp: true})
      }));
    }
    if (url.pathname === '/debug/mcp/operator') {
      const server = await getServerByName(env.CFA_OP_AGENT, 'op');
      return server.fetch(new Request('https://mcp.local/debug', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({debug_mcp: true})
      }));
    }
    if (url.pathname === '/debug/mcp/full') {
      const server = await getServerByName(env.CFA_FULL_AGENT, 'full');
      return server.fetch(new Request('https://mcp.local/debug', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({debug_mcp: true})
      }));
    }
    return new Response('not found', {status: 404});
  },

  async workflows(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/workflows/build-site' && req.method === 'POST') {
      try {
        const payload = await req.json().catch(() => ({}));
        const instance =
            await (env as any).BUILD_SITEFLOW.create({params: payload});
        // Poll briefly for completion and return output or status for client to
        // poll
        let status = await instance.status();
        const started = Date.now();
        const timeoutMs = 120_000;
        while (!['complete', 'errored', 'terminated'].includes(status.status)) {
          if (Date.now() - started > timeoutMs) break;
          await new Promise((r) => setTimeout(r, 500));
          status = await instance.status();
        }
        if (status.status === 'complete') {
          return json({
            instanceId: instance.id,
            output: status.output ??
                {
                  status
                }
          });
        }
        return json({
          instanceId: instance.id,
          status: status.status,
          error: status.error
        });
      } catch (err: any) {
        return json({error: String(err?.message ?? err)}, {status: 500});
      }
    }
    if (url.pathname === '/workflows/status' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({error: 'id is required'}, {status: 400});
      try {
        const instance = await (env as any).BUILD_SITEFLOW.get(id);
        const status = await instance.status();
        return json({id, ...status});
      } catch (err: any) {
        return json({error: String(err?.message ?? err)}, {status: 500});
      }
    }
    return new Response('not found', {status: 404});
  },

  async mcpAuth(req: Request, env: Env): Promise<Response> {
    // Query each agent's warmup endpoint to retrieve pending OAuth links
    try {
      const makeWarmup =
          async (binding: DurableObjectNamespace<Server>, room: string) => {
        try {
          const server = await getServerByName(binding, room);
          const res =
              await server.fetch(new Request('https://mcp.local/warmup', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({warmup: true}),
              }));
          const data: any = await res.json().catch(() => ({}));
          const pending =
              Array.isArray(data?.pendingAuth) ? data.pendingAuth : [];
          return pending;
        } catch (_) {
          return [];
        }
      };

      const [planner, coder, operator, fullstack] = await Promise.all([
        makeWarmup(env.CFA_PLAN_AGENT as any, 'plan'),
        makeWarmup(env.CFA_CODE_AGENT as any, 'code'),
        makeWarmup(env.CFA_OP_AGENT as any, 'op'),
        makeWarmup(env.CFA_FULL_AGENT as any, 'full'),
      ]);
      return json({planner, coder, operator, fullstack});
    } catch (err: any) {
      return json({error: String(err?.message ?? err)}, {status: 500});
    }
  },

  async mcpPublish(req: Request, env: Env, ctx: ExecutionContext):
      Promise<Response> {
        // Make env available to MCP tool callbacks during this request
        (globalThis as any).env = env;
        return publishMcpHandler(req, env, ctx);
      },

  async message(): Promise<Response> {
    return new Response(
        'Hello from Cloudflare AI Assistant!',
        {headers: {'content-type': 'text/plain; charset=utf-8'}});
  },
};

export async function handleRequest(
    req: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path.startsWith('/agents/')) return handlers.oauthCallback(req, env);
  if (path.startsWith('/ws/')) return handlers.ws(req, env);
  if (path.startsWith('/run/')) return handlers.run(req, env);
  if (path.startsWith('/debug/mcp/')) return handlers.mcpDebug(req, env);
  if (path.startsWith('/workflows/')) return handlers.workflows(req, env);
  if (path === '/mcp/auth') return handlers.mcpAuth(req, env);
  if (path.startsWith('/mcp/publish'))
    return handlers.mcpPublish(req, env, ctx);
  if (path === '/message') return handlers.message();

  // Fallback: serve static assets from ./public via ASSETS binding
  const assets = (env as any).ASSETS;
  if (assets && typeof assets.fetch === 'function') {
    return assets.fetch(req);
  }
  return new Response('not found', {status: 404});
}
