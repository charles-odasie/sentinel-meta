/**
 * Execution sandbox for everything that is not a model call: test runs, git, triggers.
 *
 * Mechanism: a fresh Linux network namespace (`unshare -n`). A new netns has only a
 * loopback interface and no routes, so NO packet can leave the host — this is enforced
 * by the kernel, not by a hook. We bring `lo` up so local-only services (the sample
 * app's in-process MQTT broker) still work.
 *
 * If `unshare -n` is unavailable (no CAP_SYS_ADMIN, macOS, …) we fall back to plain
 * execution and the Privacy Receipt says so explicitly (`sandbox: none`).
 */
import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; ms: number; sandboxed: boolean; timedOut: boolean }

let netnsAvailable: boolean | undefined;

/**
 * Bring loopback up inside the fresh netns. `ip` (iproute2) is often absent in minimal
 * containers, so we fall back to a 6-line Python ioctl (SIOCSIFFLAGS |= IFF_UP).
 */
const LO_UP_PY = "import socket,fcntl,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);f=struct.unpack('16sH14s',fcntl.ioctl(s,0x8913,struct.pack('16sH14s',b'lo',0,b'\\0'*14)))[1];fcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',f|1,b'\\0'*14))";
const LO_UP = `(ip link set lo up 2>/dev/null || python3 -I -c "${LO_UP_PY}" 2>/dev/null || true)`;
export const sandboxStats = { commands: 0, sandboxedCommands: 0, canary: undefined as undefined | { ok: boolean; detail: string } };

export async function detectNetns(): Promise<boolean> {
  if (netnsAvailable !== undefined) return netnsAvailable;
  if (process.platform !== 'linux' || process.env.SENTINEL_NO_SANDBOX === '1') return (netnsAvailable = false);
  const r = await rawExec('unshare', ['-n', '--', 'sh', '-c', `${LO_UP}; echo ok`], process.cwd(), 10000);
  return (netnsAvailable = r.code === 0 && r.stdout.includes('ok'));
}

/** Prove the sandbox: from inside a netns, try to reach the public internet and expect failure. */
export async function runCanary(): Promise<{ ok: boolean; detail: string }> {
  if (!(await detectNetns())) return (sandboxStats.canary = { ok: false, detail: 'network namespace unavailable; commands ran unsandboxed' });
  const script = `const net=require('net');const s=net.connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERR '+e.code);process.exit(0)});s.on('timeout',()=>{console.log('TIMEOUT');process.exit(0)})`;
  const r = await rawExec('unshare', ['-n', '--', 'sh', '-c', `${LO_UP}; exec node -e "${script.replace(/"/g, '\\"')}"`], process.cwd(), 15000);
  const out = r.stdout.trim();
  const ok = out.startsWith('ERR') || out === 'TIMEOUT';
  return (sandboxStats.canary = { ok, detail: `connect 1.1.1.1:443 inside netns → ${out || r.stderr.trim() || 'no output'}` });
}

export async function runSandboxed(cmd: string, args: string[], cwd: string, timeoutMs = 180000, env: Record<string, string> = {}): Promise<ExecResult> {
  sandboxStats.commands += 1;
  if (await detectNetns()) {
    sandboxStats.sandboxedCommands += 1;
    const inner = [cmd, ...args].map(shellQuote).join(' ');
    const r = await rawExec('unshare', ['-n', '--', 'sh', '-c', `${LO_UP}; exec ${inner}`], cwd, timeoutMs, env);
    return { ...r, sandboxed: true };
  }
  return { ...(await rawExec(cmd, args, cwd, timeoutMs, env)), sandboxed: false };
}

export function rawExec(cmd: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - t0, sandboxed: false, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e), ms: Date.now() - t0, sandboxed: false, timedOut }); });
  });
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
