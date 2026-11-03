/** Generic tool-calling loop over an OpenAI-compatible client. */
import type { ModelClient, Message, ToolDef, ToolCall } from '../models/client.js';
import type { Role } from '../config.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

export interface LoopOptions {
  system: string;
  user: string;
  tools: ToolDef[];
  handlers: Record<string, ToolHandler>;
  maxTurns: number;
  maxTokens?: number;
  role?: Role;
  /** Called after every model turn (for live console output). */
  onTurn?: (turn: number, msg: Message, calls: ToolCall[]) => void;
  /** Return true to stop the loop (e.g. when the `finish` tool was called). */
  isDone: () => boolean;
  log?: (s: string) => void;
  /** Resume a previous conversation (system/user are ignored when set); `user` is appended as a new user turn. */
  resume?: Message[];
}

export interface LoopResult { turns: number; messages: Message[]; stoppedBy: 'finish' | 'max_turns' | 'no_tool_call' }

export async function runToolLoop(client: ModelClient, o: LoopOptions): Promise<LoopResult> {
  const messages: Message[] = o.resume ? [...o.resume, { role: 'user', content: o.user }] : [{ role: 'system', content: o.system }, { role: 'user', content: o.user }];
  for (let turn = 1; turn <= o.maxTurns; turn++) {
    const res = await client.chat(messages, { tools: o.tools, role: o.role, maxTokens: o.maxTokens });
    const calls = res.message.tool_calls ?? [];
    messages.push(res.message);
    o.onTurn?.(turn, res.message, calls);
    if (calls.length === 0) {
      // Nudge once: models sometimes answer in prose instead of calling finish.
      if (o.isDone()) return { turns: turn, messages, stoppedBy: 'finish' };
      messages.push({ role: 'user', content: 'Continue by calling a tool. When you are done, call `finish`.' });
      if (turn === o.maxTurns) return { turns: turn, messages, stoppedBy: 'no_tool_call' };
      continue;
    }
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch (e) { messages.push({ role: 'tool', tool_call_id: c.id, content: `ERROR: arguments are not valid JSON (${(e as Error).message})` }); continue; }
      const h = o.handlers[c.function.name];
      let out: string;
      try { out = h ? await h(args) : `ERROR: unknown tool ${c.function.name}`; } catch (e) { out = `ERROR: ${(e as Error).message}`; }
      o.log?.(`  ↳ ${c.function.name}(${short(c.function.arguments)}) → ${short(out, 160)}`);
      messages.push({ role: 'tool', tool_call_id: c.id, content: truncate(out, 24000) });
    }
    if (o.isDone()) return { turns: turn, messages, stoppedBy: 'finish' };
  }
  return { turns: o.maxTurns, messages, stoppedBy: 'max_turns' };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
function short(s: string, n = 100): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}
