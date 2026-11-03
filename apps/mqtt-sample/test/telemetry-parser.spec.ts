import { TelemetryValidationError } from '../src/errors';
import { MAX_BATCH_SIZE, TelemetryParserService } from '../src/telemetry/telemetry-parser.service';

const TOPIC = 'devices/sensor-7/telemetry';
const buf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

describe('TelemetryParserService', () => {
  let parser: TelemetryParserService;

  beforeEach(() => {
    parser = new TelemetryParserService();
  });

  describe('topic handling', () => {
    it('extracts the deviceId from the topic', () => {
      const [r] = parser.parse(TOPIC, buf({ metric: 'temperature', value: 21.5, unit: 'C' }));
      expect(r.deviceId).toBe('sensor-7');
    });

    it('rejects topics that are not device telemetry', () => {
      expect(() => parser.parse('devices/sensor-7/status', buf({ metric: 'temperature', value: 1 }))).toThrow(
        TelemetryValidationError,
      );
      expect(() => parser.parse('devices/a/b/telemetry', buf({ metric: 'temperature', value: 1 }))).toThrow(
        /not a device telemetry topic/,
      );
    });
  });

  describe('single reading', () => {
    it('parses a complete reading from a Buffer or a string', () => {
      const [r] = parser.parse(TOPIC, buf({ metric: 'temperature', value: 21.5, unit: 'C', ts: '2026-01-02T03:04:05Z' }));
      expect(r).toEqual({
        deviceId: 'sensor-7',
        metric: 'temperature',
        value: 21.5,
        unit: 'C',
        ts: new Date('2026-01-02T03:04:05Z'),
      });
      expect(parser.parse(TOPIC, JSON.stringify({ metric: 'humidity', value: 40, unit: '%' }))[0].value).toBe(40);
    });

    it('coerces numeric strings and epoch timestamps, and stamps now when ts is absent', () => {
      const [r] = parser.parse(TOPIC, buf({ metric: 'pressure', value: '1013.2', unit: 'hPa', ts: 1700000000000 }));
      expect(r.value).toBe(1013.2);
      expect(r.ts.getTime()).toBe(1700000000000);

      const before = Date.now();
      const [n] = parser.parse(TOPIC, buf({ metric: 'temperature', value: 20, unit: 'C' }));
      expect(n.ts.getTime()).toBeGreaterThanOrEqual(before);
      expect(n.ts.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('units', () => {
    it('normalises aliases and falls back to the metric default when omitted', () => {
      expect(parser.parse(TOPIC, buf({ metric: 'temperature', value: 20, unit: 'celsius' }))[0].unit).toBe('C');
      expect(parser.parse(TOPIC, buf({ metric: 'humidity', value: 20, unit: 'percent' }))[0].unit).toBe('%');
      expect(parser.parse(TOPIC, buf({ metric: 'pressure', value: 1000, unit: 'mbar' }))[0].unit).toBe('hPa');
      expect(parser.parse(TOPIC, buf({ metric: 'humidity', value: 55 }))[0].unit).toBe('%');
      expect(parser.parse(TOPIC, buf({ metric: 'temperature', value: 20 }))[0].unit).toBe('C');
    });

    it('keeps unknown units as sent (trimmed)', () => {
      expect(parser.parse(TOPIC, buf({ metric: 'co2', value: 600, unit: ' ppm ' }))[0].unit).toBe('ppm');
      expect(parser.parse(TOPIC, buf({ metric: 'lux', value: 600, unit: 'lx' }))[0].unit).toBe('lx');
    });
  });

  describe('validation', () => {
    it('rejects invalid JSON and a missing metric', () => {
      expect(() => parser.parse(TOPIC, Buffer.from('{not json'))).toThrow(/not valid JSON/);
      expect(() => parser.parse(TOPIC, buf({ value: 1 }))).toThrow(/missing "metric"/);
    });

    it('rejects non-numeric values and invalid timestamps', () => {
      expect(() => parser.parse(TOPIC, buf({ metric: 'temperature', value: 'hot' }))).toThrow(/non-numeric/);
      expect(() => parser.parse(TOPIC, buf({ metric: 'temperature', value: null }))).toThrow(/non-numeric/);
      expect(() => parser.parse(TOPIC, buf({ metric: 'temperature', value: 1, ts: 'yesterday' }))).toThrow(
        /invalid timestamp/,
      );
    });

    it('range-checks known metrics only', () => {
      expect(() => parser.parse(TOPIC, buf({ metric: 'temperature', value: 200 }))).toThrow(/outside the allowed range/);
      expect(() => parser.parse(TOPIC, buf({ metric: 'humidity', value: -5 }))).toThrow(/outside the allowed range/);
      expect(() => parser.parse(TOPIC, buf({ metric: 'battery', value: 150 }))).toThrow(/outside the allowed range/);
      expect(parser.parse(TOPIC, buf({ metric: 'temperature', value: 23.4 }))[0].value).toBe(23.4);
      expect(parser.parse(TOPIC, buf({ metric: 'co2', value: 99999, unit: 'ppm' }))[0].value).toBe(99999);
    });

    it('reports the failing index in a batch', () => {
      const batch = [
        { metric: 'temperature', value: 20 },
        { metric: 'temperature', value: 'x' },
      ];
      expect(() => parser.parse(TOPIC, buf(batch))).toThrow(/reading\[1\]/);
    });
  });

  describe('batches', () => {
    it('parses an array payload and a { readings: [...] } envelope', () => {
      const out = parser.parse(
        TOPIC,
        buf([
          { metric: 'temperature', value: 20, unit: 'C' },
          { metric: 'humidity', value: 50, unit: '%' },
        ]),
      );
      expect(out.map((r) => r.metric)).toEqual(['temperature', 'humidity']);
      expect(out.every((r) => r.deviceId === 'sensor-7')).toBe(true);

      const wrapped = parser.parse(TOPIC, buf({ readings: [{ metric: 'battery', value: 88 }] }));
      expect(wrapped).toHaveLength(1);
      expect(wrapped[0].metric).toBe('battery');
    });

    it('rejects empty and oversized batches', () => {
      expect(() => parser.parse(TOPIC, buf([]))).toThrow(/no readings/);
      expect(() => parser.parse(TOPIC, buf({ readings: [] }))).toThrow(/no readings/);
      const big = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => ({ metric: 'temperature', value: 20 }));
      expect(() => parser.parse(TOPIC, buf(big))).toThrow(/exceeds max/);
    });
  });
});
