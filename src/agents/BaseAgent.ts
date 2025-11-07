import {Agent, Connection, ConnectionContext, WSMessage} from 'agents';
import type OpenAI from 'openai';

import {ChatResponse, IChatModel} from '../providers/AIProviderInterface';
import {OpenAIChatModel} from '../providers/OpenAIProvider';
import {WorkersAIChatModel} from '../providers/WorkersAIProvider';
import {buildMcpSystemPrompt} from '../worker/prompt';
import {McpTool} from '../worker/types';

import {coerceToolArgs, collectToolResultText, extractJsonObjectsFromText, extractToolCalls, inferSiteRoot, tryParseJsonWithComments, tryExtractTruncatedToolCall,} from './mcpUtils';

export type BaseAgentEnv = {
  OPENAI_API_KEY: string; SERVER_HOST: string;
  MODEL?: string;
  // Optional: Bearer token for Cloudflare Access-protected MCP servers
  MCP_BEARER_TOKEN?: string;
};

export type ToolFunctionSpec = {
  name: string; description: string; parameters: any;
};

export type BaseAgentOptions = {
  // Build the user message content from inbound payload
  getUserPrompt: (payload: any) => string;
  // Optional system message
  systemPrompt?: string;
  // Optional tool function schema (e.g., JSON schema output)
  tool?: ToolFunctionSpec;
  // OpenAI defaults
  defaultModel?: string;
  temperature?: number;
  // When true, attach MCP tool call logs (name, args, results)
  // to the returned ChatResponse.json as `mcp_logs`.
  includeMcpLogsInResponse?: boolean;
  // Optional custom handler for raw model response
  onModelResponse?: (args: {
                   response: Awaited<
                       ReturnType<OpenAI['chat']['completions']['create']>>;
                   connection: Connection;
                 }) => Promise<void>;
  // Optional MCP settings (single or multiple servers)
  mcp?: ({
    enabled?: boolean;
    agentId: string;
    version?: string;
    serverUrl: string
  }|Array<{
    enabled?: boolean; agentId: string;
    version?: string; serverUrl: string
  }>);
  // Optional list of MCP tool names that should be available before model
  // execution
  requiredTools?: string[];
  // When true, require final answer to include site_zip_base64 (for Coder)
  requireSiteZipBase64?: boolean;
  // Optional: abort the round (finalize early) when duplicate
  // container_file_write skips in a single round reach this threshold.
  // Useful for FullStack to rapidly fallback to other agents.
  abortOnDuplicateSkipsThreshold?: number;
  // Optional: abort the round (finalize early) when duplicate
  // container_exec command skips in a single round reach this threshold.
  abortOnDuplicateCommandsThreshold?: number;


};


export class BaseAgent<Env extends BaseAgentEnv> extends Agent<Env> {
  protected options: BaseAgentOptions;
  private mcpServerId?: string;
  private mcpServerIds: string[] = [];
  private pendingMcpAuth: Record<string, string> = {};
  private mcpServerMeta: Record<string, {serverUrl: string}> = {};
  protected chatModel: IChatModel;
  mcpMgr: any;
  private connectedServerIds: Set<string> = new Set();
  private reconnectingIds: Set<string> = new Set();

  constructor(state: DurableObjectState, env: Env, options: BaseAgentOptions) {
    super(state, env);
    this.options = options;
    this.mcpMgr = this.mcp;
    this.mcp.onConnected?.((serverId: string) => {
      // Persist the connected serverId to avoid early tool-call race
      this.mcpServerId = serverId;
      this.connectedServerIds.add(serverId);
      console.log(`MCP connected: ${serverId}`);
    });
    // Ensure OAuth callback clears pending auth and reconnects, even when the
    // library handles the HTTP callback before our onRequest.
    try {
      this.mcp.configureOAuthCallback?.({
        customHandler: (result: any) => {
          if (result?.authSuccess && result?.serverId) {
            try {
              this.sql`UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ${
                  result.serverId}`;
            } catch (_) {
            }
            this.mcp.establishConnection(result.serverId)
                .catch((err: any) => {
                  console.error('MCP reconnect error after OAuth:', err);
                })
                .finally(() => {
                  const meta = this.mcpServerMeta[result.serverId];
                  if (meta) delete this.pendingMcpAuth[meta.serverUrl];
                });
            return new Response('OAuth authorized. You can close this tab.');
          }
          return new Response(
              `OAuth error: ${result?.authError ?? 'unknown'}`, {status: 400});
        }
      } as any);
    } catch (_) {
      // no-op if not supported
    }
    if (options.defaultModel?.includes('gpt')) {
      this.chatModel = new OpenAIChatModel(this.env.OPENAI_API_KEY || '');
    } else {
      this.chatModel = new WorkersAIChatModel('');
    }
  }

  private async listMcpTools(): Promise<McpTool[]> {
    // Use the built-in MCP manager from the Agent
    const toolsResult: any = await this.mcp.listTools();
    const tools: McpTool[] =
        Array.isArray(toolsResult) ? toolsResult : toolsResult?.tools ?? [];
    console.log(
        '[MCP] listTools ->',
        tools.map((t) => `${t.name}@${t.serverId ?? 'unknown'}`));
    return tools;
  };

  // Removed: do not wait for OAuth/tool availability to avoid blocking

  private normalizeToolName(name?: string): string {
    if (!name) return '';
    // remove common separators and plural variations
    const stripped = name.toLowerCase().replace(/[\._\-\s]/g, '');
    // unify some common synonyms
    return stripped
        .replace('fileslist', 'filelist')
        .replace('listfiles', 'filelist')
        .replace('ls', 'list');
  }

  private findMissingRequiredTools(tools: McpTool[]): string[] {
    const required = this.options.requiredTools ?? [];
    if (!required.length) return [];
    const available = new Set(tools.map((t) => this.normalizeToolName(t.name)));
    return required
        .map((n) => this.normalizeToolName(n))
        .filter((name) => !available.has(name));
  }

  private resolveTool(
      tools: McpTool[], requestedName: string, requestedArgs?: any):
      | {name: string; serverId: string}
      | {emulate: true; name: string; with: {name: string; serverId: string; args: any}} {
    const exact = tools.find((t) => t.name === requestedName);
    if (exact?.serverId) return {name: exact.name, serverId: exact.serverId};

    const normReq = this.normalizeToolName(requestedName);
    const byNorm = tools.find((t) => this.normalizeToolName(t.name) === normReq);
    if (byNorm?.serverId)
      return {name: byNorm.name, serverId: byNorm.serverId};

    // Special-case: emulate container_files_list via container_exec
    if (normReq === this.normalizeToolName('container_files_list')) {
      const exec = tools.find((t) => this.normalizeToolName(t.name) ===
                                    this.normalizeToolName('container_exec'));
      if (exec?.serverId) {
        const args = {
          args:
              "sh -lc 'find . -type f -maxdepth 6 -print | sed -e s,^,./,'",
          streamStderr: true,
          timeout: 20000,
        };
        return {emulate: true, name: 'container_files_list', with: {
                  name: exec.name,
                  serverId: exec.serverId,
                  args,
                }};
      }
    }

    // Note: intentionally avoid emulating container_file_write via here-doc.
    // Use the native container_file_write tool to keep long strings out of shell.
    // Not found
    return {name: requestedName, serverId: ''} as any;
  }

