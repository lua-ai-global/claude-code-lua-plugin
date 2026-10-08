// Thread-history fetch and normalisation.
//
// VERIFICATION NOTE (V1), status at build time: the route and the stored thread form could NOT be probed live
// during this build (no sandbox agent was available and the build rules forbid touching a real agent). What is
// known from the installed lua-cli 3.45.0 bundle:
//   - GET /chat/history/{agentId} exists (User.getChatHistory), returning `data` as an array of
//     { role, content: [...parts], createdAt }.
//   - The DELETE form accepts ?threadId=; the GET form shows no threadId parameter in the CLI. So the GET may
//     return the whole history, and whether `?threadId=` filters is UNVERIFIED.
// The parser therefore never assumes scoping: it sends ?threadId= anyway, accepts both stored thread forms
// (`<thread>` and `<userId>-<agentId>:<thread>`), and reports `scoped:false` when the payload carries no thread
// ids at all. Contamination then degrades to UNVERIFIED (the run still counts, flagged) and tool calls are
// matched by user-message text. Re-check this with a throwaway `qa-probe-<hex>` thread when a sandbox is available.

import { qaApiRequest } from './api.mjs';

const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

function roleOf(raw) {
  const r = String(raw ?? '').toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'ai' || r === 'model') return 'assistant';
  if (r === 'tool' || r === 'function') return 'tool';
  return 'system';
}

function threadOf(m) {
  const t = m?.threadId ?? m?.thread ?? m?.threadKey ?? m?.metadata?.threadId ?? null;
  return typeof t === 'string' && t ? t : null;
}

export function threadMatches(stored, thread) {
  return !!stored && (stored === thread || stored.endsWith(`:${thread}`));
}

function toolStatus(output, isError, state) {
  if (isError === true || state === 'error') return 'error';
  if (output && typeof output === 'object' && (output.status === 'error' || output.error)) return 'error';
  if (output === undefined || output === null) return 'unknown';
  return 'ok';
}

function partsOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? { type: 'text', text: p } : p)).filter(Boolean);
  if (content && typeof content === 'object') return [content];
  return [];
}

function unwrapMessages(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.messages)) return payload.data.messages;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

/**
 * @returns {{role:'user'|'assistant'|'tool'|'system', text:string, toolCalls:Array<{name:string,input:any,output:any,status:string}>, at:string|null, threadId:string|null}[]}
 */
export function normaliseHistory(payload, { thread } = {}) {
  const raw = unwrapMessages(payload);
  let list = raw;
  if (thread && raw.some((m) => threadOf(m))) list = raw.filter((m) => threadMatches(threadOf(m), thread));
  const byId = new Map();
  const out = [];
  for (const m of list) {
    const role = roleOf(m?.role ?? m?.type);
    const text = [];
    const toolCalls = [];
    for (const p of partsOf(m?.content ?? m?.parts ?? m?.text)) {
      const type = String(p?.type ?? '');
      if (type === 'text' || (!type && typeof p?.text === 'string')) {
        text.push(String(p.text ?? ''));
      } else if (type === 'tool-invocation' && p.toolInvocation) {
        const ti = p.toolInvocation;
        toolCalls.push({ name: String(ti.toolName ?? ''), input: ti.args ?? ti.input ?? null, output: ti.result ?? ti.output ?? null, status: toolStatus(ti.result ?? ti.output, false, ti.state) });
      } else if (type === 'tool-call' || type === 'tool' || (type.startsWith('tool-') && type !== 'tool-result')) {
        const call = { name: String(p.toolName ?? p.name ?? type.replace(/^tool-/, '')), input: p.input ?? p.args ?? null, output: p.output ?? p.result ?? null, status: 'unknown' };
        call.status = toolStatus(call.output, p.isError, p.state);
        toolCalls.push(call);
        if (p.toolCallId) byId.set(p.toolCallId, call);
      } else if (type === 'tool-result') {
        const output = p.output ?? p.result ?? null;
        const known = p.toolCallId ? byId.get(p.toolCallId) : null;
        if (known) {
          known.output = output;
          known.status = toolStatus(output, p.isError, p.state);
        } else {
          toolCalls.push({ name: String(p.toolName ?? p.name ?? ''), input: null, output, status: toolStatus(output, p.isError, p.state) });
        }
      }
    }
    out.push({ role, text: text.join('\n').trim(), toolCalls, at: m?.createdAt ?? m?.at ?? null, threadId: threadOf(m) });
  }
  return out;
}

export const PLACEHOLDER_RE = /\[(?:a secret|a long code|pasted (?:instruction|text)|secret|hidden)/;

/** True when a stored user message plausibly is `sent` (whitespace-normalised, 300-char cut, placeholder prefix rule). */
export function userTextMatches(stored, sent) {
  const a = normText(stored);
  const b = normText(sent);
  if (!a || !b) return false;
  if (a === b) return true;
  const head = normText(a.split(PLACEHOLDER_RE)[0]).slice(0, 120);
  return !!head && (b.startsWith(head) || head.startsWith(b.slice(0, 120)));
}

/** Tool calls stored between this user message and the next one. */
export function toolCallsForTurn(messages, { userText, nextUserText } = {}) {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && userTextMatches(messages[i].text, userText)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const calls = [];
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      if (!nextUserText || userTextMatches(m.text, nextUserText)) break;
      if (!m.text.startsWith('[')) break;
      continue;
    }
    calls.push(...m.toolCalls);
  }
  return calls;
}

/**
 * @returns {Promise<{source:'history'|'unavailable', scoped:boolean, messages:any[], raw?:any, error?:string}>}
 */
export async function fetchThreadHistory({ agentId, thread, deps = {}, timeoutMs = 15_000 }) {
  if (!agentId) return { source: 'unavailable', scoped: false, messages: [], error: 'no agent id' };
  let res;
  try {
    res = await qaApiRequest(`/chat/history/${encodeURIComponent(agentId)}`, { query: { threadId: thread }, deps, timeoutMs });
  } catch (err) {
    return { source: 'unavailable', scoped: false, messages: [], error: `${err.code ?? 'ERROR'}: ${err.message}` };
  }
  const rawMessages = unwrapMessages(res);
  const anyThread = rawMessages.some((m) => threadOf(m));
  const messages = normaliseHistory(res, { thread });
  return { source: 'history', scoped: anyThread, messages, raw: res };
}
