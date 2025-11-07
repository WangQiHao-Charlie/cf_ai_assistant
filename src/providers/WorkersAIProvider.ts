import {env} from 'cloudflare:workers';

import {BaseAgentOptions} from '../agents/BaseAgent';

import {ChatMessage, ChatResponse, IChatModel,} from './AIProviderInterface';

export class WorkersAIChatModel implements IChatModel {
  constructor(private _apiKey: string) {}

  async query(userContent: string, options?: BaseAgentOptions):
      Promise<ChatResponse> {
    const model = options?.defaultModel ?? '@cf/meta/llama-3-8b-instruct';
    const temperature = options?.temperature ?? 0;

    const systemPrompt =
        options?.systemPrompt ?? 'You are a helpful assistant.';
    // userContent has already been constructed by BaseAgent.getUserPrompt.
    // Do NOT call getUserPrompt again here, or the payload will be lost.
    const userPrompt = userContent;

    const chat = {
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
      temperature,
    } as any;

    try {
      const result = await env.AI.run(model as keyof AiModels, chat as any);
      if (typeof result === 'string') {
        return {text: result};
      }
      if (result && typeof result === 'object' && 'response' in result) {
        return {text: (result as {response?: string}).response ?? ''};
      }
      return {text: ''};
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '');
      // Some models expect `{ input }` instead of chat `messages`. Retry once.
      if (/oneOf|required properties|input|requests/i.test(msg)) {
        const fallback = {input: [systemPrompt, userPrompt].filter(Boolean).join('\n\n')};
        const result = await env.AI.run(model as keyof AiModels, fallback as any);
        if (typeof result === 'string') return {text: result};
        if (result && typeof result === 'object' && 'response' in result) {
          return {text: (result as {response?: string}).response ?? ''};
        }
        return {text: ''};
      }
      throw err;
    }
  }
}
