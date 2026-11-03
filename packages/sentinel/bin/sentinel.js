#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 1));
