/**
 * Suspect-commit bisect: given a git history whose `good` tag passes and `bad` tag fails
 * the validated repro test, `git bisect run` names the first bad commit.
 * The test file is written as an UNTRACKED file so it survives every checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSandboxed } from './sandbox.js';

export interface BisectResult { ok: boolean; commit: string | null; subject: string | null; steps: number; ms: number; log: string }

export async function bisectSuspect(historyDir: string, testRelPath: string, testContent: string, opts: { good?: string; bad?: string; appSubdir?: string; log?: (s: string) => void } = {}): Promise<BisectResult> {
  const t0 = Date.now();
  const good = opts.good ?? 'good', bad = opts.bad ?? 'bad';
  const appSubdir = opts.appSubdir ?? '.'; // where the app lives inside the history repo
  const abs = path.join(historyDir, appSubdir, testRelPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, testContent);
  const git = (args: string[]) => runSandboxed('git', args, historyDir, 120000);
  await git(['bisect', 'reset']);
  const start = await git(['bisect', 'start', bad, good]);
  if (start.code !== 0) return { ok: false, commit: null, subject: null, steps: 0, ms: Date.now() - t0, log: start.stdout + start.stderr };
  // `git bisect run` executes the script per step; jest itself runs inside the same netns.
  const script = path.join(historyDir, '.sentinel-bisect.sh');
  fs.writeFileSync(script, `#!/bin/sh\ncd ${shq(appSubdir)} && npx jest --ci --runTestsByPath ${shq(testRelPath)} --no-coverage --colors=false >/dev/null 2>&1\n`, { mode: 0o755 });
  const run = await runSandboxed('git', ['bisect', 'run', script], historyDir, 20 * 60 * 1000);
  const log = run.stdout + '\n' + run.stderr;
  const m = log.match(/^([0-9a-f]{7,40}) is the first bad commit/m);
  const steps = (log.match(/Bisecting:/g) ?? []).length;
  let subject: string | null = null;
  if (m) { const s = await git(['log', '-1', '--format=%s', m[1]]); subject = s.stdout.trim() || null; }
  await git(['bisect', 'reset']);
  try { fs.unlinkSync(script); } catch { /* ignore */ }
  opts.log?.(m ? `  bisect → ${m[1].slice(0, 10)} "${subject}" after ${steps} steps` : '  bisect failed to converge');
  return { ok: Boolean(m), commit: m ? m[1] : null, subject, steps, ms: Date.now() - t0, log };
}

function shq(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; }
