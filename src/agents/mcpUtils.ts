export function stripJsonComments(text: string): string {
  let result = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      result += ch;
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      result += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i++;
      while (i + 1 < text.length) {
        const ahead = text[i + 1];
        if (ahead === '\n' || ahead === '\r') break;
        i++;
      }
      continue;
    }
    result += ch;
  }
  return result;
}

export function tryParseJsonWithComments(text?: string): any|undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      const cleaned = stripJsonComments(trimmed);
      if (cleaned !== trimmed) return JSON.parse(cleaned);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function extractJsonObjectsFromText(text: string): any[] {
  const out: any[] = [];
  if (typeof text !== 'string') return out;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      continue;
    } else {
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          const parsed = tryParseJsonWithComments(slice);
          if (parsed !== undefined) out.push(parsed);
          start = -1;
        }
        continue;
      }
    }
  }
  return out;
}

// Attempt to salvage a truncated tool_call from a JSON-looking string.
// Focus on container_file_write with shape:
// { "type": "tool_call", "tool": "container_file_write", "arguments": { "args": { "path": "...", "text": "...possibly truncated" } } }
export function tryExtractTruncatedToolCall(text: string): {name: string, args: Record<string, unknown>} | null {
  if (typeof text !== 'string') return null;
  // Quick signal checks
  if (!text.includes('"type"') || !text.includes('tool_call')) return null;
  if (!text.includes('container_file_write')) return null;

  // Extract path
  const pathMatch = text.match(/"path"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (!pathMatch) return null;
  const rawPath = pathMatch[1];

  // Find the start of the text field value
  const textKeyIdx = text.indexOf('"text"');
  if (textKeyIdx < 0) return null;
  const colonIdx = text.indexOf(':', textKeyIdx);
  if (colonIdx < 0) return null;
  // Find opening quote for the JSON string value
  let i = colonIdx + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '"') return null;
  i++; // move past opening quote
  // Read until end or until we would have closed the string; tolerate truncation
  let buf = '';
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      buf += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      // Found closing quote (not truncated)
      break;
    }
    buf += ch;
  }

  // Unescape minimal JSON string escapes
  const unescaped = buf
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

  // Basic sanity
  if (!rawPath) return null;
  const path = rawPath
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

  return {
    name: 'container_file_write',
    args: { args: { path, text: unescaped } },
  };
}

export function inferSiteRoot(paths: string[]): string|undefined {
  if (!paths.length) return undefined;
  const counts = new Map<string, number>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw) continue;
    const top = raw.includes('/') ? raw.split('/')[0] : '.';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  if (!counts.size) return '.';
  let best = '.';
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

export function collectToolResultText(result: any): string|undefined {
  if (!result) return undefined;
  if (typeof result.text === 'string') return result.text;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
                    .map((item) => {
                      if (typeof item?.text === 'string') return item.text;
                      if (typeof item?.body === 'string') return item.body;
                      return '';
                    })
                    .filter(Boolean);
  const text = parts.join('\n').trim();
  return text || undefined;
}

export function coerceToolArgs(toolName: string, raw: any): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  if ('arguments' in raw) return raw as Record<string, unknown>;
  if ('args' in raw) return raw as Record<string, unknown>;
  const norm = (v: unknown) => (v === undefined || v === null) ? undefined : v;
  switch (toolName) {
    case 'container_file_write': {
      const path = norm((raw as any).path) ?? norm((raw as any).file_path);
      const text = norm((raw as any).text) ?? norm((raw as any).file_content) ?? norm((raw as any).content);
      return {args: {path, text}};
    }
    case 'container_file_delete':
    case 'container_file_read': {
      const path = norm((raw as any).path) ?? norm((raw as any).file_path);
      return {args: {path}};
    }
    case 'container_exec': {
      // Accept {command}, {cmd}, or {args}
      let argStr = (raw as any).args ?? (raw as any).command ?? (raw as any).cmd;
      if (Array.isArray(argStr)) argStr = argStr.join(' ');
      return {args: {args: String(argStr ?? ''), timeout: (raw as any).timeout, streamStderr: (raw as any).streamStderr ?? true}};
    }
    case 'container_files_list':
    case 'container_initialize':
    case 'container_ping':
      return {};
    default:
      // For non-container tools, pass raw through unchanged
      return (raw ?? {}) as Record<string, unknown>;
  }
}

export function extractToolCalls(obj: any): Array<{name: string, args: Record<string, unknown>}>|null {
  if (!obj || typeof obj !== 'object') return null;
  const canonical = (name: string) =>
      name ? name.replace(/[\.\-\s]/g, '_') : name;
  const known = new Set([
    'container_initialize',
    'container_ping',
    'container_exec',
    'container_file_write',
    'container_file_delete',
    'container_files_list',
    'container_file_read',
  ]);

  // Standard shape
  if ((obj as any).type === 'tool_call' && ((obj as any).tool || (obj as any).function_name)) {
    const name = canonical((obj as any).tool ?? (obj as any).function_name);
    const rawArgs = ((obj as any).arguments ?? (obj as any).args ?? (obj as any).function_arg ?? {}) as Record<string, unknown>;
    return [{name, args: coerceToolArgs(name, rawArgs)}];
  }
  if ((obj as any).function_name) {
    const name = canonical((obj as any).function_name);
    const rawArgs = ((obj as any).function_arg ?? (obj as any).arguments ?? (obj as any).args ?? {}) as Record<string, unknown>;
    return [{name, args: coerceToolArgs(name, rawArgs)}];
  }

  // Top-level tool keys shape: { "container_exec": { ... } }
  const calls: Array<{name: string, args: Record<string, unknown>}> = [];
  for (const k of Object.keys(obj)) {
    const cname = canonical(k);
    if (known.has(cname)) {
      calls.push({name: cname, args: coerceToolArgs(cname, (obj as any)[k])});
    }
  }
  if (calls.length) return calls;
  return null;
}
