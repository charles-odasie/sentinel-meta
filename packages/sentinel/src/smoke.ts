/**
 * Smoke test: one chat call + one tool call per configured provider. Prints latency,
 * usage and rate-limit headers. Never prints keys. Runs behind the egress guard.
 */
import { providerFor, hasKey, apiKey, type ProviderId } from './config.js';
import { ledger } from './egress/ledger.js';
import { ModelClient } from './models/client.js';

const ids: ProviderId[] = ['baseten', 'fireworks', 'meta'];
const configured = ids.map(providerFor).filter(hasKey);
if (!configured.length) { console.error('No provider key found. Set BASETEN_API_KEY (and optionally FIREWORKS_API_KEY, MODEL_API_KEY).'); process.exit(1); }
ledger.setAllowList(configured.map((p) => p.host));
ledger.install();

for (const p of configured) {
  console.log(`\n=== ${p.label} — ${p.model} @ ${p.host}`);
  // raw call to see headers
  const t0 = Date.now();
  const res = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey(p)}` }, body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 16, temperature: 0 }) });
  const txt = await res.text();
  console.log(`chat: HTTP ${res.status} in ${Date.now() - t0} ms`);
  const rl = [...res.headers.entries()].filter(([k]) => /ratelimit|retry-after|x-request-id/i.test(k));
  if (rl.length) console.log('  headers:', Object.fromEntries(rl));
  try { const j = JSON.parse(txt); console.log('  reply:', JSON.stringify(j.choices?.[0]?.message?.content), 'usage:', j.usage); } catch { console.log('  body:', txt.slice(0, 300)); }
  if (!res.ok) continue;

  const client = new ModelClient(p);
  const t1 = Date.now();
  try {
    const r = await client.chat([
      { role: 'system', content: 'You must use the provided tool.' },
      { role: 'user', content: 'What is the weather in Bangkok? Use the tool.' },
    ], { tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }], maxTokens: 256 });
    console.log(`tool call: ${Date.now() - t1} ms, finish=${r.finishReason}, tool_calls=${JSON.stringify(r.message.tool_calls?.map((c) => ({ name: c.function.name, args: c.function.arguments })))}`);
    if (r.message.tool_calls?.length) {
      const r2 = await client.chat([
        { role: 'user', content: 'What is the weather in Bangkok? Use the tool.' },
        r.message,
        { role: 'tool', tool_call_id: r.message.tool_calls[0].id, content: JSON.stringify({ city: 'Bangkok', temp_c: 31, sky: 'cloudy' }) },
      ], { maxTokens: 128 });
      console.log(`tool result round-trip OK: ${JSON.stringify(r2.message.content).slice(0, 120)}`);
    } else console.log('  ⚠ model did not call the tool');
  } catch (e) { console.log('tool call FAILED:', (e as Error).message); }
}
console.log('\nledger:', JSON.stringify(ledger.summary()));
