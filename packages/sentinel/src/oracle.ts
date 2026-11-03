/**
 * Repo Oracle — the only way code reaches the model.
 *
 * It parses the production log for stack frames, resolves them to files inside the
 * repo, and exposes a *scoped* read API: frame files, plus imports expanded one hop at
 * a time on explicit request. Every byte disclosed is recorded (path, line range,
 * bytes) and ends up in the Privacy Receipt. With `scoped=false` (ablation) the model
 * gets unrestricted read/list/grep over the repo — same tools, no fence.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Frame { file: string; line: number; col: number; fn?: string; raw: string }
export interface Disclosure { path: string; from: number; to: number; bytes: number; why: string }

export interface LogAnalysis {
  errorLine: string | null;      // e.g. "TypeError: Cannot read properties of undefined (reading 'value')"
  errorName: string | null;
  frames: Frame[];               // in-repo frames only, in stack order
  rawFrameCount: number;
}

const FRAME_RE = /at\s+(?:(.+?)\s+\()?((?:[A-Za-z]:)?[^\s()]+?):(\d+):(\d+)\)?/g;
const ERROR_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:\w+:\s*)?((?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception|RangeError|TypeError|ReferenceError|SyntaxError)(?:\s*\[[A-Z_]+\])?:\s.*)$/m;

export function analyseLog(log: string, repoRoot: string): LogAnalysis {
  const frames: Frame[] = [];
  let raw = 0;
  for (const m of log.matchAll(FRAME_RE)) {
    raw += 1;
    const p = m[2];
    if (p.startsWith('node:') || p.includes('node_modules') || p.includes('internal/')) continue;
    const resolved = resolveInRepo(p, repoRoot);
    if (!resolved) continue;
    frames.push({ fn: m[1]?.trim(), file: resolved, line: Number(m[3]), col: Number(m[4]), raw: m[0] });
  }
  // de-duplicate identical file:line
  const seen = new Set<string>();
  const uniq = frames.filter((f) => { const k = `${f.file}:${f.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const em = log.match(ERROR_RE);
  const errorLine = em ? em[1].trim() : firstErrorish(log);
  const errorName = errorLine ? (errorLine.match(/^([A-Za-z]+(?:Error|Exception))/)?.[1] ?? null) : null;
  return { errorLine, errorName, frames: uniq, rawFrameCount: raw };
}

function firstErrorish(log: string): string | null {
  const m = log.match(/([A-Za-z]*(?:Error|Exception)):\s+([^\n]+)/);
  return m ? `${m[1]}: ${m[2].trim()}` : null;
}

/** Map a path from a log (absolute, repo-relative, or app-relative, .ts or .js) to a repo-relative existing file. */
export function resolveInRepo(p: string, repoRoot: string): string | null {
  const candidates: string[] = [];
  const norm = p.replace(/\\/g, '/');
  if (path.isAbsolute(norm)) {
    if (norm.startsWith(repoRoot)) candidates.push(path.relative(repoRoot, norm));
    else { const i = norm.indexOf('/src/'); if (i >= 0) candidates.push(norm.slice(i + 1)); }
  } else candidates.push(norm.replace(/^\.\//, ''));
  const expanded: string[] = [];
  for (const c of candidates) {
    expanded.push(c);
    if (c.endsWith('.js')) expanded.push(c.replace(/\.js$/, '.ts'));
    if (c.startsWith('dist/')) expanded.push(c.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
    // suffix search: the log may contain a longer prefix than the repo root
    const parts = c.split('/');
    for (let i = 1; i < parts.length; i++) expanded.push(parts.slice(i).join('/'));
  }
  for (const c of expanded) {
    const full = path.join(repoRoot, c);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return c;
  }
  return null;
}

export class RepoOracle {
  readonly allowed = new Set<string>();
  readonly disclosures: Disclosure[] = [];
  constructor(readonly repoRoot: string, readonly analysis: LogAnalysis, readonly scoped = true) {
    for (const f of analysis.frames) this.allowed.add(f.file);
  }

  isAllowed(rel: string): boolean {
    return !this.scoped || this.allowed.has(rel);
  }

  /** Initial context: a window around every in-repo frame (top frame first, largest window). */
  frameWindows(radius = 30): string {
    const parts: string[] = [];
    for (const [i, f] of this.analysis.frames.entries()) {
      const r = i === 0 ? radius : Math.max(12, Math.floor(radius / 2));
      parts.push(this.read(f.file, Math.max(1, f.line - r), f.line + r, `stack frame #${i + 1}${f.fn ? ` (${f.fn})` : ''}`));
    }
    return parts.join('\n\n');
  }

  read(rel: string, from = 1, to = Number.MAX_SAFE_INTEGER, why = 'read_file'): string {
    rel = rel.replace(/^\.\//, '');
    if (!this.isAllowed(rel)) return `DENIED: ${rel} is outside the Repo Oracle scope. Allowed files: ${[...this.allowed].join(', ')}. Use expand_imports(<allowed file>) to add its direct imports.`;
    const full = path.join(this.repoRoot, rel);
    if (!fs.existsSync(full)) return `ERROR: ${rel} does not exist`;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    const a = Math.max(1, from), b = Math.min(lines.length, to);
    const slice = lines.slice(a - 1, b);
    const text = slice.map((l, i) => `${String(a + i).padStart(4)}| ${l}`).join('\n');
    this.disclosures.push({ path: rel, from: a, to: b, bytes: Buffer.byteLength(slice.join('\n')), why });
    return `// ${rel} lines ${a}-${b} of ${lines.length}\n${text}`;
  }

  /** Add the direct relative imports of an allowed file to the scope. Returns the newly allowed paths. */
  expandImports(rel: string): string[] {
    rel = rel.replace(/^\.\//, '');
    if (!this.isAllowed(rel)) return [];
    const full = path.join(this.repoRoot, rel);
    if (!fs.existsSync(full)) return [];
    const src = fs.readFileSync(full, 'utf8');
    const added: string[] = [];
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2];
      const base = path.join(path.dirname(full), spec);
      for (const cand of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          const r = path.relative(this.repoRoot, cand);
          if (!this.allowed.has(r)) { this.allowed.add(r); added.push(r); }
          break;
        }
      }
    }
    return added;
  }

  /** Existing spec files next to the frame files, so the model can copy local test conventions. */
  siblingSpecs(): string[] {
    const out = new Set<string>();
    for (const f of this.analysis.frames) {
      const dir = path.join(this.repoRoot, path.dirname(f.file));
      if (!fs.existsSync(dir)) continue;
      for (const e of fs.readdirSync(dir)) if (/\.(spec|test)\.[tj]s$/.test(e)) out.add(path.relative(this.repoRoot, path.join(dir, e)));
    }
    for (const s of out) this.allowed.add(s);
    return [...out];
  }

  // ---- unscoped helpers (ablation only, or when scoped=false) ----
  list(rel: string): string {
    if (this.scoped) return 'DENIED: directory listing is not available under the Repo Oracle.';
    const full = path.join(this.repoRoot, rel || '.');
    if (!fs.existsSync(full)) return `ERROR: ${rel} does not exist`;
    return fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
  }

  grep(pattern: string, maxHits = 40): string {
    if (this.scoped) return 'DENIED: repository search is not available under the Repo Oracle.';
    const re = new RegExp(pattern);
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.[tj]sx?$/.test(e.name)) {
          const lines = fs.readFileSync(p, 'utf8').split('\n');
          lines.forEach((l, i) => { if (hits.length < maxHits && re.test(l)) hits.push(`${path.relative(this.repoRoot, p)}:${i + 1}: ${l.trim()}`); });
        }
      }
    };
    walk(this.repoRoot);
    return hits.length ? hits.join('\n') : 'no matches';
  }

  disclosureSummary() {
    const byFile = new Map<string, { ranges: string[]; bytes: number }>();
    for (const d of this.disclosures) {
      const e = byFile.get(d.path) ?? { ranges: [], bytes: 0 };
      e.ranges.push(`${d.from}-${d.to}`); e.bytes += d.bytes; byFile.set(d.path, e);
    }
    return [...byFile.entries()].map(([file, v]) => ({ file, ranges: v.ranges, bytes: v.bytes }));
  }
}
