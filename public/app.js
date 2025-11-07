const $ = (sel) => document.querySelector(sel);
const setBusy = (btn, busy) => { if (!btn) return; btn.disabled = !!busy; btn.dataset.busy = busy ? '1' : ''; };

async function jsonPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  try { return { ok: res.ok, data: JSON.parse(text) }; } catch { return { ok: res.ok, data: text }; }
}

function pretty(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function extractPlans(planJson) {
  const plannerJson = planJson || {};
  const dev = plannerJson.development_plan ?? plannerJson;
  const dep = plannerJson.deployment_plan ?? plannerJson;
  return { plannerJson, dev, dep };
}

function renderAuth(data) {
  const el = $('#auth-status');
  el.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'auth-grid';
  const roles = [
    ['planner', 'Planner'],
    ['coder', 'Coder'],
    ['operator', 'Operator'],
    ['fullstack', 'Full‑stack'],
  ];
  for (const [key, label] of roles) {
    const items = Array.isArray(data?.[key]) ? data[key] : [];
    const card = document.createElement('div');
    card.className = 'role';
    const h = document.createElement('h4');
    h.textContent = `${label}`;
    card.appendChild(h);
    const box = document.createElement('div');
    box.className = 'linklist';
    if (!items.length) {
      const p = document.createElement('div');
      p.textContent = 'No authorization needed.';
      p.style.color = 'var(--muted)';
      box.appendChild(p);
    } else {
      for (const it of items) {
        const url = String(it?.authUrl || '');
        const srv = String(it?.serverUrl || '');
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.className = 'btn';
        const host = (() => { try { return new URL(srv).host; } catch { return srv; }})();
        a.textContent = `Authorize ${label} @ ${host}`;
        box.appendChild(a);
      }
    }
    card.appendChild(box);
    grid.appendChild(card);
  }
  el.appendChild(grid);
}

async function checkAuth() {
  const el = $('#auth-status');
  el.textContent = 'Fetching authorization status...';
  try {
    const res = await fetch('/mcp/auth');
    const data = await res.json();
    renderAuth(data);
  } catch (e) {
    el.textContent = 'Failed to fetch: ' + e;
  }
}

async function runPlanner(prompt) {
  const r = await jsonPost('/run/plan', { prompt });
  if (!r.ok) throw new Error('planner 调用失败');
  return r.data;
}

async function runCoder(originalPrompt, plannerJson) {
  const { dev, plannerJson: pj } = extractPlans(plannerJson);
  const payload = {
    role: 'coder',
    original_prompt: originalPrompt,
    planner: pj,
    development_plan: dev,
  };
  const r = await jsonPost('/run/code', { prompt: JSON.stringify(payload) });
  if (!r.ok) throw new Error('coder 调用失败');
  return r.data;
}

async function runFull(originalPrompt, plannerJson) {
  const { dev, dep, plannerJson: pj } = extractPlans(plannerJson);
  const payload = {
    role: 'fullstack',
    original_prompt: originalPrompt,
    planner: pj,
    development_plan: dev,
    deployment_plan: dep,
  };
  const r = await jsonPost('/run/full', { prompt: JSON.stringify(payload) });
  if (!r.ok) throw new Error('fullstack 调用失败');
  return r.data;
}

// Wire UI
window.addEventListener('DOMContentLoaded', () => {
  $('#btn-auth-check')?.addEventListener('click', () => checkAuth());

  // Step 1: Planner only
  $('#btn-plan')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    setBusy(btn, true);
    const input = $('#p1-input').value.trim();
    const out = $('#p1-output');
    out.textContent = '调用 Planner 中...\n请确保已完成 OAuth 授权（/mcp/auth）。';
    try {
      const planRes = await runPlanner(input);
      out.textContent = pretty(planRes);
    } catch (e) {
      out.textContent = '失败：' + e;
    } finally {
      setBusy(btn, false);
    }
  });

  // Step 2: Planner + Coder
  $('#btn-plan-code')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    setBusy(btn, true);
    const input = $('#p2-input').value.trim();
    const out = $('#p2-output');
    out.textContent = '先调用 Planner...\n';
    try {
      const planRes = await runPlanner(input);
      out.textContent = 'Planner 完成，调用 Coder...\n';
      const coderRes = await runCoder(input, planRes.json || planRes);
      out.textContent = pretty({ plan: planRes, code: coderRes });
    } catch (e) {
      out.textContent = '失败：' + e;
    } finally {
      setBusy(btn, false);
    }
  });

  // Step 3: Planner + Full-stack (experimental)
  $('#btn-plan-full')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    setBusy(btn, true);
    const input = $('#p3-input').value.trim();
    const out = $('#p3-output');
    out.textContent = '注意：该功能为 experimental，部署环节可能不稳定。\n先调用 Planner...\n';
    try {
      const planRes = await runPlanner(input);
      out.textContent += 'Planner 完成，调用 Full‑stack...\n';
      const fullRes = await runFull(input, planRes.json || planRes);
      out.textContent = pretty(fullRes);
    } catch (e) {
      out.textContent += '\n失败：' + e;
    } finally {
      setBusy(btn, false);
    }
  });

  // ping message endpoint into footer
  fetch('/message').then(r => r.text()).then(t => {
    const el = document.getElementById('ping');
    if (el) el.textContent = ' | ' + t;
  }).catch(() => {});
});
