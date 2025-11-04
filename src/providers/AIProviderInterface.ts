import {BaseAgentOptions} from '../agents/BaseAgent';

export interface ChatMessage {
  role: 'system'|'user';
  content: string;
}

export interface ChatTool {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export interface ChatResponse {
  text?: string;
  json?: any;
}

export interface IChatModel {
  query(
      userContent: string,
      options?: BaseAgentOptions,
      ): Promise<ChatResponse>;
}
