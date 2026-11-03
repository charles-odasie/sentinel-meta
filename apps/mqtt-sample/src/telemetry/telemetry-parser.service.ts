import { Injectable } from '@nestjs/common';
import { TelemetryValidationError } from '../errors';
import { Reading } from './reading';

/** Inclusive physical ranges per metric; anything outside is a sensor fault. */
const METRIC_RANGES: Record<string, [number, number]> = {
  temperature: [-40, 125],
  humidity: [0, 100],
  battery: [0, 100],
  pressure: [300, 1100],
};

/** Unit applied when the device omits one. */
const DEFAULT_UNITS: Record<string, string> = {
  temperature: 'C',
  humidity: '%',
  battery: '%',
  pressure: 'hPa',
};

/** Spelling variants devices send for the same unit. */
const UNIT_ALIASES: Record<string, string> = {
  c: 'C',
  celsius: 'C',
  degc: 'C',
  f: 'F',
  fahrenheit: 'F',
  '%': '%',
  percent: '%',
  pct: '%',
  hpa: 'hPa',
  mbar: 'hPa',
  pa: 'Pa',
  v: 'V',
  mv: 'mV',
  ppm: 'ppm',
};

export const MAX_BATCH_SIZE = 100;

const TOPIC_RE = /^devices\/([^/]+)\/telemetry$/;

interface RawReading {
  metric?: unknown;
  value?: unknown;
  unit?: unknown;
  ts?: unknown;
}

/**
 * Turns the JSON payload of `devices/{deviceId}/telemetry` into readings.
 * Accepts a single object, an array of objects, or `{ "readings": [...] }`.
 */
@Injectable()
export class TelemetryParserService {
  parse(topic: string, payload: Buffer | string): Reading[] {
    const m = TOPIC_RE.exec(topic);
    if (!m) throw new TelemetryValidationError(`topic "${topic}" is not a device telemetry topic`, topic);
    return this.parseFor(m[1], payload, topic);
  }

  /** Parse a payload whose device id is already known (e.g. relayed via a gateway). */
  parseFor(deviceId: string, payload: Buffer | string, topic = `devices/${deviceId}/telemetry`): Reading[] {
    let json: unknown;
    try {
      json = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      throw new TelemetryValidationError('payload is not valid JSON', topic);
    }

    const items = this.unwrapBatch(json, topic);
    return items.map((raw, i) => this.toReading(deviceId, raw, i, topic));
  }

  private unwrapBatch(json: unknown, topic: string): RawReading[] {
    let items: unknown[];
    if (Array.isArray(json)) {
      items = json;
    } else if (json && typeof json === 'object' && Array.isArray((json as { readings?: unknown }).readings)) {
      items = (json as { readings: unknown[] }).readings;
    } else {
      items = [json];
    }
    if (items.length === 0) throw new TelemetryValidationError('batch contains no readings', topic);
    if (items.length > MAX_BATCH_SIZE) {
      throw new TelemetryValidationError(`batch of ${items.length} readings exceeds max ${MAX_BATCH_SIZE}`, topic);
    }
    return items as RawReading[];
  }

  private toReading(deviceId: string, raw: RawReading, index: number, topic: string): Reading {
    if (!raw || typeof raw !== 'object') {
      throw new TelemetryValidationError(`reading[${index}] is not an object`, topic);
    }
    const metric = raw.metric;
    if (typeof metric !== 'string' || metric.length === 0) {
      throw new TelemetryValidationError(`reading[${index}] is missing "metric"`, topic);
    }
    const value = typeof raw.value === 'string' ? Number(raw.value) : raw.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TelemetryValidationError(`reading[${index}] "${metric}" has a non-numeric value`, topic);
    }
    this.assertInRange(metric, value, topic);

    const unit = this.normaliseUnit(metric, raw.unit as string | undefined);

    const ts = raw.ts === undefined || raw.ts === null ? new Date() : new Date(raw.ts as string | number);
    if (Number.isNaN(ts.getTime())) {
      throw new TelemetryValidationError(`reading[${index}] "${metric}" has an invalid timestamp`, topic);
    }
    return { deviceId, metric, value, unit, ts };
  }

  private assertInRange(metric: string, value: number, topic: string): void {
    const range = METRIC_RANGES[metric];
    if (!range) return;
    const [lo, hi] = range;
    if (value < lo || value > hi) {
      throw new TelemetryValidationError(
        `${metric} value ${value} is outside the allowed range [${lo}, ${hi}]`,
        topic,
      );
    }
  }

  private normaliseUnit(metric: string, unit: string | undefined): string {
    const key = (unit ?? DEFAULT_UNITS[metric] ?? '').toLowerCase().trim();
    if (key === '') return '';
    return UNIT_ALIASES[key] ?? key;
  }
}
