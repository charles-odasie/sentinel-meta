/**
 * Minimal OpenAI-compatible chat-completions client with tool calling, retries and
 * token accounting. No SDK: one fetch, so the egress guard sees exactly one host.
 */
import { apiKey, type ProviderConfig, type Role } from '../config.js';
import { ledger } from '../egress/ledger.js';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatResult {
  message: Extract<Message, { role: 'assistant' }>;
  finishReason: string;
  usage: { prompt: number; completion: number };
  ms: number;
  raw: unknown;
}

export interface ChatOptions {
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  role?: Role;
  signal?: AbortSignal;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export class ModelClient {
  constructor(readonly provider: ProviderConfig, readonly maxRetries = 5) {}

  async chat(messages: Message[], opts: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.provider.model,
      messages: messages.map(stripReasoning),
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 4096,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto'; // Meta Model API accepts only "auto"
    }
    const payload = JSON.stringify(body);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const t0 = Date.now();
      let res: Response | undefined;
      let text = '';
      let networkErr: unknown;
      try {
        res = await fetch(`${this.provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey(this.provider)}` },
          body: payload,
          signal: opts.signal,
        });
        text = await res.text();
      } catch (e) {
        networkErr = e;
      }
      const ms = Date.now() - t0;
      const status = res?.status ?? 0;
      let json: any = undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error body */ }
      const usage = { prompt: Number(json?.usage?.prompt_tokens ?? 0), completion: Number(json?.usage?.completion_tokens ?? 0) };
      ledger.recordRequest({
        ts: new Date().toISOString(), provider: this.provider.id, model: this.provider.model, host: this.provider.host,
        status, ms, bytesOut: Buffer.byteLength(payload), bytesIn: Buffer.byteLength(text),
        promptTokens: usage.prompt, completionTokens: usage.completion, role: opts.role ?? 'reasoner', retries: attempt,
      });
      if (res && res.ok && json?.choices?.[0]) {
        const choice = json.choices[0];
        const m = choice.message ?? {};
        return {
          message: { role: 'assistant', content: m.content ?? null, tool_calls: normaliseToolCalls(m.tool_calls), reasoning_content: m.reasoning_content ?? m.reasoning },
          finishReason: String(choice.finish_reason ?? ''),
          usage, ms, raw: json,
        };
      }
      const retryable = networkErr ? !(networkErr as any)?.code?.includes('EEGRESSBLOCKED') : RETRYABLE.has(status);
      if (!retryable || attempt >= this.maxRetries) {
        const detail = networkErr ? String((networkErr as Error).message ?? networkErr) : `${status} ${text.slice(0, 500)}`;
        throw new Error(`${this.provider.id}/${this.provider.model} request failed: ${detail}`);
      }
      const retryAfter = Number(res?.headers.get('retry-after') ?? 0) * 1000;
      const backoff = Math.min(30000, retryAfter || 1000 * 2 ** attempt + Math.random() * 500);
      attempt += 1;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

function stripReasoning(m: Message): Message {
  if (m.role === 'assistant') {
    const { reasoning_content: _r, ...rest } = m;
    if (!rest.tool_calls?.length) delete (rest as any).tool_calls;
    return rest;
  }
  return m;
}

function normaliseToolCalls(tc: unknown): ToolCall[] | undefined {
  if (!Array.isArray(tc) || tc.length === 0) return undefined;
  return tc.map((c: any, i: number) => ({
    id: String(c.id ?? `call_${i}`),
    type: 'function' as const,
    function: { name: String(c.function?.name ?? ''), arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}) },
  }));
}

export function estimateCostUsd(p: ProviderConfig, promptTokens: number, completionTokens: number): number | null {
  if (p.priceIn == null || p.priceOut == null) return null;
  return (promptTokens * p.priceIn + completionTokens * p.priceOut) / 1_000_000;
}
