/**
 * The Sentinel pipeline: log → Repo Oracle → repro agent → Repro Validator → fix agent
 * → full-suite verification → bisect → Privacy Receipt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { allowedHosts, resolveRouting, type ProviderConfig } from './config.js';
import { ledger } from './egress/ledger.js';
import { buildReceipt, receiptMarkdown, type Receipt } from './egress/receipt.js';
import { ModelClient, type Message, type ToolDef } from './models/client.js';
import { runToolLoop } from './agent/loop.js';
import { analyseLog, RepoOracle } from './oracle.js';
import { jestRunner, validateRepro, type ValidationResult } from './validator.js';
import { runCanary, runSandboxed, sandboxStats } from './sandbox.js';
import { bisectSuspect, type BisectResult } from './bisect.js';
import { firstErrorLine } from './signature.js';

export interface RunOptions {
  logPath: string;
  appDir: string;            // the repository under test (tests run here)
  outDir: string;
  scopedOracle?: boolean;    // false = ablation "no Repo Oracle"
  useValidator?: boolean;    // false = ablation "no Repro Validator"
  fix?: boolean;
  historyDir?: string;       // git repo with `good`/`bad` tags for bisect
  testRelPath?: string;      // where the repro test is written, relative to appDir
  maxReproTurns?: number;
  maxValidatorRounds?: number;
  maxFixTurns?: number;
  log?: (s: string) => void;
}

export interface RunResult {
  runId: string;
  errorLine: string | null;
  frames: number;
  repro: { written: boolean; testRelPath: string; turns: number; validation: ValidationResult | null; acceptedByValidator: boolean; validatorRounds: number; modelSummary: string };
  fix: null | { attempted: boolean; verified: boolean; turns: number; patchFile: string | null; reproPassesAfterFix: boolean; fullSuiteGreen: boolean; summary: string };
  bisect: BisectResult | null;
  receipt: Receipt;
  durationMs: number;
  models: { reasoner: string; fast: string };
}

export async function runSentinel(o: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const log = o.log ?? ((s: string) => console.log(s));
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
  const scoped = o.scopedOracle ?? true, useValidator = o.useValidator ?? true;
  const testRelPath = o.testRelPath ?? 'src/__sentinel__/repro.spec.ts';
  fs.mkdirSync(o.outDir, { recursive: true });

  // 0. egress guard + sandbox proof
  ledger.reset();
  ledger.setAllowList(allowedHosts());
  ledger.install();
  sandboxStats.commands = 0; sandboxStats.sandboxedCommands = 0;
  const { reasoner, fast } = resolveRouting();
  log(`▶ Sentinel ${runId}`);
  log(`  reasoner: ${reasoner.model} @ ${reasoner.host} (${reasoner.openWeights ? 'open weights' : 'HOSTED, not open-weight'})`);
  log(`  fast:     ${fast.model} @ ${fast.host}`);
  log(`  egress allow-list: ${ledger.allowList().join(', ')}`);
  const canary = await runCanary();
  log(`  sandbox canary: ${canary.ok ? 'PASS' : 'FAIL'} — ${canary.detail}`);

  // 1. log analysis + oracle
  const logText = fs.readFileSync(o.logPath, 'utf8');
  const analysis = analyseLog(logText, o.appDir);
  const oracle = new RepoOracle(o.appDir, analysis, scoped);
  log(`  error: ${analysis.errorLine ?? '(none found)'}`);
  log(`  in-repo frames: ${analysis.frames.length}/${analysis.rawFrameCount} → ${analysis.frames.map((f) => `${f.file}:${f.line}`).join(', ') || 'none'}`);
  const specs = oracle.siblingSpecs();
  const client = new ModelClient(reasoner);
  const runner = jestRunner(o.appDir);
  const transcript: Message[][] = [];

  // 2. repro agent
  const writeTest = (content: string) => { const p = path.join(o.appDir, testRelPath); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  let finished = false, modelSummary = '';
  let lastRunOutput = '';
  const reproTools: ToolDef[] = [
    tool('read_file', 'Read a file (or a line range) from the repository. Under the Repo Oracle only files in the stack trace (and imports you expanded) are readable.', { path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, ['path']),
    tool('expand_imports', 'Add the direct relative imports of an allowed file to the readable scope. Returns the newly readable paths.', { path: { type: 'string' } }, ['path']),
    tool('write_test', `Write (overwrite) the reproduction test at ${testRelPath}. Full file content, Jest + TypeScript.`, { content: { type: 'string' } }, ['content']),
    tool('run_test', 'Run the reproduction test in the sandbox and return the Jest output (trimmed).', {}, []),
    tool('finish', 'Call when the test fails for the same reason as the production log. Give a 1–3 sentence root-cause hypothesis.', { summary: { type: 'string' } }, ['summary']),
  ];
  if (!scoped) reproTools.splice(2, 0, tool('list_dir', 'List a directory of the repository.', { path: { type: 'string' } }, ['path']), tool('grep', 'Regex search over source files; returns file:line matches.', { pattern: { type: 'string' } }, ['pattern']));
  const handlers = {
    read_file: (a: any) => oracle.read(String(a.path), a.from ? Number(a.from) : 1, a.to ? Number(a.to) : Number.MAX_SAFE_INTEGER),
    expand_imports: (a: any) => { const added = oracle.expandImports(String(a.path)); return added.length ? `now readable: ${added.join(', ')}` : 'no new relative imports (or file not in scope)'; },
    list_dir: (a: any) => oracle.list(String(a.path ?? '.')),
    grep: (a: any) => oracle.grep(String(a.pattern)),
    write_test: (a: any) => { writeTest(String(a.content)); return `written ${testRelPath} (${String(a.content).length} chars)`; },
    run_test: async () => { const r = await runner.run(testRelPath); lastRunOutput = r.output; return `exit code ${r.code} (${r.code === 0 ? 'PASSED — this does NOT reproduce the bug' : 'failed'})\nfirst error: ${firstErrorLine(r.output) ?? 'none'}\n\n${trimJest(r.output)}`; },
    finish: (a: any) => { finished = true; modelSummary = String(a.summary ?? ''); return 'ok'; },
  };
  const exampleSpec = specs[0] ? oracle.read(specs[0], 1, 60, 'test-convention example') : '(no sibling spec found)';
  const system = `You are Sentinel, a senior engineer who turns production error logs into deterministic failing tests.
Rules:
- Work ONLY from the log and the code the tools return. Never guess file contents.
- The test must call the real application code with inputs that provoke EXACTLY the error in the log (same error class and message). It must NOT catch the error and must NOT throw it itself. No expect(...).toThrow — let the error escape so Jest reports it.
- Jest + ts-jest, TypeScript. The test lives at ${testRelPath}; import application files relative to that location (e.g. '../telemetry/telemetry-parser.service').
- Keep it minimal: one \`it\` block, construct the service(s) directly (new X()), no NestJS TestingModule unless required, no network, no timers longer than 100 ms.
- After write_test always call run_test. Iterate until the run fails with the log's error. Then call finish.`;
  const user = `## Production log\n\`\`\`\n${logText.slice(0, 12000)}\n\`\`\`\n\n## Code at the stack frames (Repo Oracle${scoped ? ', scoped' : ', UNRESTRICTED'})\n${scoped || analysis.frames.length ? oracle.frameWindows() : '(no in-repo frames parsed; use list_dir/grep)'}\n\n## Local test conventions (an existing spec)\n${exampleSpec}\n\nWrite the reproduction test now.`;

  let loop = await runToolLoop(client, { system, user, tools: reproTools, handlers, maxTurns: o.maxReproTurns ?? 10, isDone: () => finished, log, onTurn: (t, m) => log(`  [repro turn ${t}] ${(m.content ?? '').toString().replace(/\s+/g, ' ').slice(0, 140)}`) });
  let validation: ValidationResult | null = null;
  let rounds = 0;
  let accepted = false;
  const testExists = () => fs.existsSync(path.join(o.appDir, testRelPath));
  while (testExists()) {
    rounds += 1;
    validation = await validateRepro(runner, testRelPath, analysis.errorLine, { log });
    log(`  validator: ${validation.accepted ? 'ACCEPTED' : 'REJECTED'} — ${validation.reasons.join('; ')}`);
    if (validation.accepted) { accepted = true; break; }
    if (!useValidator || rounds > (o.maxValidatorRounds ?? 3)) break;
    finished = false;
    loop = await runToolLoop(client, { system, user: `The Repro Validator REJECTED the test:\n- ${validation.reasons.join('\n- ')}\nExpected error: ${analysis.errorLine}\nObserved: ${validation.runs.at(-1)?.errorLine ?? 'none'}\nFix the test so it fails for exactly the logged reason, run it, then call finish.`, tools: reproTools, handlers, maxTurns: 6, isDone: () => finished, log, resume: loop.messages });
  }
  transcript.push(loop.messages);
  const reproAccepted = useValidator ? accepted : testExists() && (validation?.runs[0]?.code ?? 0) !== 0; // without the validator we accept any failing test
  const testContent = testExists() ? fs.readFileSync(path.join(o.appDir, testRelPath), 'utf8') : '';
  if (testContent) fs.writeFileSync(path.join(o.outDir, 'repro.spec.ts'), testContent);

  // 3. fix agent + verification
  let fix: RunResult['fix'] = null;
  if (o.fix && reproAccepted) {
    const snapshot = new Map<string, string>();
    const touched = new Set<string>();
    let fixDone = false, fixSummary = '';
    const fixTools: ToolDef[] = [
      reproTools[0], reproTools[1],
      tool('apply_edit', 'Replace an exact, unique snippet in an application source file (not tests). old_string must match exactly once.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
      tool('run_repro_test', 'Run the validated reproduction test (should pass after the fix).', {}, []),
      tool('run_full_suite', 'Run the whole test suite in the sandbox.', {}, []),
      tool('finish', 'Call when the repro test and the full suite both pass.', { summary: { type: 'string' } }, ['summary']),
    ];
    const fixHandlers = {
      read_file: handlers.read_file, expand_imports: handlers.expand_imports,
      apply_edit: (a: any) => {
        const rel = String(a.path).replace(/^\.\//, '');
        if (/\.(spec|test)\.[tj]s$/.test(rel) || rel.startsWith('src/__sentinel__')) return 'DENIED: do not edit tests';
        if (!oracle.isAllowed(rel)) return `DENIED: ${rel} is outside the Repo Oracle scope`;
        const full = path.join(o.appDir, rel);
        if (!fs.existsSync(full)) return `ERROR: ${rel} not found`;
        const src = fs.readFileSync(full, 'utf8');
        const n = src.split(String(a.old_string)).length - 1;
        if (n !== 1) return `ERROR: old_string occurs ${n} times (must be exactly 1)`;
        if (!snapshot.has(rel)) snapshot.set(rel, src);
        fs.writeFileSync(full, src.replace(String(a.old_string), String(a.new_string)));
        touched.add(rel);
        return `edited ${rel}`;
      },
      run_repro_test: async () => { const r = await runner.run(testRelPath); return `exit code ${r.code}\n${trimJest(r.output)}`; },
      run_full_suite: async () => { const r = await runSandboxed('npx', ['jest', '--ci', '--no-coverage', '--colors=false'], o.appDir, 10 * 60 * 1000); return `exit code ${r.code}\n${trimJest(r.stdout + r.stderr, 6000)}`; },
      finish: (a: any) => { fixDone = true; fixSummary = String(a.summary ?? ''); return 'ok'; },
    };
    const fixUser = `The reproduction test below is validated: it fails on the current tree with "${analysis.errorLine}".\n\n\`\`\`ts\n${testContent}\n\`\`\`\n\nRoot-cause hypothesis from the repro stage: ${modelSummary || '(none)'}\n\nFix the application code (smallest correct change, no behaviour regressions, do not special-case the test), run run_repro_test, then run_full_suite, then finish.`;
    const fixLoop = await runToolLoop(client, { system: system.replace('turns production error logs into deterministic failing tests', 'fixes bugs with the smallest correct change'), user: fixUser, tools: fixTools, handlers: fixHandlers, maxTurns: o.maxFixTurns ?? 12, isDone: () => fixDone, log, onTurn: (t, m) => log(`  [fix turn ${t}] ${(m.content ?? '').toString().replace(/\s+/g, ' ').slice(0, 140)}`) });
    transcript.push(fixLoop.messages);
    const repro = await runner.run(testRelPath);
    const full = await runSandboxed('npx', ['jest', '--ci', '--no-coverage', '--colors=false'], o.appDir, 10 * 60 * 1000);
    const verified = repro.code === 0 && full.code === 0 && touched.size > 0;
    let patchFile: string | null = null;
    if (touched.size) {
      const parts: string[] = [];
      for (const rel of touched) {
        const tmp = path.join(o.outDir, '.before'); fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), snapshot.get(rel) ?? '');
        const d = await runSandboxed('git', ['diff', '--no-index', '--', path.join(tmp, rel), path.join(o.appDir, rel)], o.appDir, 30000);
        parts.push(d.stdout.replace(new RegExp(escapeRe(path.join(tmp, rel)), 'g'), `a/${rel}`).replace(new RegExp(escapeRe(path.join(o.appDir, rel)), 'g'), `b/${rel}`));
      }
      patchFile = path.join(o.outDir, 'fix.patch'); fs.writeFileSync(patchFile, parts.join('\n'));
      fs.rmSync(path.join(o.outDir, '.before'), { recursive: true, force: true });
    }
    log(`  fix: ${verified ? 'VERIFIED' : 'not verified'} (repro ${repro.code === 0 ? 'passes' : 'still fails'}, full suite ${full.code === 0 ? 'green' : 'red'}, ${touched.size} file(s) edited)`);
    fix = { attempted: true, verified, turns: fixLoop.turns, patchFile, reproPassesAfterFix: repro.code === 0, fullSuiteGreen: full.code === 0, summary: fixSummary };
    if (!verified) for (const [rel, src] of snapshot) fs.writeFileSync(path.join(o.appDir, rel), src); // leave the tree as we found it
  }

  // 4. bisect
  let bisect: BisectResult | null = null;
  if (o.historyDir && reproAccepted && testContent) bisect = await bisectSuspect(o.historyDir, testRelPath, testContent, { log });

  // 5. receipt
  const finishedAt = new Date().toISOString();
  const receipt = buildReceipt({ runId, startedAt: new Date(t0).toISOString(), finishedAt, models: dedupe([{ role: 'reasoner', provider: reasoner }, { role: 'fast', provider: fast }]), disclosures: oracle.disclosureSummary(), oracleScoped: scoped, logFile: path.basename(o.logPath), logBytes: Buffer.byteLength(logText) });
  fs.writeFileSync(path.join(o.outDir, 'privacy-receipt.json'), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(o.outDir, 'privacy-receipt.md'), receiptMarkdown(receipt));
  fs.writeFileSync(path.join(o.outDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
  const result: RunResult = {
    runId, errorLine: analysis.errorLine, frames: analysis.frames.length,
    repro: { written: Boolean(testContent), testRelPath, turns: loop.turns, validation, acceptedByValidator: accepted, validatorRounds: rounds, modelSummary },
    fix, bisect, receipt, durationMs: Date.now() - t0, models: { reasoner: reasoner.model, fast: fast.model },
  };
  fs.writeFileSync(path.join(o.outDir, 'result.json'), JSON.stringify(result, null, 2));
  log(`■ done in ${(result.durationMs / 1000).toFixed(0)}s — repro ${accepted ? 'validated' : reproAccepted ? 'unvalidated' : 'FAILED'}${fix ? `, fix ${fix.verified ? 'verified' : 'unverified'}` : ''}${bisect ? `, suspect ${bisect.commit?.slice(0, 10) ?? 'not found'}` : ''}; est. cost ${receipt.estCostUsd == null ? 'n/a' : '$' + receipt.estCostUsd.toFixed(3)}`);
  void lastRunOutput;
  return result;
}

function tool(name: string, description: string, props: Record<string, unknown>, required: string[]): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required, additionalProperties: false } } };
}
function dedupe(ms: { role: string; provider: ProviderConfig }[]) { const seen = new Set<string>(); return ms.filter((m) => (seen.has(m.provider.id) ? false : (seen.add(m.provider.id), true))); }
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Keep the useful part of Jest output: failure blocks + summary. */
export function trimJest(out: string, max = 5000): string {
  const i = out.indexOf('●');
  let s = i >= 0 ? out.slice(i) : out;
  s = s.replace(/\n\s+at (?:node:|.*node_modules).*$/gm, '');
  return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s;
}
