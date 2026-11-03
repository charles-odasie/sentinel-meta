/** Privacy Receipt: what left the machine, to where, and what the sandbox proved. */
import { ledger } from './ledger.js';
import { sandboxStats } from '../sandbox.js';
import { estimateCostUsd } from '../models/client.js';
import type { ProviderConfig } from '../config.js';

export interface ReceiptInput {
  runId: string;
  startedAt: string;
  finishedAt: string;
  models: { role: string; provider: ProviderConfig }[];
  disclosures: { file: string; ranges: string[]; bytes: number }[];
  oracleScoped: boolean;
  logFile: string;
  logBytes: number;
}

export function buildReceipt(i: ReceiptInput) {
  const s = ledger.summary();
  const perModel = i.models.map(({ role, provider }) => {
    const reqs = ledger.requests.filter((r) => r.provider === provider.id);
    const p = reqs.reduce((a, r) => a + r.promptTokens, 0), c = reqs.reduce((a, r) => a + r.completionTokens, 0);
    return { role, provider: provider.id, label: provider.label, model: provider.model, endpoint: provider.baseUrl, openWeights: provider.openWeights, requests: reqs.length, promptTokens: p, completionTokens: c, estCostUsd: estimateCostUsd(provider, p, c) };
  });
  const totalCost = perModel.reduce<number | null>((a, m) => (a == null || m.estCostUsd == null ? (m.requests ? null : a) : a + m.estCostUsd), 0);
  return {
    runId: i.runId, startedAt: i.startedAt, finishedAt: i.finishedAt,
    inference: perModel,
    network: { allowList: s.allowList, allowedConnections: s.allowedConnects, blockedAttempts: s.blockedConnects, requests: s.requests, bytesOut: s.bytesOut, bytesIn: s.bytesIn },
    disclosed: { log: { file: i.logFile, bytes: i.logBytes }, repoOracleScoped: i.oracleScoped, files: i.disclosures, totalBytes: i.disclosures.reduce((a, d) => a + d.bytes, 0) },
    sandbox: { mechanism: sandboxStats.sandboxedCommands > 0 ? 'linux network namespace (unshare -n): no interfaces except loopback, no routes' : 'NONE — commands ran with host networking', commands: sandboxStats.commands, sandboxedCommands: sandboxStats.sandboxedCommands, canary: sandboxStats.canary },
    estCostUsd: totalCost,
    claims: {
      proves: [
        'The Sentinel process opened TCP connections only to the allow-listed inference host(s) listed above; every other connect attempt was blocked before any byte was sent (process-wide net.Socket hook, see network.blockedAttempts).',
        'Every test, git and trigger command ran in a network namespace with no route to the outside; the canary connect from inside that namespace failed.',
        'The model received only the production log plus the file ranges listed under disclosed.files (when the Repo Oracle is scoped).',
      ],
      doesNotProve: [
        'What the inference provider does with the bytes it received. Baseten documents zero-data-retention for this model; we cite it, we cannot verify it from here.',
        'Anything about processes outside Sentinel on this machine.',
        'That the in-process hook is unbypassable by hostile code inside Sentinel itself (it is a guard against mistakes and third-party SDK telemetry, not against an attacker running in the same process). Self-host the open weights for a stronger guarantee.',
      ],
    },
  };
}

export type Receipt = ReturnType<typeof buildReceipt>;

export function receiptMarkdown(r: Receipt): string {
  const money = (v: number | null) => (v == null ? 'UNVERIFIED price' : `$${v.toFixed(4)}`);
  const L: string[] = [];
  L.push(`# Privacy Receipt — run ${r.runId}`, '', `Started ${r.startedAt} · finished ${r.finishedAt}`, '');
  L.push('## Inference endpoints used', '', '| role | model | endpoint | open weights | requests | tokens in / out | est. cost |', '|---|---|---|---|---|---|---|');
  for (const m of r.inference) L.push(`| ${m.role} | \`${m.model}\` | ${m.endpoint} | ${m.openWeights ? 'yes' : 'no'} | ${m.requests} | ${m.promptTokens} / ${m.completionTokens} | ${money(m.estCostUsd)} |`);
  L.push('', '## Network ledger (Sentinel process)', '', `Allow-list: ${r.network.allowList.map((h) => `\`${h}\``).join(', ') || '(none)'}`, '');
  L.push(`Allowed connections: ${fmtMap(r.network.allowedConnections)}`, '', `**Blocked attempts: ${fmtMap(r.network.blockedAttempts)}**`, '', `Bytes out ${r.network.bytesOut} · bytes in ${r.network.bytesIn} · HTTP requests ${r.network.requests}`, '');
  L.push('## What the model saw', '', `- Production log: \`${r.disclosed.log.file}\` (${r.disclosed.log.bytes} bytes)`, `- Repo Oracle scoped: **${r.disclosed.repoOracleScoped ? 'yes' : 'NO (ablation: unrestricted repo access)'}**`, `- Source disclosed: ${r.disclosed.totalBytes} bytes across ${r.disclosed.files.length} file(s)`, '');
  for (const f of r.disclosed.files) L.push(`  - \`${f.file}\` lines ${f.ranges.join(', ')} (${f.bytes} B)`);
  L.push('', '## Sandbox', '', `- Mechanism: ${r.sandbox.mechanism}`, `- Commands: ${r.sandbox.sandboxedCommands}/${r.sandbox.commands} ran inside the namespace`, `- Canary: ${r.sandbox.canary ? (r.sandbox.canary.ok ? '✅ ' : '❌ ') + r.sandbox.canary.detail : 'not run'}`, '');
  L.push('## Claim and limits', '', '**This receipt proves:**', ...r.claims.proves.map((s) => `- ${s}`), '', '**It does not prove:**', ...r.claims.doesNotProve.map((s) => `- ${s}`), '');
  return L.join('\n');
}

function fmtMap(m: Record<string, number>): string {
  const e = Object.entries(m);
  return e.length ? e.map(([k, v]) => `\`${k}\` ×${v}`).join(', ') : 'none';
}