  // Helper methods moved to mcpUtils for modularity

  async onStart() {
    const cfg = this.options.mcp;
    const mcpConfigs = Array.isArray(cfg) ? cfg : (cfg ? [cfg] : []);
    const anyEnabled = mcpConfigs.some((c) => c?.enabled !== false);
    if (!anyEnabled) return;
    if (this.mcpServerIds.length) return;

    // Avoid re-registering the same MCP servers on every start, but make sure
    // we actively re-establish connections for previously-registered servers.
    let existingUrls = new Set<string>();
    let existingRows: Array<{id: string, server_url: string, auth_url?: string}> = [];
    try {
      const rows = this.sql`
        SELECT id, server_url, auth_url FROM cf_agents_mcp_servers
      ` as Array<{id: string, server_url: string, auth_url?: string}>;
      if (Array.isArray(rows)) existingRows = rows;
      for (const r of existingRows)
        if (r?.server_url) existingUrls.add(r.server_url);
    } catch (e) {
      // If table doesn't exist yet, proceed normally
    }

    // Prefer the Agent's built-in MCP integration which wires OAuth callbacks
    // correctly
    for (const mcp of mcpConfigs) {
      if (mcp?.enabled === false) continue;
      if (existingUrls.has(mcp.serverUrl)) {
        const row = existingRows.find((r) => r.server_url === mcp.serverUrl);
        console.log(`[MCP] server already registered for URL ${
            mcp.serverUrl}, attempting reconnect.`);
        if (row?.id) {
          this.mcpServerMeta[row.id] = {serverUrl: mcp.serverUrl};
          this.mcpServerIds.push(row.id);
          this.mcpServerId = this.mcpServerId ?? row.id;
          if (row.auth_url) {
            this.pendingMcpAuth[mcp.serverUrl] = row.auth_url;
            console.warn('MCP needs OAuth, authorize here:', row.auth_url);
          }
          // Only attempt to establish if not already connected and not in-flight
          if (!this.connectedServerIds.has(row.id) &&
              !this.reconnectingIds.has(row.id)) {
            this.reconnectingIds.add(row.id);
            try {
              await this.mcp.establishConnection(row.id);
              delete this.pendingMcpAuth[mcp.serverUrl];
              console.log('Reconnected to MCP Server:', row.id);
            } catch (err) {
              console.error('MCP reconnect error:', err);
            } finally {
              this.reconnectingIds.delete(row.id);
            }
          } else {
            console.log('MCP server already connected or reconnecting:', row.id);
          }
        }
        continue;
      }
      const isLocal = typeof mcp.serverUrl === 'string' &&
          mcp.serverUrl.startsWith(this.env.SERVER_HOST);
      const transportType = isLocal ? 'streamable-http' : 'auto';
      const transportHeaders: Record<string, string> = {
        // Workers MCP transport requires clients to accept both JSON and SSE.
        Accept: 'application/json, text/event-stream',
      };
      // Support multiple Cloudflare Access auth mechanisms
      if ((this.env as any).MCP_BEARER_TOKEN) {
        transportHeaders.Authorization =
            `Bearer ${(this.env as any).MCP_BEARER_TOKEN}`;
      }
      if ((this.env as any).CF_ACCESS_JWT) {
        transportHeaders['CF-Access-Jwt-Assertion'] =
            String((this.env as any).CF_ACCESS_JWT);
      }
      if ((this.env as any).MCP_ACCESS_JWT) {
        transportHeaders['CF-Access-Jwt-Assertion'] =
            String((this.env as any).MCP_ACCESS_JWT);
      }
      if ((this.env as any).CF_ACCESS_CLIENT_ID &&
          (this.env as any).CF_ACCESS_CLIENT_SECRET) {
        transportHeaders['CF-Access-Client-Id'] =
            String((this.env as any).CF_ACCESS_CLIENT_ID);
        transportHeaders['CF-Access-Client-Secret'] =
            String((this.env as any).CF_ACCESS_CLIENT_SECRET);
      }
      console.log(`[MCP] register server url=${mcp.serverUrl} agent=${
          mcp.agentId} transport=${transportType}`);

      const {id, authUrl} = await this.addMcpServer(
          mcp.agentId,
          mcp.serverUrl,
          this.env.SERVER_HOST,
          'agents',
          {transport: {headers: transportHeaders, type: transportType as any}},
      );
      this.mcpServerMeta[id] = {serverUrl: mcp.serverUrl};
      this.mcpServerIds.push(id);
      this.mcpServerId = this.mcpServerId ?? id;
      console.log(`[MCP] registered id=${id} url=${mcp.serverUrl} transport=${
          transportType} (${authUrl ? 'oauth pending' : 'connected'})`);
      if (authUrl) {
        this.pendingMcpAuth[mcp.serverUrl] = authUrl;
        console.log('MCP needs OAuth, authorize here:', authUrl);
      } else {
        delete this.pendingMcpAuth[mcp.serverUrl];
        console.log('Connected to MCP Server:', id);
      }
    }
  }

  async onRequest(request: Request): Promise<Response> {
    // Simple one-shot invocation endpoint for workflows/HTTP
    // Note: DO routing may rewrite paths; detect by method + content-type
    // instead of path.
    const ct = request.headers.get('content-type') || '';
    const isJsonPost =
        request.method === 'POST' && ct.includes('application/json');
    if (isJsonPost) {
      try {
        await this.onStart();
        // Clone to avoid body-lock issues if any outer middleware inspects the
        // body
        const payload: any =
            await request.clone().json().catch(() => ({} as any));
        if (payload?.warmup) {
          const pendingAuth =
              Object.entries(this.pendingMcpAuth).map(([serverUrl,
                                                        authUrl]) => ({
                                                        serverUrl,
                                                        authUrl,
                                                      }));
          return new Response(
              JSON.stringify({type: 'warmup', pendingAuth}),
              {headers: {'content-type': 'application/json'}});
        }
        if (payload?.debug_mcp) {
          try {
            const state = (this as any).getMcpServers?.() ?? {};
            return new Response(JSON.stringify(state), {
              headers: {'content-type': 'application/json'},
            });
          } catch (e: any) {
            return new Response(
                JSON.stringify({error: String(e?.message ?? e)}),
                {status: 500, headers: {'content-type': 'application/json'}},
            );
          }
        }
        const userContent = this.options.getUserPrompt(payload);
        const cfg = this.options.mcp;
        const useMcp = Array.isArray(cfg) ?
            cfg.some((c) => c?.enabled !== false) :
            !!cfg?.enabled;
        const response = useMcp ?
            await this.queryWithMcp(userContent, this.options) :
            await this.chatModel.query(userContent, this.options);
        return new Response(JSON.stringify({type: 'done', ...response}), {
          headers: {'content-type': 'application/json'},
        });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        const pendingAuth = Object.entries(this.pendingMcpAuth).map(([serverUrl, authUrl]) => ({serverUrl, authUrl}));
        // Never bubble a 500 for model/MCP routing issues; return a structured
        // error with optional OAuth links so the workflow can recover.
        return new Response(
            JSON.stringify({type: 'error', error: msg, pending_auth: pendingAuth}),
            {headers: {'content-type': 'application/json'}});
      }
    }

    if (this.mcp.isCallbackRequest(request)) {
      const result = await this.mcp.handleCallbackRequest(request);
      console.log('MCP OAuth callback result:', result);
      if (result.authSuccess) {
        // Best-effort cleanup of pending auth flag; connection establishment is
        // handled by the MCP manager.
        try {
          this.sql`UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ${
              result.serverId}`;
        } catch (_) {
        }
        return new Response('OAuth authorized. You can close this tab.');
      }
      return new Response(
          `OAuth error: ${result.authError ?? 'unknown'}`, {status: 400});
    }
    return new Response('ok');
  }

