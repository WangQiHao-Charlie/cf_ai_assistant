import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {createMcpHandler} from 'agents/mcp';

type CfJson<T = unknown> = {
  success: boolean;
  errors?: Array<{code?: number; message?: string}>;
  messages?: Array<{code?: number; message?: string}>;
  result?: T;
};

async function cfApi(
    env: any, method: string, path: string, body?: any,
    headers?: Record<string, string>) {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const token = env?.CF_API_TOKEN || env?.CF_API_KEY || env?.CLOUDFLARE_API_TOKEN;
  const h: Record<string, string> = {
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
    'Content-Type': 'application/json',
    ...headers,
  };
  const init: RequestInit = {
    method,
    headers: h,
  } as any;
  if (body !== undefined && body !== null)
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  console.log('[publish MCP] cfApi request', method, path);
  const res = await fetch(url, init);
  const text = await res.text();
  let json: CfJson|null = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */
  }
  if (!res.ok) {
    return {ok: false, status: res.status, text, json};
  }
  return {ok: true, status: res.status, text, json};
}

function okText(text: string) {
  return {content: [{type: 'text' as const, text}]};
}

const server = new McpServer({name: 'cf-publish', version: '0.0.1'});

// Create a Pages project
server.tool(
    'pages_project_create',
    'Create a Cloudflare Pages project in the given account.', {
      type: 'object',
      properties: {
        name: {type: 'string', description: 'Project name (DNS-safe)'},
        production_branch:
            {type: 'string', description: 'Default branch', default: 'main'},
      },
      required: ['name'],
    },
    async (args: any, extra: any) => {
      console.log('[publish MCP] pages_project_create args', args);
      const env = extra?.env ?? (globalThis as any).env;
      const accountId = env.CF_ACCOUNT_ID;
      if (!accountId) return okText('Missing CF_ACCOUNT_ID env.');
      const r =
          await cfApi(env, 'POST', `/accounts/${accountId}/pages/projects`, {
            name: args?.name,
            production_branch: args?.production_branch ?? 'main',
          });
      return okText(
          JSON.stringify(r.json ?? {status: r.status, body: r.text}, null, 2));
    });

// Prepare a direct upload for Pages: returns upload id and upload_url
server.tool(
    'pages_upload_prepare',
    'Create a direct upload URL for a Pages project. Use pages_upload_put to upload the zip, then pages_deploy_from_upload to deploy.',
    {
      type: 'object',
      properties: {
        project: {type: 'string', description: 'Pages project name'},
      },
      required: ['project'],
    },
    async (args: any, extra: any) => {
      console.log('[publish MCP] pages_upload_prepare args', args);
      const env = extra?.env ?? (globalThis as any).env;
      const accountId = env.CF_ACCOUNT_ID;
      if (!accountId) return okText('Missing CF_ACCOUNT_ID env.');
      const r = await cfApi(
          env, 'POST',
          `/accounts/${accountId}/pages/projects/${
              encodeURIComponent(args.project)}/uploads`,
          undefined);
      return okText(
          JSON.stringify(r.json ?? {status: r.status, body: r.text}, null, 2));
    });

// PUT the zip bytes to a given upload_url (from pages_upload_prepare)
server.tool(
    'pages_upload_put',
    'Upload a base64-encoded zip file to the provided upload_url from pages_upload_prepare.',
    {
      type: 'object',
      properties: {
        upload_url: {type: 'string'},
        zip_base64:
            {type: 'string', description: 'Base64-encoded .zip of static site'},
      },
      required: ['upload_url', 'zip_base64'],
    },
    async (args: any) => {
      console.log(
          '[publish MCP] pages_upload_put upload_url', args?.upload_url,
          'zip_base64 length',
          typeof args?.zip_base64 === 'string' ? args.zip_base64.length : 0);
      const bin = Uint8Array.from(atob(args.zip_base64), c => c.charCodeAt(0));
      const res = await fetch(args.upload_url, {
        method: 'PUT',
        headers: {'Content-Type': 'application/zip'},
        body: bin,
      } as any);
      const text = await res.text();
      return okText(JSON.stringify(
          {ok: res.ok, status: res.status, body: text}, null, 2));
    });

// Create a deployment from a prepared upload id
server.tool(
    'pages_deploy_from_upload',
    'Create a deployment referencing an upload id returned by pages_upload_prepare.',
    {
      type: 'object',
      properties: {
        project: {type: 'string'},
        upload_id: {type: 'string'},
        branch: {type: 'string', default: 'main'},
      },
      required: ['project', 'upload_id'],
    },
    async (args: any, extra: any) => {
      console.log('[publish MCP] pages_deploy_from_upload args', args);
      const env = extra?.env ?? (globalThis as any).env;
      const accountId = env.CF_ACCOUNT_ID;
      if (!accountId) return okText('Missing CF_ACCOUNT_ID env.');
      const body = {
        deployment_trigger: {type: 'ad_hoc'},
        branch: args?.branch ?? 'main',
        source: {type: 'direct_upload', upload_id: args.upload_id},
      };
      const r = await cfApi(
          env, 'POST',
          `/accounts/${accountId}/pages/projects/${
              encodeURIComponent(args.project)}/deployments`,
          body);
      return okText(
          JSON.stringify(r.json ?? {status: r.status, body: r.text}, null, 2));
    });

// Deploy a simple Worker script (module)
server.tool(
    'workers_deploy_script', 'Deploy a Worker script using the Modules syntax.',
    {
      type: 'object',
      properties: {
        name: {type: 'string'},
        content: {type: 'string', description: 'JavaScript module source code'},
      },
      required: ['name', 'content'],
    },
    async (args: any, extra: any) => {
      console.log(
          '[publish MCP] workers_deploy_script name', args?.name,
          'content length',
          typeof args?.content === 'string' ? args.content.length : 0);
      const env = extra?.env ?? (globalThis as any).env;
      const accountId = env.CF_ACCOUNT_ID;
      if (!accountId) return okText('Missing CF_ACCOUNT_ID env.');
      const path = `/accounts/${accountId}/workers/scripts/${
          encodeURIComponent(args.name)}`;
      const r = await cfApi(
          env, 'PUT', path, args.content,
          {'Content-Type': 'application/javascript+module'});
      return okText(
          JSON.stringify(r.json ?? {status: r.status, body: r.text}, null, 2));
    });

const basePublishHandler = createMcpHandler(server, {route: '/mcp/publish'});

export const publishMcpHandler =
    async (req: Request, env: any, ctx: ExecutionContext) => {
  console.log(
      '[publish MCP] incoming', req.method, req.headers.get('content-type'),
      req.url);
  const start = Date.now();
  const res = await basePublishHandler(req, env, ctx);
  console.log(
      '[publish MCP] response status', res.status, 'duration',
      Date.now() - start, 'ms');
  return res;
};
