import {getServerByName, type Server} from 'partyserver';
import type {Env} from './types';

type WarmupState = {
  promise?: Promise<void>;
  done?: boolean;
};

const warmupState: WarmupState = {};

async function warmupAgents(env: Env) {
  const flag = (v: unknown) => String(v || '').toLowerCase();
  const isOn = (v: unknown) => ['1', 'true', 'yes'].includes(flag(v));
  // Only warm Planner by default; Coder/Operator warmup opt-in to avoid DO contention
  const warmCoder = isOn((env as any).WARM_CODER_ON_BOOT);
  const warmOperator = isOn((env as any).WARM_OPERATOR_ON_BOOT);
  const warmFull = isOn((env as any).WARM_FULL_ON_BOOT);

  async function getByNameRetry(binding: any, name: string) {
    let lastErr: any;
    for (let i = 0; i < 3; i++) {
      try {
        return await getServerByName(binding, name);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr;
  }

  const agents: Array<{name: string; stub: DurableObjectStub<Server>}> = [
    {name: 'planner', stub: await getByNameRetry(env.CFA_PLAN_AGENT, 'plan')},
    ...(warmCoder ? [{name: 'coder', stub: await getByNameRetry(env.CFA_CODE_AGENT, 'code')}] : []),
    ...(warmOperator ? [{name: 'operator', stub: await getByNameRetry(env.CFA_OP_AGENT, 'op')}] : []),
    ...(warmFull ? [{name: 'full', stub: await getByNameRetry(env.CFA_FULL_AGENT, 'full')}] : []),
  ];

  // Warm agents sequentially to avoid DO contention during first boot,
  // which can trigger blockConcurrencyWhile timeouts under load.
  for (const {name, stub} of agents) {
    try {
      const warmupReq = new Request('https://mcp.local/warmup', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({warmup: true}),
      });
      const res = await stub.fetch(warmupReq);
      const data: any = await res.json().catch(() => ({}));
      const pending = Array.isArray(data?.pendingAuth) ? data.pendingAuth : [];
      if (pending.length) {
        console.warn(`[warmup:${name}] MCP OAuth required for ${pending.length} server(s):`);
        for (const entry of pending) {
          if (entry?.authUrl && entry?.serverUrl) {
            console.warn(`  - ${entry.serverUrl} -> ${entry.authUrl}`);
          } else {
            console.warn(`  - pending entry: ${JSON.stringify(entry)}`);
          }
        }
      } else {
        console.log(`[warmup:${name}] MCP ready (no pending OAuth).`);
      }
    } catch (err) {
      console.error(`[warmup:${name}] failed:`, err);
    }
  }
}

export async function ensureAgentsWarmed(env: Env) {
  if (warmupState.done) return;
  if (!warmupState.promise) {
    warmupState.promise =
        warmupAgents(env)
            .catch((err) => {
              console.error('[warmup] error during warmup:', err);
            })
            .finally(() => {
              warmupState.done = true;
              warmupState.promise = undefined;
            });
  }
  await warmupState.promise;
}
