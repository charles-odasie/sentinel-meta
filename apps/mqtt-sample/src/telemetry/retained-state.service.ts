import { Inject, Injectable, Optional } from '@nestjs/common';
import { Reading, SNAPSHOT_STORE, SnapshotStore, WINDOW_SIZE } from './reading';

export const DEFAULT_WINDOW_SIZE = 60;

export interface Aggregate {
  count: number;
  avg: number;
  min: number;
  max: number;
  /** 95th percentile (nearest-rank) over the window. */
  p95: number;
  first: Date;
  last: Date;
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * Last-known value per device/metric plus sliding-window aggregates over the
 * most recent `windowSize` readings.
 */
@Injectable()
export class RetainedStateService {
  private readonly last = new Map<string, Reading>();
  private readonly windows = new Map<string, Reading[]>();
  readonly windowSize: number;

  constructor(
    @Optional() @Inject(SNAPSHOT_STORE) private readonly store?: SnapshotStore,
    @Optional() @Inject(WINDOW_SIZE) windowSize: number = DEFAULT_WINDOW_SIZE,
  ) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new RangeError(`windowSize must be a positive integer, got ${windowSize}`);
    }
    this.windowSize = windowSize;
  }

  async record(reading: Reading): Promise<void> {
    const key = this.key(reading.deviceId, reading.metric);
    this.last.set(key, reading);

    let w = this.windows.get(key);
    if (!w) {
      w = [];
      this.windows.set(key, w);
    }
    w.push(reading);
    if (w.length > this.windowSize) w.splice(0, w.length - this.windowSize);

    if (this.store) await this.store.put(key, reading);
  }

  lastValue(deviceId: string, metric: string): Reading | undefined {
    return this.last.get(this.key(deviceId, metric));
  }

  metricsFor(deviceId: string): string[] {
    const prefix = `${deviceId}/`;
    return [...this.last.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  aggregate(deviceId: string, metric: string): Aggregate | undefined {
    const w = this.windows.get(this.key(deviceId, metric));
    if (!w || w.length === 0) return undefined;

    const values = w.map((r) => r.value);
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    // Nearest-rank percentile: rank = ceil(p * n), 1-based.
    const p95Index = Math.ceil(0.95 * sorted.length) - 1;

    return {
      count: w.length,
      avg: round2(sum / values.length),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p95: round2(sorted[p95Index]),
      first: w[0].ts,
      last: w[w.length - 1].ts,
    };
  }

  clear(deviceId?: string): void {
    if (deviceId === undefined) {
      this.last.clear();
      this.windows.clear();
      return;
    }
    const prefix = `${deviceId}/`;
    for (const k of [...this.last.keys()]) if (k.startsWith(prefix)) this.last.delete(k);
    for (const k of [...this.windows.keys()]) if (k.startsWith(prefix)) this.windows.delete(k);
  }

  private key(deviceId: string, metric: string): string {
    return `${deviceId}/${metric}`;
  }
}
