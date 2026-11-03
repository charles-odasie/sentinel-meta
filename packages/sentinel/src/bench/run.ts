/**
 * Benchmark harness: bugs × configs → bench/results/<run>/results.{json,md}
 *   npm run bench -- [--run <id>] [--bugs B01,B02] [--configs full,no-validator,no-oracle] [--no-bisect] [--no-fix]
 * Resumable: (bug, config) pairs already in results.json are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSentinel } from '../pipeline.js';
import { rawExec } from '../sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');
const APP = path.join(REPO, 'apps/mqtt-sample');
const BUGS = path.join(REPO, 'bench/bugs');

type Config = 'full' | 'no-validator' | 'no-oracle';
interface Truth { id: string; class: string; title: string; file: string; error_signature: string; caught_by_existing_test: boolean }
export interface BenchRow {
  bug: string; class: string; config: Config; reproduced: boolean; fixed: boolean; suspectCorrect: boolean | null; suspect: string | null; truthCommit: string | null;
  minutes: number; promptTokens: number; completionTokens: number; usd: number | null; requests: number; validatorRounds: number; reproTurns: number; fixTurns: number | null;
  blockedAttempts: number; allowedHosts: string[]; canary: boolean; errorLine: string | null; validatorReason: string; models: { reasoner: string; fast: string }; error?: string;
}

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string) => args.includes(`--${n}`);
const runId = flag('run') ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const outRoot = path.join(REPO, 'bench/results', runId);
fs.mkdirSync(outRoot, { recursive: true });
const resultsFile = path.join(outRoot, 'results.json');
const rows: BenchRow[] = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
const truths: Truth[] = JSON.parse(fs.readFileSync(path.join(BUGS, 'index.json'), 'utf8'));
const bugs = (flag('bugs')?.split(',') ?? truths.map((t) => t.id)).map((s) => s.trim()).filter(Boolean);
const configs = (flag('configs')?.split(',') ?? ['full', 'no-validator', 'no-oracle']) as Config[];
const doBisect = !has('no-bisect'), doFix = !has('no-fix');

const log = (s: string) => { process.stdout.write(s + '\n'); fs.appendFileSync(path.join(outRoot, 'bench.log'), s + '\n'); };

for (const cfg of configs) for (const bugId of bugs) {
  if (rows.some((r) => r.bug === bugId && r.config === cfg && !r.error)) { log(`skip ${bugId}/${cfg} (done)`); continue; }
  const truth = truths.find((t) => t.id === bugId);
  if (!truth) { log(`unknown bug ${bugId}`); continue; }
  log(`\n================ ${bugId} [${truth.class}] · ${cfg} ================`);
  const work = path.join(outRoot, 'work', `${bugId}-${cfg}`);
  fs.rmSync(work, { recursive: true, force: true });
  const appDir = path.join(work, 'app');
  copyApp(APP, appDir);
  const ap = await rawExec('git', ['apply', '-p3', path.join(BUGS, bugId, 'bug.patch')], appDir, 30000);
  if (ap.code !== 0) { log(`patch failed: ${ap.stderr}`); rows.push(blankRow(bugId, truth, cfg, `patch failed: ${ap.stderr.slice(0, 200)}`)); save(); continue; }
  let historyDir: string | undefined, truthCommit: string | null = null;
  if (doBisect) {
    historyDir = path.join(work, 'history');
    const mh = await rawExec('bash', [path.join(REPO, 'bench/scripts/make-history.sh'), bugId, historyDir, '--link'], REPO, 180000);
    if (mh.code !== 0) { log(`make-history failed: ${mh.stderr.slice(0, 300)}`); historyDir = undefined; }
    else { truthCommit = mh.stdout.trim().split('\n').at(-1)?.trim() ?? null; linkModules(APP, path.join(historyDir, 'apps/mqtt-sample')); }
  }
  const t0 = Date.now();
  try {
    const r = await runSentinel({ logPath: path.join(BUGS, bugId, 'log.txt'), appDir, outDir: path.join(outRoot, `${bugId}-${cfg}`), scopedOracle: cfg !== 'no-oracle', useValidator: cfg !== 'no-validator', fix: doFix, historyDir, historyAppSubdir: 'apps/mqtt-sample', log });
    const rec = r.receipt;
    const row: BenchRow = {
      bug: bugId, class: truth.class, config: cfg,
      reproduced: r.repro.acceptedByValidator, fixed: Boolean(r.fix?.verified),
      suspectCorrect: r.bisect && truthCommit ? Boolean(r.bisect.commit && (r.bisect.commit.startsWith(truthCommit) || truthCommit.startsWith(r.bisect.commit))) : null,
      suspect: r.bisect?.commit ?? null, truthCommit,
      minutes: Number(((Date.now() - t0) / 60000).toFixed(2)),
      promptTokens: rec.inference.reduce((a, m) => a + m.promptTokens, 0), completionTokens: rec.inference.reduce((a, m) => a + m.completionTokens, 0), usd: rec.estCostUsd,
      requests: rec.network.requests, validatorRounds: r.repro.validatorRounds, reproTurns: r.repro.turns, fixTurns: r.fix?.turns ?? null,
      blockedAttempts: Object.values(rec.network.blockedAttempts).reduce((a, b) => a + b, 0), allowedHosts: Object.keys(rec.network.allowedConnections).map((h) => h.split(':')[0]),
      canary: Boolean(rec.sandbox.canary?.ok), errorLine: r.errorLine, validatorReason: r.repro.validation?.reasons.join('; ') ?? 'no test written', models: r.models,
    };
    rows.splice(rows.findIndex((x) => x.bug === bugId && x.config === cfg) >>> 0, 1); // drop a previous errored row if any
    rows.push(row);
  } catch (e) {
    log(`RUN ERROR: ${(e as Error).message}`);
    rows.push(blankRow(bugId, truth, cfg, (e as Error).message.slice(0, 300)));
  }
  save();
  // keep disk small: drop the work tree (receipt/test/patch live in outRoot/<bug>-<cfg>)
  if (!has('keep-work')) fs.rmSync(work, { recursive: true, force: true });
}
log(`\nresults → ${resultsFile}`);
log(fs.readFileSync(path.join(outRoot, 'results.md'), 'utf8'));

function save() {
  fs.writeFileSync(resultsFile, JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(outRoot, 'results.md'), report(rows, runId));
}

function blankRow(bug: string, t: Truth, config: Config, error: string): BenchRow {
  return { bug, class: t.class, config, reproduced: false, fixed: false, suspectCorrect: null, suspect: null, truthCommit: null, minutes: 0, promptTokens: 0, completionTokens: 0, usd: null, requests: 0, validatorRounds: 0, reproTurns: 0, fixTurns: null, blockedAttempts: 0, allowedHosts: [], canary: false, errorLine: null, validatorReason: '', models: { reasoner: '', fast: '' }, error };
}

function copyApp(src: string, dst: string) {
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !/(^|\/)(node_modules|coverage|dist|\.git)(\/|$)/.test(p) });
  linkModules(src, dst);
}
function linkModules(src: string, dst: string) {
  const nm = path.join(dst, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(src, 'node_modules'), nm, 'dir');
}

export function report(rows: BenchRow[], id: string): string {
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : 'n/a');
  const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const L: string[] = [`# Benchmark results — run ${id}`, '', `Generated ${new Date().toISOString()} from results.json. Every number below is measured; nothing is typed by hand.`, ''];
  const cfgs = [...new Set(rows.map((r) => r.config))];
  L.push('## Summary by configuration', '', '| config | bugs | reproduced | fixed | correct suspect commit | median min/bug | median tokens/bug (in+out) | mean $/bug | blocked egress attempts | canary pass |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cfgs) {
    const rs = rows.filter((r) => r.config === c && !r.error);
    const withBisect = rs.filter((r) => r.suspectCorrect !== null);
    const usd = rs.map((r) => r.usd).filter((u): u is number => u != null);
    L.push(`| ${c} | ${rs.length} | ${pct(rs.filter((r) => r.reproduced).length, rs.length)} | ${pct(rs.filter((r) => r.fixed).length, rs.length)} | ${pct(withBisect.filter((r) => r.suspectCorrect).length, withBisect.length)} | ${median(rs.map((r) => r.minutes)).toFixed(1)} | ${Math.round(median(rs.map((r) => r.promptTokens + r.completionTokens)))} | ${usd.length ? '$' + (usd.reduce((a, b) => a + b, 0) / usd.length).toFixed(3) : 'n/a'} | ${rs.reduce((a, r) => a + r.blockedAttempts, 0)} | ${pct(rs.filter((r) => r.canary).length, rs.length)} |`);
  }
  L.push('', '## Per bug', '', '| bug | class | config | reproduced | fixed | suspect | min | tokens in/out | $ | validator rounds | note |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.bug} | ${r.class} | ${r.config} | ${r.error ? '⚠' : r.reproduced ? '✅' : '❌'} | ${r.fixed ? '✅' : '❌'} | ${r.suspectCorrect === null ? '—' : r.suspectCorrect ? '✅' : '❌'} | ${r.minutes} | ${r.promptTokens}/${r.completionTokens} | ${r.usd == null ? 'n/a' : '$' + r.usd.toFixed(3)} | ${r.validatorRounds} | ${r.error ? 'ERROR: ' + r.error : r.validatorReason.slice(0, 90)} |`);
  const models = [...new Set(rows.filter((r) => r.models.reasoner).map((r) => `${r.models.reasoner} (reasoner), ${r.models.fast} (fast)`))];
  L.push('', `Models: ${models.join(' · ') || 'n/a'}`, '', 'Definitions: *reproduced* = the Repro Validator accepted the test (3/3 failing runs with the production error signature, stack reaching application source) — for the `no-validator` configuration the check is run once post-hoc and never fed back; *fixed* = repro test passes and the full suite is green after the agent\'s edit; *suspect* = `git bisect run` with the repro test names the commit that introduced the bug; $ uses Baseten list price $1.25/$4.25 per 1M tokens (Fireworks price UNVERIFIED → excluded).', '');
  return L.join('\n');
}
