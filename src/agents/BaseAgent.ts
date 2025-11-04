import {Agent, Connection, ConnectionContext, WSMessage} from 'agents';
import {OpenAI} from 'openai';

import {ChatResponse, IChatModel} from '../providers/AIProviderInterface';
import {OpenAIChatModel} from '../providers/OpenAIProvider';
import {WorkersAIChatModel} from '../providers/WorkersAIProvider';
import {buildMcpSystemPrompt} from '../worker/prompt';
import {McpTool} from '../worker/types';

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
  // Optional custom handler for raw model response
  onModelResponse?: (args: {
                   response: Awaited<
                       ReturnType<OpenAI['chat']['completions']['create']>>;
                   connection: Connection;
                 }) => Promise<void>;
  // Optional MCP settings
  mcp?: {
    enabled?: boolean; agentId: string;
    version?: string; serverUrl: string;
  };


};


export class BaseAgent<Env extends BaseAgentEnv> extends Agent<Env> {
  protected options: BaseAgentOptions;
  private mcpServerId?: string;
  protected chatModel: IChatModel;
  mcpMgr: any;

  constructor(state: DurableObjectState, env: Env, options: BaseAgentOptions) {
    super(state, env);
    this.options = options;
    this.mcpMgr = this.mcp;
    this.mcp.onConnected?.((serverId: string) => {
      console.log(`MCP connected: ${serverId}`);
    });
    if (options.defaultModel?.includes('gpt')) {
      this.chatModel = new OpenAIChatModel(this.env.OPENAI_API_KEY);
    } else {
      this.chatModel = new WorkersAIChatModel('');
    }
  }

  private async listMcpTools(): Promise<McpTool[]> {
    // Use the built-in MCP manager from the Agent
    const toolsResult: any = await this.mcp.listTools();
    const tools: McpTool[] =
        Array.isArray(toolsResult) ? toolsResult : toolsResult?.tools ?? [];
    return tools;
  };

  async onStart() {
    const mcp = this.options.mcp;
    if (!mcp?.enabled) return;
    if (this.mcpServerId) return;

    // Prefer the Agent's built-in MCP integration which wires OAuth callbacks
    // correctly
    const transportHeaders: HeadersInit|undefined = this.env.MCP_BEARER_TOKEN ?
        {Authorization: `Bearer ${this.env.MCP_BEARER_TOKEN}`} :
        undefined;

    const {id, authUrl} = await this.addMcpServer(
        mcp.agentId,
        mcp.serverUrl,
        this.env.SERVER_HOST,
        'agents',
        {transport: {headers: transportHeaders, type: 'auto'}},
    );
    this.mcpServerId = id;
    console.log(`Registered MCP server ${id} (${authUrl ? 'oauth pending' : 'connected'})`);
    if (authUrl) {
      console.log('MCP needs OAuth, authorize here:', authUrl);
    } else {
      console.log('Connected to MCP Server:', id);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    if (this.mcp.isCallbackRequest(request)) {
      const result = await this.mcp.handleCallbackRequest(request);
       console.log('MCP OAuth callback result:', result);
      if (result.authSuccess) {
        this.mcpServerId = result.serverId;
        this.mcp.establishConnection(result.serverId)
            .then(() => console.log(`MCP connection established: ${result.serverId}`))
            .catch((err: any) => console.error('MCP connection error:', err));
        return new Response('OAuth authorized. You can close this tab.');
      }
      return new Response(`OAuth error: ${result.authError ?? 'unknown'}`, {
        status: 400,
      });
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
    if (!this.mcpMgr || !this.options.mcp?.enabled) {
      return this.chatModel.query(userContent, options);
    }

    const tools = await this.listMcpTools();
    if (!tools.length) {
      return this.chatModel.query(userContent, options);
    }

    const systemPrompt = buildMcpSystemPrompt(
        tools,
        options.systemPrompt,
    );

    const firstCallOptions: BaseAgentOptions = {
      ...options,
      systemPrompt,
      getUserPrompt: (payload: any) => String(payload),
    };

    const first = await this.chatModel.query(userContent, firstCallOptions);

    let parsed: any;
    try {
      parsed = JSON.parse(first.text?.trim() ?? '');
    } catch {
      return first;
    }

    if (parsed?.type !== 'tool_call') {
      return {
        text: parsed?.answer ?? first.text,
      };
    }

    const toolName: string = parsed.tool;
    const toolArgs: Record<string, unknown> = parsed.arguments ?? {};

    if (!toolName) {
      return {
        text: 'Model Request to use MCP tool, but does not provide a tool name',
      };
    }

    const serverId = this.mcpServerId ??
        tools.find((t) => t.name === toolName)?.serverId ?? tools[0]?.serverId;

    if (!serverId) {
      return {
        text: `No MCP serverId, can't call ${toolName}。`,
      };
    }

    const toolResult = await this.mcpMgr.callTool({
      name: toolName,
      serverId,
      arguments: toolArgs,
    });

    const toolResultJson = JSON.stringify(toolResult, null, 2);

    console.log(toolResultJson);
    const secondUserContent = `
    Original question:
    ${userContent}

    You just called "${toolName}", param is:
    ${JSON.stringify(toolArgs, null, 2)}
    
    The json return there is:
    ${toolResultJson}
  `.trim();

    const secondCallOptions: BaseAgentOptions = {
      ...options,
      systemPrompt: options.systemPrompt ?? 'You are a helpful assistant.',
      getUserPrompt: (payload: any) => String(payload),
    };

    return this.chatModel.query(secondUserContent, secondCallOptions);
  }

  async queryChatModel(
      connection: Connection,
      userContent: string,
      options: BaseAgentOptions,
  ) {
    try {
      const useMcp = !!this.options.mcp?.enabled;

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
