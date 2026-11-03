/**
 * Egress guard + network ledger for THIS process.
 *
 * Mechanism: `net.Socket.prototype.connect` is wrapped. Every outbound TCP connect
 * attempt (fetch/undici, http, https, tls all go through it) is recorded. If the host
 * is not on the allow-list the socket is destroyed before any byte leaves and the
 * attempt is recorded as BLOCKED.
 *
 * Scope (be honest): this covers the Sentinel agent process only. Child processes
 * (test runs, git) are not covered here — they run inside a network namespace with no
 * interfaces (see sandbox.ts), which is a kernel-level guarantee rather than a hook.
 */
import net from 'node:net';

export interface LedgerEntry {
  ts: string;
  host: string;
  port: number;
  allowed: boolean;
  reason?: string;
}

export interface RequestEntry {
  ts: string;
  provider: string;
  model: string;
  host: string;
  status: number;
  ms: number;
  bytesOut: number;
  bytesIn: number;
  promptTokens: number;
  completionTokens: number;
  role: string;
  retries: number;
}

class Ledger {
  readonly connects: LedgerEntry[] = [];
  readonly requests: RequestEntry[] = [];
  private allow = new Set<string>();
  private installed = false;

  setAllowList(hosts: string[]) {
    this.allow = new Set(hosts.map((h) => h.toLowerCase()));
  }

  allowList(): string[] {
    return [...this.allow];
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const self = this;
    const original = net.Socket.prototype.connect;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]): net.Socket {
      const { host, port } = parseConnectArgs(args);
      const allowed = self.allow.has(host.toLowerCase());
      self.connects.push({ ts: new Date().toISOString(), host, port, allowed, reason: allowed ? undefined : 'not on allow-list' });
      if (!allowed) {
        const err = Object.assign(new Error(`egress blocked by Sentinel guard: ${host}:${port}`), { code: 'EEGRESSBLOCKED' });
        // Destroy asynchronously so callers see a normal socket error, not a sync throw.
        process.nextTick(() => this.destroy(err));
        return this;
      }
      return original.apply(this, args as never);
    } as typeof net.Socket.prototype.connect;
  }

  recordRequest(r: RequestEntry) {
    this.requests.push(r);
  }

  summary() {
    const allowedConnects = this.connects.filter((c) => c.allowed);
    const blocked = this.connects.filter((c) => !c.allowed);
    const byHost = (list: LedgerEntry[]) => {
      const m = new Map<string, number>();
      for (const c of list) m.set(`${c.host}:${c.port}`, (m.get(`${c.host}:${c.port}`) ?? 0) + 1);
      return Object.fromEntries(m);
    };
    return {
      allowList: this.allowList(),
      allowedConnects: byHost(allowedConnects),
      blockedConnects: byHost(blocked),
      requests: this.requests.length,
      bytesOut: this.requests.reduce((a, r) => a + r.bytesOut, 0),
      bytesIn: this.requests.reduce((a, r) => a + r.bytesIn, 0),
      promptTokens: this.requests.reduce((a, r) => a + r.promptTokens, 0),
      completionTokens: this.requests.reduce((a, r) => a + r.completionTokens, 0),
    };
  }

  reset() {
    this.connects.length = 0;
    this.requests.length = 0;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseConnectArgs(args: any[]): { host: string; port: number } {
  const a0 = args[0];
  if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) {
    if (a0.path) return { host: `unix:${a0.path}`, port: 0 };
    return { host: String(a0.host ?? 'localhost'), port: Number(a0.port ?? 0) };
  }
  if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port: Number(a0) };
  }
  if (typeof a0 === 'string') return { host: `unix:${a0}`, port: 0 };
  return { host: 'unknown', port: 0 };
}

export const ledger = new Ledger();
