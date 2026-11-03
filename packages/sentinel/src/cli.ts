#!/usr/bin/env node
/**
 * sentinel run --log <file> --repo <dir> [--out <dir>] [--no-validator] [--no-oracle] [--no-fix] [--history <dir>]
 */
import path from 'node:path';
import { runSentinel } from './pipeline.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(`--${name}`);

if (cmd !== 'run' || !flag('log') || !flag('repo') || has('help')) {
  console.log(`Sentinel — private agentic bug reproducer (Meta Muse open-weight models)

Usage:
  sentinel run --log <error.log> --repo <app dir> [options]

Options:
  --out <dir>        output directory (default ./sentinel-out/<timestamp>)
  --history <dir>    git repo with 'good'/'bad' tags → bisect the suspect commit
  --history-app <p>  path of the app inside that repo (default apps/mqtt-sample)
  --no-validator     skip the Repro Validator (ablation)
  --no-oracle        unrestricted repo access instead of the Repo Oracle (ablation)
  --no-fix           stop after the reproduction test
  --turns <n>        max agent turns for the repro stage (default 10)

Environment: BASETEN_API_KEY (Muse Spark Open), optional FIREWORKS_API_KEY (Muse Glimmer), MODEL_API_KEY (fallback).
`);
  process.exit(cmd === 'run' ? 1 : 0);
}

const out = flag('out') ?? path.join(process.cwd(), 'sentinel-out', new Date().toISOString().replace(/[:.]/g, '-'));
runSentinel({
  logPath: path.resolve(flag('log')!),
  appDir: path.resolve(flag('repo')!),
  outDir: path.resolve(out),
  historyDir: flag('history') ? path.resolve(flag('history')!) : undefined,
  historyAppSubdir: flag('history-app') ?? 'apps/mqtt-sample',
  scopedOracle: !has('no-oracle'),
  useValidator: !has('no-validator'),
  fix: !has('no-fix'),
  maxReproTurns: flag('turns') ? Number(flag('turns')) : undefined,
}).then((r) => {
  console.log(`\nOutputs in ${out}\n  repro.spec.ts · fix.patch · privacy-receipt.md · result.json`);
  process.exit(r.repro.acceptedByValidator || (!r.repro.validation && r.repro.written) ? 0 : 2);
}).catch((e) => { console.error('sentinel failed:', e.message ?? e); process.exit(1); });
