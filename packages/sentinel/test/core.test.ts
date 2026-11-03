import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSignatures, firstErrorLine, normalise, signatureOf } from '../src/signature.js';
import { analyseLog, RepoOracle } from '../src/oracle.js';
import { parseConnectArgs, ledger } from '../src/egress/ledger.js';

describe('signature', () => {
  it('extracts class and message', () => {
    expect(signatureOf("TypeError: Cannot read properties of undefined (reading 'value')")).toMatchObject({ name: 'TypeError' });
  });
  it('normalises volatile parts', () => {
    expect(normalise('boom at /a/b/c.ts:12:3 id 0xdeadbeef')).toBe('boom at id');
  });
  it('matches same reason, rejects different class', () => {
    expect(compareSignatures("TypeError: Cannot read properties of undefined (reading 'value')", "TypeError: Cannot read properties of undefined (reading 'value')").match).toBe(true);
    expect(compareSignatures('TypeError: x', 'RangeError: x').match).toBe(false);
    expect(compareSignatures('TypeError: Cannot read properties of undefined (reading "value")', 'TypeError: Cannot read properties of null (reading "other")').match).toBe(false);
  });
  it('finds first error line in jest output', () => {
    const out = `FAIL src/x.spec.ts\n  ● parser › throws\n\n    TypeError: Cannot read properties of undefined (reading 'value')\n\n      at TelemetryParserService.parse (src/telemetry/parser.ts:10:5)`;
    expect(firstErrorLine(out)).toBe("TypeError: Cannot read properties of undefined (reading 'value')");
  });
});

describe('oracle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
  fs.mkdirSync(path.join(root, 'src/telemetry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/telemetry/parser.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}; import x from './util';`).join('\n'));
  fs.writeFileSync(path.join(root, 'src/telemetry/util.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(root, 'src/secret.ts'), 'export const SECRET = 1;');
  const log = `2026-11-03T01:02:03Z error service=telemetry-hub topic=devices/d1/telemetry\nTypeError: Cannot read properties of undefined (reading 'value')\n    at TelemetryParserService.parse (/some/prefix/apps/x/src/telemetry/parser.ts:10:5)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n    at Object.<anonymous> (/x/node_modules/jest/index.js:1:1)`;
  const a = analyseLog(log, root);
  it('parses in-repo frames only', () => {
    expect(a.errorLine).toContain('TypeError');
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toMatchObject({ file: 'src/telemetry/parser.ts', line: 10 });
  });
  it('scopes reads and records disclosures', () => {
    const o = new RepoOracle(root, a, true);
    expect(o.read('src/secret.ts')).toMatch(/^DENIED/);
    expect(o.frameWindows(5)).toContain('line 10;');
    expect(o.expandImports('src/telemetry/parser.ts')).toEqual(['src/telemetry/util.ts']);
    expect(o.read('src/telemetry/util.ts')).toContain('SECRET'.length ? 'export const x' : '');
    expect(o.disclosureSummary().map((d) => d.file).sort()).toEqual(['src/telemetry/parser.ts', 'src/telemetry/util.ts']);
    expect(o.grep('SECRET')).toMatch(/^DENIED/);
  });
  it('unscoped mode can grep', () => {
    const o = new RepoOracle(root, a, false);
    expect(o.grep('SECRET')).toContain('src/secret.ts:1');
  });
});

describe('egress guard', () => {
  it('parses connect args', () => {
    expect(parseConnectArgs([{ host: 'inference.baseten.co', port: 443 }])).toEqual({ host: 'inference.baseten.co', port: 443 });
    expect(parseConnectArgs([80, 'example.com'])).toEqual({ host: 'example.com', port: 80 });
  });
  it('blocks a non-allow-listed host before any byte is sent', async () => {
    ledger.reset(); ledger.setAllowList(['inference.baseten.co']); ledger.install();
    await expect(fetch('https://example.com/', { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    const s = ledger.summary();
    expect(Object.keys(s.blockedConnects)).toContain('example.com:443');
    expect(Object.keys(s.allowedConnects)).toHaveLength(0);
  });
});
