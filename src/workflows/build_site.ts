// build_site.ts
import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep,} from 'cloudflare:workers';

type StartPayload = {
  prompt: string
};

export class BuildSiteFlow extends WorkflowEntrypoint<Env, StartPayload> {}
