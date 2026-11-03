/**
 * Repro Validator — rejects tests that fail for the wrong reason or are flaky.
 *
 * A candidate test is ACCEPTED only if, on the buggy tree:
 *  1. it fails (non-zero exit) on every one of N runs (default 3) — deterministic;
 *  2. each failure's first error line matches the production log's error signature
 *     (same class, same normalised message) — same reason;
 *  3. the failure stack includes a frame in application source, not only the spec
 *     file — the test exercised the code rather than throwing the error itself.
 * (A 4th check — it PASSES once the fix is applied — is done by the fix verifier.)
 */
import { runSandboxed } from './sandbox.js';
import { compareSignatures, firstErrorLine, type MatchVerdict } from './signature.js';

export interface TestRunner { run(testRelPath: string): Promise<{ code: number; output: string; ms: number }> }

export interface ValidationResult {
  accepted: boolean;
  runs: { code: number; errorLine: string | null; ms: number }[];
  verdict: MatchVerdict | null;
  reasons: string[];
  exercisedSource: boolean;
}

export function jestRunner(appDir: string, timeoutMs = 180000): TestRunner {
  return {
    async run(testRelPath: string) {
      const r = await runSandboxed('npx', ['jest', '--ci', '--runTestsByPath', testRelPath, '--no-coverage', '--colors=false'], appDir, timeoutMs);
      return { code: r.timedOut ? 124 : r.code, output: r.stdout + '\n' + r.stderr, ms: r.ms };
    },
  };
}

export async function validateRepro(runner: TestRunner, testRelPath: string, expectedErrorLine: string | null, opts: { runs?: number; log?: (s: string) => void } = {}): Promise<ValidationResult> {
  const n = opts.runs ?? 3;
  const runs: ValidationResult['runs'] = [];
  const reasons: string[] = [];
  let verdict: MatchVerdict | null = null;
  let exercisedSource = false;
  for (let i = 0; i < n; i++) {
    const r = await runner.run(testRelPath);
    const errorLine = firstErrorLine(r.output);
    runs.push({ code: r.code, errorLine, ms: r.ms });
    opts.log?.(`  validator run ${i + 1}/${n}: exit ${r.code} — ${errorLine ?? 'no error line'}`);
    if (r.code === 0) { reasons.push(`run ${i + 1}: test PASSED on the buggy tree — it does not reproduce the bug`); break; }
    if (r.code === 124) { reasons.push(`run ${i + 1}: test timed out`); break; }
    if (/Cannot find module|SyntaxError|Test suite failed to run|TS\d{4}:/.test(r.output) && !/●.*›/.test(r.output)) { reasons.push(`run ${i + 1}: the test file itself failed to compile/load`); break; }
    const v = compareSignatures(expectedErrorLine, errorLine);
    if (!verdict) verdict = v;
    if (!v.match) { reasons.push(`run ${i + 1}: wrong reason — ${v.reason}`); break; }
    exercisedSource = /\n\s+at .*\/src\/(?!.*\.(spec|test)\.[tj]s).*:\d+:\d+/.test(r.output) || /at .*\.service\.ts:\d+/.test(r.output);
    if (!exercisedSource) { reasons.push(`run ${i + 1}: failure stack has no application-source frame (the test threw the error itself?)`); break; }
    if (i > 0 && runs[i - 1].errorLine && compareSignatures(runs[i - 1].errorLine, errorLine).match === false) { reasons.push(`run ${i + 1}: non-deterministic — error differs from run ${i}`); break; }
  }
  const accepted = reasons.length === 0 && runs.length === n;
  if (accepted) reasons.push(`failed ${n}/${n} runs with the production error signature; stack reaches application source`);
  return { accepted, runs, verdict, reasons, exercisedSource };
}
