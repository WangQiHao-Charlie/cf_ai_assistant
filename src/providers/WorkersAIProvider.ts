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

    const result = await env.AI.run(model as keyof AiModels, chat as any);
    if (typeof result === 'string') {
      return {text: result};
    }
    if (result && typeof result === 'object' && 'response' in result) {
      // Text-generation models return an object with optional `response`
      return {text: (result as {response?: string}).response ?? ''};
    }
    // Fallback for non text-generation outputs
    return {text: ''};
  }
}
