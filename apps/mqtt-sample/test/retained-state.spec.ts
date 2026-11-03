import { Reading, SnapshotStore } from '../src/telemetry/reading';
import { DEFAULT_WINDOW_SIZE, RetainedStateService } from '../src/telemetry/retained-state.service';

const T0 = new Date('2026-03-01T10:00:00Z');

function reading(value: number, i = 0, overrides: Partial<Reading> = {}): Reading {
  return { deviceId: 'd1', metric: 'temperature', value, unit: 'C', ts: new Date(T0.getTime() + i * 1000), ...overrides };
}

/** One minute of 1 Hz samples: a realistic device window. */
async function fillMinute(state: RetainedStateService, values: (i: number) => number, n = 60): Promise<void> {
  for (let i = 0; i < n; i++) await state.record(reading(values(i), i));
}

describe('RetainedStateService', () => {
  let state: RetainedStateService;

  beforeEach(() => {
    state = new RetainedStateService();
  });

  describe('last-known value', () => {
    it('is undefined for an unknown device/metric', () => {
      expect(state.lastValue('d1', 'temperature')).toBeUndefined();
      expect(state.aggregate('d1', 'temperature')).toBeUndefined();
    });

    it('keeps the most recent reading per device and metric and lists metrics per device', async () => {
      await state.record(reading(20, 0));
      await state.record(reading(21, 1));
      await state.record(reading(55, 2, { metric: 'humidity', unit: '%' }));
      await state.record(reading(30, 3, { deviceId: 'd2' }));
      expect(state.lastValue('d1', 'temperature')?.value).toBe(21);
      expect(state.lastValue('d1', 'humidity')?.value).toBe(55);
      expect(state.lastValue('d2', 'temperature')?.value).toBe(30);
      expect(state.metricsFor('d1').sort()).toEqual(['humidity', 'temperature']);
      expect(state.metricsFor('d3')).toEqual([]);
    });

    it('clear() forgets one device or everything', async () => {
      await state.record(reading(20));
      await state.record(reading(30, 0, { deviceId: 'd2' }));
      state.clear('d1');
      expect(state.lastValue('d1', 'temperature')).toBeUndefined();
      expect(state.lastValue('d2', 'temperature')?.value).toBe(30);
      state.clear();
      expect(state.lastValue('d2', 'temperature')).toBeUndefined();
    });
  });

  describe('sliding-window aggregates', () => {
    it('computes count/avg/min/max/first/last over a full minute of samples', async () => {
      expect(state.windowSize).toBe(DEFAULT_WINDOW_SIZE);
      await fillMinute(state, (i) => 20 + (i % 10)); // 20..29 repeating
      const agg = state.aggregate('d1', 'temperature')!;
      expect(agg).toMatchObject({ count: 60, min: 20, max: 29, avg: 24.5 });
      expect(agg.first).toEqual(reading(0, 0).ts);
      expect(agg.last).toEqual(reading(0, 59).ts);
    });

    it('computes a nearest-rank p95 rounded to two decimals', async () => {
      await fillMinute(state, (i) => 20 + (i % 10)); // top decile is all 29s
      expect(state.aggregate('d1', 'temperature')!.p95).toBe(29);

      const thirds = new RetainedStateService();
      await fillMinute(thirds, (i) => (i % 3) / 3);
      expect(thirds.aggregate('d1', 'temperature')).toMatchObject({ avg: 0.33, p95: 0.67 });
    });

    it('keeps only the most recent windowSize readings', async () => {
      await fillMinute(state, (i) => i, 75); // 0..74, window should hold 15..74
      const agg = state.aggregate('d1', 'temperature')!;
      expect(agg).toMatchObject({ count: 60, min: 15, max: 74 });
      expect(agg.first).toEqual(reading(0, 15).ts);
    });

    it('honours a custom window size and rejects a non-positive one', async () => {
      const small = new RetainedStateService(undefined, 20);
      for (let i = 0; i < 100; i++) await small.record(reading(i, i));
      expect(small.aggregate('d1', 'temperature')).toMatchObject({ count: 20, min: 80, avg: 89.5 });
      expect(() => new RetainedStateService(undefined, 0)).toThrow(RangeError);
      expect(() => new RetainedStateService(undefined, 2.5)).toThrow(RangeError);
    });
  });

  describe('snapshot store', () => {
    it('forwards every recorded reading to the store and propagates store failures', async () => {
      const puts: Array<[string, number]> = [];
      const store: SnapshotStore = {
        put: async (key, r) => {
          puts.push([key, r.value]);
        },
      };
      const persisted = new RetainedStateService(store);
      await persisted.record(reading(1));
      await persisted.record(reading(2, 1, { metric: 'humidity' }));
      expect(puts).toEqual([
        ['d1/temperature', 1],
        ['d1/humidity', 2],
      ]);

      const failing = new RetainedStateService({
        put: async () => {
          throw new Error('disk full');
        },
      });
      await expect(failing.record(reading(1))).rejects.toThrow('disk full');
    });
  });
});
