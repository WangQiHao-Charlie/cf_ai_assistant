import OpenAI from 'openai';

import {BaseAgentOptions} from '../agents/BaseAgent';

import {ChatMessage, ChatResponse, IChatModel,} from './AIProviderInterface';

export class OpenAIChatModel implements IChatModel {
  constructor(private apiKey: string) {}

  async query(userContent: string, options?: BaseAgentOptions):
      Promise<ChatResponse> {
    const model = options?.defaultModel ?? 'gpt-5-mini';
    const temperature = options?.temperature ?? 0;

    const client = new OpenAI({apiKey: this.apiKey});

    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({role: 'system', content: options.systemPrompt});
    }
    messages.push({role: 'user', content: userContent});

    const tools = options?.tool ?
        [
          {
            type: 'function' as const,
            function: {
              name: options.tool.name,
              description: options.tool.description,
              parameters: options.tool.parameters,
            },
          },
        ] :
        undefined;

    const tool_choice = options?.tool ?
        {type: 'function' as const, function: {name: options.tool.name}} :
        undefined;

    const response = await client.chat.completions.create({
      model,
      temperature,
      messages,
      tools,
      tool_choice,
    });

    const msg = response.choices?.[0]?.message;
    const tc = msg?.tool_calls?.[0];
    if (tc?.type === 'function') {
      return {json: JSON.parse(tc.function?.arguments ?? '{}')};
    }

    return {text: msg?.content ?? ''};
  }
}
