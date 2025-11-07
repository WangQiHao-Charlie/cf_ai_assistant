// build_site.ts
import {WorkflowEntrypoint, WorkflowEvent, WorkflowStep,} from 'cloudflare:workers';

import type {Env} from '../worker/types';

type StartPayload = {
  prompt: string
};

type PlanResult = {
  type: 'done';
  text?: string;
  json?: any
};
type AgentResult = {
  type: 'done'|'error';
  text?: string;
  json?: any;
  error?: string
};

export class BuildSiteFlow extends WorkflowEntrypoint<Env, StartPayload> {
  async run(event: WorkflowEvent<StartPayload>, step: WorkflowStep) {
    const origin = this.env.SERVER_HOST ?? 'http://127.0.0.1:8787';
    const inputPrompt = event.payload.prompt ?? '';

    // 1) Planner: get a Cloudflare-only plan JSON
    const plan = await step.do('planner', async () => {
      const res = await fetch(`${origin}/run/plan`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({prompt: inputPrompt}),
      });
      const data = (await res.json()) as PlanResult;
      console.log('[workflow] planner result:', JSON.stringify(data));
      return data;
    });

    // 2) Full-stack agent handles build + deploy (preferred path)
    const full = await step.do('fullstack', async () => {
      const plannerJson = plan?.json ?? {};
      const devSpec = plannerJson.development_plan ?? plannerJson;
      const deploySpec = plannerJson.deployment_plan ?? plannerJson;

      const res = await fetch(`${origin}/run/full`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          prompt: JSON.stringify({
            role: 'fullstack',
            original_prompt: inputPrompt,
            planner: plannerJson,
            development_plan: devSpec,
            deployment_plan: deploySpec,
          }),
        }),
      });
      const data = (await res.json()) as AgentResult;
      console.log('[workflow] fullstack result:', JSON.stringify(data));
      return data;
    });

    // If FullStack failed or stalled, fall back to Coder -> Operator sequence
    let fallback: {code?: AgentResult; op?: AgentResult} | undefined;
    try {
      const fjson: any = (full as any)?.json ?? {};
      const fAnswer = fjson && typeof fjson === 'object' ? (fjson.answer ?? {}) : {};
      // Consider FullStack successful only if it produced a public URL
      const fullOk = !!(fAnswer && typeof fAnswer === 'object' && fAnswer.public_url);

      if (!fullOk) {
        const plannerJson = plan?.json ?? {};
        const devSpec = plannerJson.development_plan ?? plannerJson;
        const deploySpec = plannerJson.deployment_plan ?? plannerJson;

        // 2b) Coder: build artifacts and return site_zip_base64
        const code = await step.do('coder', async () => {
          const res = await fetch(`${origin}/run/code`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              prompt: JSON.stringify({
                role: 'coder',
                original_prompt: inputPrompt,
                planner: plannerJson,
                development_plan: devSpec,
              }),
            }),
          });
          const data = (await res.json()) as AgentResult;
          console.log('[workflow] coder result:', JSON.stringify(data));
          return data;
        });

        // 2c) Operator: deploy artifacts to Pages using coder_result
        const op = await step.do('operator', async () => {
          const res = await fetch(`${origin}/run/op`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              prompt: JSON.stringify({
                role: 'operator',
                original_prompt: inputPrompt,
                planner: plannerJson,
                deployment_plan: deploySpec,
                coder_result: (code as any) ?? {},
              }),
            }),
          });
          const data = (await res.json()) as AgentResult;
          console.log('[workflow] operator result:', JSON.stringify(data));
          return data;
        });

        fallback = {code, op};
      }
    } catch (_) {
      // best-effort fallback; ignore errors here and return what we have
    }

    try {
      const fjson = (full as any)?.json;
      if (fjson && typeof fjson === 'object' && fjson.type === 'error') {
        const authRes = await fetch(`${origin}/mcp/auth`).catch(() => null);
        const authJson = authRes && authRes.ok ? await authRes.json() : null;
        return {plan, full: {...full, auth: authJson}, fallback};
      }
    } catch (_) {
      // ignore, return whatever we have
    }

    return {plan, full, fallback};
  }
}
