import {ChatResponse, IChatModel} from './AIProviderInterface';

export class CachedChatModel implements IChatModel {
  constructor(private canned: any) {}

  async query(_userContent: string): Promise<ChatResponse> {
    return {json: this.canned};
  }
}