  async onConnect(connection: Connection, _ctx: ConnectionContext) {
    await this.onStart();
    connection.send(JSON.stringify({type: 'ready'}));
  }

  async onMessage(connection: Connection, message: WSMessage) {
    let payload: any;
    try {
      if (typeof message === 'string')
        payload = JSON.parse(message);
      else if (message instanceof ArrayBuffer)
        payload = JSON.parse(new TextDecoder().decode(message));
      else
        payload = message;
    } catch (e) {
      connection.send(
          JSON.stringify({type: 'error', error: 'Invalid JSON'}),
      );
      return;
    }

    const userContent = this.options.getUserPrompt(payload);
    if (!userContent) {
      connection.send(
          JSON.stringify({type: 'error', error: 'prompt is required'}),
      );
      return;
    }

    await this.queryChatModel(connection, userContent, this.options)
  }

  private async queryWithMcp(
      userContent: string,
      options: BaseAgentOptions,
      ): Promise<ChatResponse> {
    const cfg = this.options.mcp;
    const enabled = Array.isArray(cfg) ? cfg.some((c) => c?.enabled !== false) :
                                         !!cfg?.enabled;
    if (!this.mcpMgr || !enabled) {
      return this.chatModel.query(userContent, options);
    }

    // Obtain tools once; if empty (likely due to OAuth not completed), don't
    // wait. Fall back immediately to plain chat to avoid blocking.
    let tools = await this.listMcpTools();
    if (!tools.length) {
      // If the caller specified required tools, surface a clear error message
      // instead of hallucinating tool calls, and include OAuth links if any.
      const required = this.options.requiredTools ?? [];
      const pendingAuth = Object.entries(this.pendingMcpAuth).map(([serverUrl, authUrl]) => ({serverUrl, authUrl}));
      if (required.length) {
        return {
          json: {
            type: 'error',
            error:
                `No MCP tools available. Required tools missing: ${required.join(', ')}. ` +
                `Authorize via the OAuth link(s) below and retry.`,
            pending_auth: pendingAuth,
          },
        };
      }
      return {
        json: {
          type: 'error',
          error: 'No MCP tools available. Authorize via the OAuth link(s) below and retry.',
          pending_auth: pendingAuth,
        },
      };
    }

    // If some required tools are missing, warn early.
    const missing = this.findMissingRequiredTools(tools);
    if (missing.length) {
      const pendingAuth = Object.entries(this.pendingMcpAuth).map(([serverUrl, authUrl]) => ({serverUrl, authUrl}));
      return {
        json: {
          type: 'error',
          error:
              `Required MCP tools not available: ${missing.join(', ')}. ` +
              `Authorize via the OAuth link(s) below and retry.`,
          pending_auth: pendingAuth,
        },
      };
    }

    const callOptions: BaseAgentOptions = {
      ...options,
      systemPrompt: buildMcpSystemPrompt(tools, options.systemPrompt),
      getUserPrompt: (payload: any) => String(payload),
    };
    console.log(
        '[MCP] initial tools available:',
        tools.map((t) => `${t.name}@${t.serverId ?? 'unknown'}`));

    const filesWritten = new Set<string>();
    const wroteFileContent = new Map<string, string>();
    const writesPerPath = new Map<string, number>();
    const fileCreationOrder: string[] = [];
    const duplicateCommandSkips = new Set<string>();
    const executedCommands: string[] = [];
    const executedCommandSet = new Set<string>();
    const toolErrors: string[] = [];
    const executedCallCounts = new Map<string, number>();
    let forcedStopReason: string|undefined;
    let roundsWithoutProgress = 0;
    const mcpLogs: Array<{
      tool: string;
      serverId: string;
      args: Record<string, unknown>;
      result: unknown;
    }> = [];

    // Derive planned files from the initial payload for coverage gating
    let plannedFiles: Set<string> = new Set();
    try {
      const initial = tryParseJsonWithComments(userContent) as any;
      const devPlan = (initial?.development_plan ?? initial?.planner?.development_plan) as any;
      const filesSpec = devPlan?.files;
      if (filesSpec && typeof filesSpec === 'object') {
        if (Array.isArray(filesSpec)) {
          for (const item of filesSpec) {
            if (typeof item === 'string') plannedFiles.add(item.trim().replace(/^\.\/+/, ''));
            else if (item && typeof item === 'object' && typeof (item as any).path === 'string') {
              plannedFiles.add(String((item as any).path).trim().replace(/^\.\/+/, ''));
            }
          }
        } else {
          for (const key of Object.keys(filesSpec)) {
            if (typeof key === 'string' && key.trim()) {
              plannedFiles.add(key.trim().replace(/^\.\/+/, ''));
            }
          }
        }
      }
    } catch (_) {
      plannedFiles = new Set();
    }

    const isCoverageComplete = () => {
      if (!plannedFiles.size) return false; // only enforce when planner provided files
      for (const p of plannedFiles) {
        if (!filesWritten.has(p)) return false;
      }
      return true;
    };

    const remainingPlannedFiles = () => {
      const missing: string[] = [];
      for (const p of plannedFiles) if (!filesWritten.has(p)) missing.push(p);
      return missing;
    };

    const finalizeResponse =
        (response: ChatResponse, reason?: string): ChatResponse => {
          const sortedFiles = Array.from(filesWritten).sort();
          const notesParts: string[] = [];
          if (executedCommands.length) {
            notesParts.push(
                `Executed commands: ${executedCommands.join(', ')}`);
          }
          if (toolErrors.length) {
            notesParts.push(`Errors encountered: ${toolErrors.join(' | ')}`);
          }
          if (reason) {
            notesParts.push(`Stopped early: ${reason}`);
          }
          const shouldSummarize = sortedFiles.length ||
              executedCommands.length || toolErrors.length || !!reason;
          if (shouldSummarize) {
            const siteRoot =
                sortedFiles.length ? (inferSiteRoot(sortedFiles) ?? '.') : null;
            let status: 'success'|'error'|'noop' = 'noop';
            if (sortedFiles.length)
              status = 'success';
            else if (toolErrors.length)
              status = 'error';
            const summary = {
              type: 'answer',
              answer: {
                status,
                files_written: sortedFiles,
                site_root: siteRoot,
                notes: notesParts.join(' ') ||
                    (status === 'success' ? 'Changes applied.' :
                                            'No changes were applied.'),
              },
            };
            if (!response.json) {
              response.json = summary;
            } else if (response.json && typeof response.json === 'object') {
              const existing: any = response.json;
              if (existing.type === 'answer' &&
                  typeof existing.answer === 'object') {
                const ans = existing.answer;
                if ((!Array.isArray(ans.files_written) ||
                     !ans.files_written.length) &&
                    sortedFiles.length) {
                  ans.files_written = sortedFiles;
                }
                if (ans.site_root === undefined && siteRoot !== undefined) {
                  ans.site_root = siteRoot;
                }
                if (!ans.notes && notesParts.length) {
                  ans.notes = notesParts.join(' ');
                }
              }
            }
            // Optionally include detailed MCP logs
            if (options.includeMcpLogsInResponse) {
              try {
                const base: any = response.json ?? {};
                base.mcp_logs = mcpLogs;
                response.json = base;
              } catch (_) {
                // no-op if structure is unexpected
              }
            }
            if (!response.text) {
              response.text = JSON.stringify(response.json ?? summary);
            }
          }
          return response;
        };

    let currentContent = userContent;
    const normalizePath = (raw?: string): string|undefined => {
      if (typeof raw !== 'string') return undefined;
      let cleaned = raw.trim();
      if (!cleaned) return undefined;
      cleaned = cleaned.replace(/^\.\/+/, '');
      cleaned = cleaned.replace(/\/{2,}/g, '/');
      return cleaned;
    };
    const duplicateTolerant = new Set([
      'container_initialize',
      'container_exec',
      // Intentionally exclude 'container_file_write' to prevent silent
      // repetition of identical writes from being treated as progress.
    ].map((n) => this.normalizeToolName(n)));
    for (let round = 0; round < 15; round++) {
      console.log(`[MCP] round ${round + 1} querying model`);
      const modelRes = await this.chatModel.query(currentContent, callOptions);
      console.log('[MCP] model raw response:', JSON.stringify(modelRes));

      // Parse model JSON/shape
      let parsed: any = undefined;
      if (modelRes && typeof modelRes === 'object' && 'json' in modelRes &&
          (modelRes as any).json) {
        parsed = (modelRes as any).json;
      } else if (typeof modelRes?.text === 'string') {
        parsed = tryParseJsonWithComments(modelRes.text);
      } else if (modelRes?.text && typeof (modelRes as any).text === 'object') {
        parsed = (modelRes as any).text;
      }

      // Extract one or more tool calls from parsed or raw text
      let calls: Array<{name: string, args: Record<string, unknown>}> = [];
      if (parsed) {
        const extracted = extractToolCalls(parsed);
        if (extracted) calls = extracted;
      }
      if (!calls.length && typeof modelRes?.text === 'string') {
        const objs = extractJsonObjectsFromText(modelRes.text);
        for (const o of objs) {
          const c = extractToolCalls(o);
          if (c && c.length) {
            calls.push(...c);
          }
        }
        // Extra robustness: if text itself is a single JSON object string
        // like "{\n  \"type\": \"tool_call\", ... }", parse it directly
        if (!calls.length) {
          const t = modelRes.text.trim();
          if (t.startsWith('{') && (t.endsWith('}') || t.endsWith('}]') || t.endsWith('"}'))) {
            try {
              const direct = JSON.parse(t);
              const c = extractToolCalls(direct);
              if (c && c.length) calls.push(...c);
            } catch (_) {
              // ignore
            }
          }
        }
        // Last-resort salvage for truncated container_file_write JSON in text
        if (!calls.length) {
          const salvage = tryExtractTruncatedToolCall(modelRes.text);
          if (salvage) {
            // Guard: if salvage is a duplicate file_write for the same path+content
            // that was already written this session, skip creating a call.
            try {
              const sname = (salvage as any)?.name ?? '';
              if (this.normalizeToolName(sname) === this.normalizeToolName('container_file_write')) {
                const a: any = (salvage as any).args ?? {};
                const rawPath = typeof a?.args?.path === 'string' ? a.args.path :
                                 typeof a?.path === 'string' ? a.path : undefined;
                const path = normalizePath(rawPath);
                const text = typeof a?.args?.text === 'string' ? a.args.text :
                             typeof a?.text === 'string' ? a.text : undefined;
                if (path && typeof text === 'string') {
                  const prev = wroteFileContent.get(path);
                  if (prev !== undefined && prev === text) {
                    console.log('[MCP] skip salvage of duplicate truncated file_write for', path);
                  } else {
                    calls.push(salvage);
                  }
                } else {
                  calls.push(salvage);
                }
              } else {
                calls.push(salvage);
              }
            } catch (_) {
              calls.push(salvage);
            }
          }
        }
      }

      if (!calls.length) {
        const fallbackText =
            typeof modelRes?.text === 'string' ? modelRes.text.trim() : '';
        const hasJsonSignature = /"type"\s*:\s*"(tool_call|answer)"/.test(
            fallbackText);
        const opens = (fallbackText.match(/{/g) ?? []).length;
        const closes = (fallbackText.match(/}/g) ?? []).length;
        const bracesBalanced = opens === closes;
        const endsWithBrace = fallbackText.endsWith('}') ||
            fallbackText.endsWith('}]') || fallbackText.endsWith('"}');
        if (hasJsonSignature && (!bracesBalanced || !endsWithBrace)) {
          currentContent = `
Your previous reply contained an incomplete JSON object. Resend the SAME content as a single, fully-formed JSON object with matching braces.
`.trim();
          continue;
        }

        console.log('[MCP] model returned no tool calls');
        const fallbackJson =
            tryParseJsonWithComments(fallbackText);
        const parsedObj =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) ?
            parsed :
            (fallbackJson && typeof fallbackJson === 'object' &&
                     !Array.isArray(fallbackJson) ?
                 fallbackJson :
                 undefined);

        if (this.options.requireSiteZipBase64) {
          const answerObj = parsedObj && typeof (parsedObj as any).answer === 'object' ?
              (parsedObj as any).answer :
              undefined;
          const siteZip =
              typeof answerObj?.site_zip_base64 === 'string' ?
              answerObj.site_zip_base64.trim() :
              '';
          if (!siteZip) {
            currentContent = `
Your previous reply did not include the required "site_zip_base64". Before responding, zip the deployable site, read it via container_file_read, and include both "site_zip_base64" and "site_zip_filename" in your final JSON answer. Do not answer until those fields are present.
`.trim();
            continue;
          }
        }

        const response: ChatResponse = {};
        if (parsedObj) {
          response.json = parsedObj;
          if (typeof (parsedObj as any).answer === 'string') {
            response.text = (parsedObj as any).answer;
          }
        }
        if (response.text === undefined) {
          if (typeof modelRes?.text === 'string') {
            response.text = modelRes.text;
          } else if (response.json === undefined) {
            response.text =
                JSON.stringify(modelRes?.text ?? parsedObj ?? null);
          }
        }
        console.log('[MCP] final answer payload:', JSON.stringify(response));
        // No tool call requested, return textual/JSON answer
        return finalizeResponse(response, forcedStopReason);
      }

      let shouldStop = false;
      for (const call of calls) {
        const key = `${call.name}:${JSON.stringify(call.args ?? {})}`;
        const prevCount = executedCallCounts.get(key) ?? 0;
        if (prevCount >= 2 &&
            !duplicateTolerant.has(this.normalizeToolName(call.name))) {
          shouldStop = true;
          forcedStopReason = forcedStopReason ??
              `Tool '${call.name}' repeated with identical arguments`;
          break;
        }
      }
      if (shouldStop) break;

      // Execute one or more calls sequentially
      console.log('[MCP] executing tool calls:', calls.map((c) => c.name));
      const callSummaries: string[] = [];
      const roundSkippedCommands = new Set<string>();
      let roundMadeProgress = false;
      let duplicateFileWriteSkips = 0;
      const duplicateFileWriteLoggedPaths = new Set<string>();
      let duplicateCommandSkipsCount = 0;
      const duplicateCommandsLogged = new Set<string>();
      let autoReadZipAttempted = false;
      let autoInstallZipAttempted = false;
      for (const call of calls) {
        const requestedName = call.name;
        const requestedArgs = call.args ?? {};
        let resolved = this.resolveTool(tools, requestedName, requestedArgs);
        let handledViaEmulation = false;
        let skipPostProcessing = false;
        let retriedMissingServer = false;
        let serverId = '';
        let toolName = requestedName;
        let toolArgs = requestedArgs;
        let toolResult: any;

        // Soft-ignore duplicate container_initialize calls beyond the first
        const normName = this.normalizeToolName(requestedName);
        if (normName === this.normalizeToolName('container_initialize')) {
          const key = `${requestedName}:${JSON.stringify(requestedArgs ?? {})}`;
          const prevCount = executedCallCounts.get(key) ?? 0;
          if (prevCount >= 1) {
            callSummaries.push(`Tool: ${requestedName}\nArgs: ${JSON.stringify(requestedArgs, null, 2)}\nResult: {\n  \"note\": \"duplicate container_initialize ignored\"\n}`);
            continue;
          }
        }

        while (true) {
          if ((resolved as any).emulate) {
            const emu = resolved as any;
            console.log(`[MCP] emulating ${emu.name} via ${emu.with.name}`);
            try {
              const toolResultInner = await this.mcpMgr.callTool({
                name: emu.with.name,
                serverId: emu.with.serverId,
                arguments: {args: emu.with.args},
              });
              const toolResultJson = JSON.stringify(toolResultInner, null, 2);
              console.log(toolResultJson);
              mcpLogs.push({
                tool: emu.name,
                serverId: emu.with.serverId,
                args: emu.with.args,
                result: toolResultInner,
              });
              const key = `${emu.name}:${JSON.stringify(emu.with.args)}`;
              executedCallCounts.set(
                  key, (executedCallCounts.get(key) ?? 0) + 1);
            callSummaries.push(`Tool: ${emu.name}\nArgs: ${
                  JSON.stringify(emu.with.args, null, 2)}\nResult: ${toolResultJson}`);
            roundMadeProgress = true;
          } catch (err: any) {
            const msg = String(err?.message ?? err);
            toolErrors.push(`${emu.name}: ${msg}`);
              callSummaries.push(`Tool: ${emu.name} (emulated)\nError: ${msg}`);
            }
            handledViaEmulation = true;
            break;
          }

          serverId = (resolved as any).serverId as string | undefined || '';
          toolName = (resolved as any).name as string;

          if (!serverId || serverId === toolName) {
            if (!retriedMissingServer) {
              retriedMissingServer = true;
              console.warn(
                  `[MCP] tool '${requestedName}' resolved with invalid serverId '${serverId}'. Refreshing MCP tool list.`);
              tools = await this.listMcpTools();
              resolved = this.resolveTool(tools, requestedName, requestedArgs);
              continue;
            }
            const available =
                tools.map((t) => t.name).filter((v, i, a) => a.indexOf(v) === i);
            console.log('[MCP] tool missing', requestedName, 'available:', available);
            return {
              text: `MCP tool '${requestedName}' is not available. Available tools: ${
                  available.join(', ')}`
            };
          }

        if (toolName === 'container_exec') {
          if (typeof requestedArgs === 'string') {
            toolArgs = {
              args: {args: requestedArgs},
            };
          } else if (requestedArgs && typeof requestedArgs === 'object' &&
                     typeof (requestedArgs as any).args === 'string') {
            toolArgs = {
              args: {args: (requestedArgs as any).args},
            };
          }
        }

        const coercedArgs = coerceToolArgs(
            this.normalizeToolName(toolName), toolArgs);
        if (coercedArgs && typeof coercedArgs === 'object' &&
            Object.keys(coercedArgs).length) {
          toolArgs = coercedArgs;
        } else {
          toolArgs = requestedArgs;
        }

        // Guard: coverage-based gating before packaging/deploy steps
        try {
          const norm = this.normalizeToolName(toolName);
          const argsAny: any = toolArgs ?? {};
          const cmd = typeof argsAny?.args?.args === 'string' ? argsAny.args.args :
                      typeof argsAny?.command === 'string' ? argsAny.command : '';
          const isPagesOp = norm === this.normalizeToolName('pages_upload_prepare') ||
                            norm === this.normalizeToolName('pages_upload_put') ||
                            norm === this.normalizeToolName('pages_deploy_from_upload');
          const isZipExec = norm === this.normalizeToolName('container_exec') &&
                            typeof cmd === 'string' && /\bzip\b|site\.zip|zipfile|base64\s*\.b64|b64encode/i.test(cmd);
          const isReadZip = norm === this.normalizeToolName('container_file_read') &&
                            typeof (argsAny?.args?.path ?? argsAny?.path) === 'string' &&
                            String(argsAny?.args?.path ?? argsAny?.path).includes('/tmp/site.zip');
          const looksLikePackaging = isPagesOp || isZipExec || isReadZip;
          if (looksLikePackaging && plannedFiles.size && !isCoverageComplete()) {
            const missing = remainingPlannedFiles();
            callSummaries.push(
              `Tool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}\nResult: {\n  \"note\": \"packaging/deploy blocked: planned files incomplete\",\n  \"coverage\": { \"complete\": false, \"total\": ${plannedFiles.size}, \"done\": ${plannedFiles.size - missing.length}, \"missing\": ${JSON.stringify(missing)} }\n}`);
            // Skip execution for this call
            continue;
          }
        } catch (_) { /* best-effort */ }
        if (this.normalizeToolName(toolName) ===
            this.normalizeToolName('container_exec')) {
          try {
            const a: any = toolArgs;
            const cmd = typeof a?.args?.args === 'string' ?
                a.args.args :
                typeof a?.command === 'string' ? a.command : undefined;
            if (typeof cmd === 'string' && executedCommandSet.has(cmd)) {
              duplicateCommandSkips.add(cmd);
              if (!duplicateCommandsLogged.has(cmd)) {
                console.log(`[MCP] skip duplicate command ${cmd}`);
                duplicateCommandsLogged.add(cmd);
              }
              duplicateCommandSkipsCount++;
              roundSkippedCommands.add(cmd);
              callSummaries.push(`Tool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}\nResult: {\n  \"note\": \"duplicate command skipped\"\n}`);
              // If the duplicate command is a zip of the site to /tmp/site.zip,
              // proactively attempt to read the zip so the model can proceed
              // with upload in the next round.
              try {
                const low = cmd.toLowerCase();
                const looksLikeZip = low.includes(' zip ') && low.includes('/tmp/site.zip');
                if (looksLikeZip && !autoReadZipAttempted) {
                  const readArgs = {args: {path: '/tmp/site.zip'}} as any;
                  const resolvedRead = this.resolveTool(tools, 'container_file_read', readArgs);
                  if (!(resolvedRead as any).emulate) {
                    const readServer = (resolvedRead as any).serverId as string;
                    const readName = (resolvedRead as any).name as string;
                    if (readServer && readName) {
                      console.log(`[MCP] auto-reading zip via ${readName}`);
                      try {
                        const res = await this.mcpMgr.callTool({
                          name: readName,
                          serverId: readServer,
                          arguments: readArgs,
                        });
                        const resJson = JSON.stringify(res, null, 2);
                        mcpLogs.push({tool: readName, serverId: readServer, args: readArgs, result: res});
                        callSummaries.push(`Tool: ${readName} (auto)\nArgs: ${JSON.stringify(readArgs, null, 2)}\nResult: ${resJson}`);
                        roundMadeProgress = true;
                        autoReadZipAttempted = true;
                      } catch (e: any) {
                        const emsg = String(e?.message ?? e);
                        toolErrors.push(`container_file_read(auto): ${emsg}`);
                        callSummaries.push(`Tool: container_file_read (auto)\nArgs: ${JSON.stringify(readArgs, null, 2)}\nError: ${emsg}`);
                      }
                    }
                  }
                }
              } catch (_) {}
              continue;
            }
          } catch (_) {
            // ignore
          }
        }

        // Skip duplicate file writes with identical path + content.
        // This prevents the loop from treating repeated writes as progress.
        if (this.normalizeToolName(toolName) ===
            this.normalizeToolName('container_file_write')) {
          try {
            const a: any = toolArgs;
            const rawPath = typeof a?.args?.path === 'string' ? a.args.path :
                             typeof a?.path === 'string' ? a.path : undefined;
            const path = normalizePath(rawPath);
            const text = typeof a?.args?.text === 'string' ? a.args.text :
                         typeof a?.text === 'string' ? a.text : undefined;
            if (path && typeof text === 'string') {
              // Enforce a soft cap on writes per file (allow iteration but limit abuse)
              const prevWrites = writesPerPath.get(path) ?? 0;
              if (prevWrites >= 3) {
                if (!duplicateFileWriteLoggedPaths.has(path)) {
                  console.log(`[MCP] block file_write for ${path} (write limit exceeded)`);
                  duplicateFileWriteLoggedPaths.add(path);
                }
                duplicateFileWriteSkips++;
                const keyCap = `${toolName}:${JSON.stringify(toolArgs)}`;
                executedCallCounts.set(keyCap, (executedCallCounts.get(keyCap) ?? 0) + 1);
                callSummaries.push(
                  `Tool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}\nResult: {\n  \"note\": \"file_write blocked: write limit exceeded (3)\"\n}`);
                continue;
              }
              const prev = wroteFileContent.get(path);
              if (prev !== undefined && prev === text) {
                if (!duplicateFileWriteLoggedPaths.has(path)) {
                  console.log(`[MCP] skip duplicate file_write for ${path} (identical content)`);
                  duplicateFileWriteLoggedPaths.add(path);
                }
                duplicateFileWriteSkips++;
                const keyDup = `${toolName}:${JSON.stringify(toolArgs)}`;
                executedCallCounts.set(keyDup, (executedCallCounts.get(keyDup) ?? 0) + 1);
                callSummaries.push(
                    `Tool: ${toolName}\nArgs: ${JSON.stringify(toolArgs, null, 2)}\nResult: {\n  \"note\": \"duplicate file_write skipped (same path and content)\"\n}`);
                // Do not mark progress; just skip this call.
                continue;
              }
            }
          } catch (_) {
            // best-effort; fall through to normal execution
          }
        }
          console.log(`[MCP] calling tool=${toolName} server=${serverId}`);
          try {
            // Retry wrapper for transient container boot/connectivity
            const callOnce = async () => this.mcpMgr.callTool({
              name: toolName,
              serverId,
              arguments: toolArgs,
            });
            const shouldRetry = (res: any, err?: any) => {
              try {
                const txt = err ? String(err?.message ?? err) : (collectToolResultText(res) ?? '');
                const low = txt.toLowerCase();
                if (!txt) return false;
                return low.includes('not listening in the tcp address') ||
                       low.includes('10.0.0.1:8080') ||
                       low.includes('connection refused') ||
                       low.includes('econnrefused');
              } catch (_) {
                return false;
              }
            };
            let attempts = 0;
            while (true) {
              attempts++;
              try {
                const res = await callOnce();
                if (res?.isError && shouldRetry(res)) {
                  if (attempts < 3) {
                    await new Promise((r) => setTimeout(r, attempts * 150));
                    continue;
                  }
                }
                toolResult = res;
                break;
              } catch (e: any) {
                if (shouldRetry(undefined, e) && attempts < 3) {
                  await new Promise((r) => setTimeout(r, attempts * 150));
                  continue;
                }
                throw e;
              }
            }
          } catch (err: any) {
            const msg = String(err?.message ?? err);
            toolErrors.push(`${toolName}: ${msg}`);
            callSummaries.push(`Tool: ${toolName}\nArgs: ${
                JSON.stringify(toolArgs, null, 2)}\nError: ${msg}`);
            skipPostProcessing = true;
          }
          break;
        }
        if (handledViaEmulation || skipPostProcessing) {
          continue;
        }

        roundMadeProgress = true;
        const toolResultJson = JSON.stringify(toolResult, null, 2);
        console.log(toolResultJson);
        // Capture detailed MCP call log for optional inclusion in response
        mcpLogs.push({tool: toolName, serverId, args: toolArgs, result: toolResult});
        const normalizedArgs = toolArgs as any;
        const pathArgRaw = typeof normalizedArgs?.args?.path === 'string' ?
            normalizedArgs.args.path :
            typeof normalizedArgs?.path === 'string' ? normalizedArgs.path :
                                                       undefined;
        const pathArg = normalizePath(pathArgRaw);
        const commandArg = typeof normalizedArgs?.args?.args === 'string' ?
            normalizedArgs.args.args :
            typeof normalizedArgs?.command === 'string' ?
            normalizedArgs.command :
            undefined;
        const key = `${toolName}:${JSON.stringify(toolArgs)}`;
        executedCallCounts.set(key, (executedCallCounts.get(key) ?? 0) + 1);
        if (toolResult?.isError) {
          const errText = collectToolResultText(toolResult) ?? 'Unknown error';
          toolErrors.push(`${toolName}: ${errText}`);
        } else {
          if (toolName === 'container_file_write' &&
              typeof pathArg === 'string') {
            filesWritten.add(pathArg);
            try {
              const t = (normalizedArgs?.args?.text ?? '') as string;
              if (typeof t === 'string') wroteFileContent.set(pathArg, t);
            } catch (_) {}
            const prevCount = writesPerPath.get(pathArg) ?? 0;
            if (prevCount === 0) {
              fileCreationOrder.push(pathArg);
            }
            writesPerPath.set(pathArg, prevCount + 1);
          }
          if (toolName === 'container_exec' && typeof commandArg === 'string') {
            if (!executedCommandSet.has(commandArg)) {
              executedCommands.push(commandArg);
              executedCommandSet.add(commandArg);
            } else {
              duplicateCommandSkips.add(commandArg);
              roundSkippedCommands.add(commandArg);
            }
          }
        }
        callSummaries.push(`Tool: ${toolName}\nArgs: ${
            JSON.stringify(toolArgs, null, 2)}\nResult: ${toolResultJson}`);

        // Auto-recovery: if a zip command failed due to missing 'zip', try to install it and retry the original zip command once.
        try {
          const isExec = this.normalizeToolName(toolName) === this.normalizeToolName('container_exec');
          const cmd = typeof commandArg === 'string' ? commandArg : '';
          const looksLikeZipCmd = cmd.toLowerCase().includes(' zip ') && cmd.includes('/tmp/site.zip');
          const resText = collectToolResultText(toolResult) ?? '';
          const missingZip = /\bzip\b[^\n]*not found/i.test(resText) || /command not found: zip/i.test(resText);
          if (isExec && looksLikeZipCmd && missingZip && !autoInstallZipAttempted) {
            autoInstallZipAttempted = true;
            // Attempt to install zip via common package managers, then retry the original command
            const installCmd = {
              args: {
                args:
                  "sh -lc 'if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y zip; " +
                  "elif command -v apk >/dev/null 2>&1; then apk add --no-cache zip; " +
                  "elif command -v microdnf >/dev/null 2>&1; then microdnf install -y zip; " +
                  "elif command -v dnf >/dev/null 2>&1; then dnf install -y zip; " +
                  "elif command -v yum >/dev/null 2>&1; then yum install -y zip; " +
                  "elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm zip; " +
                  "else echo \"No supported package manager found\" >&2; exit 127; fi'",
                streamStderr: true,
                timeout: 60000,
              }
            } as any;
            const resolvedExec = this.resolveTool(tools, 'container_exec', installCmd);
            if (!(resolvedExec as any).emulate) {
              const execServer = (resolvedExec as any).serverId as string;
              const execName = (resolvedExec as any).name as string;
              if (execServer && execName) {
                console.log(`[MCP] auto-installing zip via ${execName}`);
                try {
                  const installRes = await this.mcpMgr.callTool({
                    name: execName,
                    serverId: execServer,
                    arguments: installCmd,
                  });
                  const installJson = JSON.stringify(installRes, null, 2);
                  mcpLogs.push({tool: execName, serverId: execServer, args: installCmd, result: installRes});
                  callSummaries.push(`Tool: ${execName} (auto-install zip)\nArgs: ${JSON.stringify(installCmd, null, 2)}\nResult: ${installJson}`);
                  roundMadeProgress = true;
                } catch (e: any) {
                  const emsg = String(e?.message ?? e);
                  toolErrors.push(`container_exec(auto-install zip): ${emsg}`);
                  callSummaries.push(`Tool: container_exec (auto-install zip)\nArgs: ${JSON.stringify(installCmd, null, 2)}\nError: ${emsg}`);
                }

                // Retry the original zip command regardless of install success
                try {
                  const retryArgs = {args: {args: cmd, streamStderr: true, timeout: 60000}} as any;
                  const retryResolved = this.resolveTool(tools, 'container_exec', retryArgs);
                  if (!(retryResolved as any).emulate) {
                    const rServer = (retryResolved as any).serverId as string;
                    const rName = (retryResolved as any).name as string;
                    if (rServer && rName) {
                      console.log(`[MCP] retrying original zip via ${rName}`);
                      const retryRes = await this.mcpMgr.callTool({
                        name: rName,
                        serverId: rServer,
                        arguments: retryArgs,
                      });
                      const retryJson = JSON.stringify(retryRes, null, 2);
                      mcpLogs.push({tool: rName, serverId: rServer, args: retryArgs, result: retryRes});
                      callSummaries.push(`Tool: ${rName} (auto-retry zip)\nArgs: ${JSON.stringify(retryArgs, null, 2)}\nResult: ${retryJson}`);
                      roundMadeProgress = true;
                    }
                  }
                } catch (e: any) {
                  const emsg = String(e?.message ?? e);
                  toolErrors.push(`container_exec(auto-retry zip): ${emsg}`);
                  callSummaries.push(`Tool: container_exec (auto-retry zip)\nArgs: {\n  \"args\": { \"args\": ${JSON.stringify(cmd)} }\n}\nError: ${emsg}`);
                }
              }
            }
            // If the zip file still doesn't exist after retry, attempt a Python fallback to create it
            try {
              const checkArgs = {args: {args: "sh -lc 'test -f /tmp/site.zip && echo ZIP_OK || echo ZIP_MISSING'", streamStderr: true, timeout: 15000}} as any;
              const checkResolved = this.resolveTool(tools, 'container_exec', checkArgs);
              if (!(checkResolved as any).emulate) {
                const cServer = (checkResolved as any).serverId as string;
                const cName = (checkResolved as any).name as string;
                const checkRes = await this.mcpMgr.callTool({
                  name: cName,
                  serverId: cServer,
                  arguments: checkArgs,
                });
                const checkText = collectToolResultText(checkRes) ?? '';
                const checkJson = JSON.stringify(checkRes, null, 2);
                mcpLogs.push({tool: cName, serverId: cServer, args: checkArgs, result: checkRes});
                callSummaries.push(`Tool: ${cName} (verify zip exists)\nArgs: ${JSON.stringify(checkArgs, null, 2)}\nResult: ${checkJson}`);
                const zipMissing = /ZIP_MISSING/.test(checkText);
                if (zipMissing) {
                  let baseDir = '.';
                  try {
                    const m = cmd.match(/cd\s+([^&;]+)\s*&&/i);
                    if (m && m[1]) baseDir = m[1].trim().replace(/^["']/, '').replace(/["']$/, '');
                  } catch (_) {}
                  const pyScript = [
                    'import zipfile, os',
                    `base = ${JSON.stringify(baseDir)}`,
                    'out = "/tmp/site.zip"',
                    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
                    '  for root, dirs, files in os.walk(base):',
                    '    for f in files:',
                    '      p = os.path.join(root, f)',
                    '      arc = os.path.relpath(p, base)',
                    '      z.write(p, arc)',
                    'print("OK")',
                  ].join('\n');
                  const pyCmd = "sh -lc 'set -e; if command -v python3 >/dev/null 2>&1; then py=python3; elif command -v python >/dev/null 2>&1; then py=python; else echo \"No python found\" >&2; exit 127; fi; $py - <<'PY'\n" + pyScript + "\nPY'";
                  const pyArgs = {args: {args: pyCmd, streamStderr: true, timeout: 60000}} as any;
                  const pyResolved = this.resolveTool(tools, 'container_exec', pyArgs);
                  if (!(pyResolved as any).emulate) {
                    const pServer = (pyResolved as any).serverId as string;
                    const pName = (pyResolved as any).name as string;
                    console.log(`[MCP] python fallback to create zip via ${pName}`);
                    try {
                      const pyRes = await this.mcpMgr.callTool({
                        name: pName,
                        serverId: pServer,
                        arguments: pyArgs,
                      });
                      const pyJson = JSON.stringify(pyRes, null, 2);
                      mcpLogs.push({tool: pName, serverId: pServer, args: pyArgs, result: pyRes});
                      callSummaries.push(`Tool: ${pName} (python zip fallback)\nArgs: ${JSON.stringify(pyArgs, null, 2)}\nResult: ${pyJson}`);
                      roundMadeProgress = true;
                    } catch (e: any) {
                      const emsg = String(e?.message ?? e);
                      toolErrors.push(`container_exec(python zip fallback): ${emsg}`);
                      callSummaries.push(`Tool: container_exec (python zip fallback)\nArgs: ${JSON.stringify(pyArgs, null, 2)}\nError: ${emsg}`);
                    }
                  }
                }
              }
            } catch (_) { /* best-effort */ }
          }
        } catch (_) { /* best-effort */ }
      }

      if (!roundMadeProgress) {
        roundsWithoutProgress++;
      } else {
        roundsWithoutProgress = 0;
      }
      // Feed batched results back for potential follow-up tool calls
      const existingFiles = Array.from(filesWritten).sort();
      const reminders: string[] = [];
      // Derive a suggested zip directory: prefer directory of an index.html, fallback to site root
      let suggestedZipDir: string | undefined;
      try {
        const firstIndex = fileCreationOrder.find((p) => typeof p === 'string' && (p.endsWith('/index.html') || p === 'index.html'));
        if (firstIndex) {
          const idx = firstIndex.lastIndexOf('/');
          suggestedZipDir = idx > 0 ? firstIndex.slice(0, idx) : '.';
        } else if (existingFiles.length) {
          suggestedZipDir = inferSiteRoot(existingFiles) ?? '.';
        }
      } catch (_) {}
      if (existingFiles.length) {
        reminders.push(
            `Files already created (limit rewrites; decide completion per file): ${existingFiles.join(', ')}`);
      }
      // Coverage-driven gating summary
      if (plannedFiles.size) {
        const missing = remainingPlannedFiles();
        const done = plannedFiles.size - missing.length;
        const coverage = `${done}/${plannedFiles.size}`;
        reminders.push(`Coverage: ${coverage}. Missing: ${missing.length ? missing.join(', ') : 'none'}. Packaging/deploy only after all are complete.`);
      }
      if (this.options.requireSiteZipBase64) {
        reminders.push(
            'Next step: zip the site directory that contains your generated files, read the zip, and include "site_zip_base64" and "site_zip_filename" in your final JSON answer before finishing.');
      } else {
        // FullStack path: do not auto-nudge packaging based on repetition; rely on coverage.
      }
      if (roundSkippedCommands.size) {
        reminders.push(
            `Duplicate commands were detected: ${Array.from(roundSkippedCommands).join(', ')}. Avoid rerunning identical commands without a specific reason.`);
      }
      if (!roundMadeProgress) {
        reminders.push(
            'No new tool actions were applied this round. Move on to the remaining steps (zip/read/deploy) or provide the final answer without repeating previous actions.');
      }
      if (duplicateFileWriteSkips > 0) {
        reminders.push(
            `Repeated duplicate file writes detected (${duplicateFileWriteSkips}). Limit per-file rewrites (max 3) and move to the next file when complete.`);
      }
      if (duplicateCommandSkipsCount > 0) {
        reminders.push(
            `Repeated duplicate commands detected (${duplicateCommandSkipsCount}). Avoid rerunning the same command; proceed to the next steps.`);
      }
      if (!reminders.length) reminders.push('Continue executing the remaining required steps.');
      // Escalate earlier when duplicates dominate to avoid long loops
      const dupFileAbortThreshold = this.options.abortOnDuplicateSkipsThreshold ?? 3;
      const dupCmdAbortThreshold = this.options.abortOnDuplicateCommandsThreshold ?? 3;
      if (!roundMadeProgress && (roundsWithoutProgress >= 2 || duplicateFileWriteSkips >= dupFileAbortThreshold || duplicateCommandSkipsCount >= dupCmdAbortThreshold)) {
        forcedStopReason = 'Repeated duplicate tool calls without progress';
        return finalizeResponse(
            {
              text: 'Aborting after multiple rounds of duplicate tool calls with no new progress. Review the skipped actions and continue manually.',
            },
            forcedStopReason);
      }
      const progressParts: string[] = [];
      if (fileCreationOrder.length) {
        progressParts.push(
            `Files created so far:\n- ${fileCreationOrder.join('\n- ')}`);
      }
      if (executedCommands.length) {
        progressParts.push(
            `Commands run so far:\n- ${executedCommands.join('\n- ')}`);
      }
      const progressSection = progressParts.length ?
          `Progress so far:\n${progressParts.join('\n\n')}` :
          'Progress so far:\n- (no files or commands yet)';
      currentContent = [
        `Original requirement:\n${userContent}`,
        progressSection,
        `Status reminders:\n- ${reminders.join('\n- ')}`,
        'Tool executions this round:',
        callSummaries.join('\n\n'),
        'If more actions are needed, respond with a tool_call JSON. Otherwise, respond with an answer JSON.',
      ].join('\n\n').trim();
    }

    // Safety fallback if loop did not return
    forcedStopReason =
        forcedStopReason ?? 'Reached maximum tool call rounds (15)';
    return finalizeResponse(
        {text: 'Exceeded maximum tool call rounds. Please review results.'},
        forcedStopReason);
  }

  async queryChatModel(
      connection: Connection,
      userContent: string,
      options: BaseAgentOptions,
  ) {
    try {
      const cfg = this.options.mcp;
      const useMcp = Array.isArray(cfg) ?
          cfg.some((c) => c?.enabled !== false) :
          !!cfg?.enabled;

      const response = useMcp ?
          await this.queryWithMcp(userContent, options) :
          await this.chatModel.query(userContent, options);

      connection.send(JSON.stringify({type: 'done', ...response}));
    } catch (err: any) {
      connection.send(
          JSON.stringify({type: 'error', error: String(err?.message ?? err)}),
      );
    }
  }


  async destroy() {
    try {
      await this.mcp.closeAllConnections();
      await this.mcp.dispose?.();
    } catch (_) {
    }
  }
}
