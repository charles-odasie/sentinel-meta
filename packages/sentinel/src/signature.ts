/**
 * Error-signature normalisation and matching: "does this test fail for the SAME reason
 * as the production log?" Compares error class + message after stripping volatile
 * bits (paths, line:col, hex ids, numbers in brackets).
 */
export interface Signature { name: string; message: string; normalized: string }

export function signatureOf(line: string | null | undefined): Signature | null {
  if (!line) return null;
  const m = line.match(/([A-Za-z]*(?:Error|Exception))(?:\s*\[[A-Z_]+\])?:\s*(.*)$/);
  if (!m) return null;
  const name = m[1];
  const message = m[2].trim();
  return { name, message, normalized: normalise(message) };
}

export function normalise(msg: string): string {
  return msg
    .replace(/\(?(?:[A-Za-z]:)?[\w./\\-]+\.[tj]sx?:\d+(?::\d+)?\)?/g, ' ')   // file:line:col
    .replace(/0x[0-9a-f]+/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ' ')                    // uuids
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, ' ')                       // timestamps
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Extract the first error line from a Jest / Node failure output. */
export function firstErrorLine(output: string): string | null {
  // Jest prints the thrown error after a "●" header; Node prints it at the top of a stack.
  const lines = output.split('\n');
  for (const l of lines) {
    const t = l.replace(/^\s*[│>]?\s*/, '').trim();
    if (/^(?:[A-Za-z]*(?:Error|Exception))(?:\s*\[[A-Z_]+\])?:\s/.test(t) && !/^Error: expect\(/.test(t)) return t;
    // Jest's "thrown:" wrapper for non-Error throws
  }
  const m = output.match(/([A-Za-z]*(?:Error|Exception)):\s+([^\n]+)/);
  return m ? `${m[1]}: ${m[2]}` : null;
}

export interface MatchVerdict { match: boolean; score: number; reason: string; expected: Signature | null; actual: Signature | null }

export function compareSignatures(expectedLine: string | null, actualLine: string | null): MatchVerdict {
  const expected = signatureOf(expectedLine);
  const actual = signatureOf(actualLine);
  if (!expected) return { match: false, score: 0, reason: 'no error signature could be extracted from the production log', expected, actual };
  if (!actual) return { match: false, score: 0, reason: 'test output contains no thrown error (did the test fail by assertion only, or not at all?)', expected, actual };
  if (expected.name !== actual.name) return { match: false, score: 0, reason: `error class differs: log says ${expected.name}, test threw ${actual.name}`, expected, actual };
  const a = new Set(expected.normalized.split(' ').filter(Boolean));
  const b = new Set(actual.normalized.split(' ').filter(Boolean));
  const inter = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size || 1;
  const score = inter / union;
  const match = expected.normalized === actual.normalized || score >= 0.6;
  return { match, score: Number(score.toFixed(2)), reason: match ? 'same error class and message' : `same error class but message differs (jaccard ${score.toFixed(2)} < 0.6)`, expected, actual };
}
