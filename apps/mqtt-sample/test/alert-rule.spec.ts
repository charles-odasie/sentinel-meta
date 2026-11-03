import { InvalidRuleError } from '../src/errors';
import { AlertRuleService } from '../src/telemetry/alert-rule.service';
import { Reading } from '../src/telemetry/reading';

const T0 = new Date('2026-03-01T10:00:00Z');

function reading(value: number, overrides: Partial<Reading> = {}): Reading {
  return { deviceId: 'd1', metric: 'temperature', value, unit: 'C', ts: T0, ...overrides };
}

function later(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

describe('AlertRuleService', () => {
  let rules: AlertRuleService;

  beforeEach(() => {
    rules = new AlertRuleService();
  });

  describe('rule registration', () => {
    it('rejects duplicate ids, missing metric, inverted bounds, negative hysteresis/debounce', () => {
      rules.addRule({ id: 'r', metric: 'temperature', condition: { op: 'gt', threshold: 1 } });
      expect(() => rules.addRule({ id: 'r', metric: 'temperature', condition: { op: 'gt', threshold: 1 } })).toThrow(
        InvalidRuleError,
      );
      expect(() => rules.addRule({ id: 'x', metric: '', condition: { op: 'gt', threshold: 1 } })).toThrow(InvalidRuleError);
      expect(() => rules.addRule({ id: 'y', metric: 'humidity', condition: { op: 'between', low: 80, high: 20 } })).toThrow(
        /low < high/,
      );
      expect(() =>
        rules.addRule({ id: 'h', metric: 'temperature', condition: { op: 'gt', threshold: 1 }, hysteresis: -1 }),
      ).toThrow(InvalidRuleError);
      expect(() =>
        rules.addRule({ id: 'd', metric: 'temperature', condition: { op: 'gt', threshold: 1 }, debounceMs: -1 }),
      ).toThrow(InvalidRuleError);
    });

    it('removes a rule and its state', () => {
      rules.addRule({ id: 'r', metric: 'temperature', condition: { op: 'gt', threshold: 10 } });
      rules.evaluate(reading(50));
      expect(rules.isActive('r', 'd1')).toBe(true);
      expect(rules.removeRule('r')).toBe(true);
      expect(rules.isActive('r', 'd1')).toBe(false);
      expect(rules.listRules()).toEqual([]);
    });
  });

  describe('conditions', () => {
    it('gt and lt fire strictly beyond the threshold', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', condition: { op: 'gt', threshold: 30 } });
      rules.addRule({ id: 'low', metric: 'battery', condition: { op: 'lt', threshold: 15 } });
      expect(rules.evaluate(reading(30))).toHaveLength(0);
      expect(rules.evaluate(reading(30.1))).toHaveLength(1);
      expect(rules.evaluate(reading(15, { metric: 'battery' }))).toHaveLength(0);
      const alerts = rules.evaluate(reading(14, { metric: 'battery' }));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ ruleId: 'low', deviceId: 'd1', metric: 'battery', value: 14, severity: 'warning' });
    });

    it('between fires outside the inclusive band', () => {
      rules.addRule({ id: 'band', metric: 'humidity', condition: { op: 'between', low: 20, high: 80 } });
      expect(rules.evaluate(reading(20, { metric: 'humidity' }))).toHaveLength(0);
      expect(rules.evaluate(reading(80, { metric: 'humidity' }))).toHaveLength(0);
      expect(rules.evaluate(reading(81, { metric: 'humidity' }))).toHaveLength(1);
    });

    it('ignores readings for other metrics and other devices', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', deviceId: 'd1', condition: { op: 'gt', threshold: 30 } });
      expect(rules.evaluate(reading(99, { metric: 'humidity' }))).toHaveLength(0);
      expect(rules.evaluate(reading(99, { deviceId: 'd2' }))).toHaveLength(0);
      expect(rules.evaluate(reading(99))).toHaveLength(1);
    });

    it('builds a human-readable message with the unit and severity', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', condition: { op: 'gt', threshold: 30 }, severity: 'critical' });
      const [a] = rules.evaluate(reading(35));
      expect(a.message).toBe('temperature=35C breached rule hot (> 30)');
      expect(a.severity).toBe('critical');
    });
  });

  describe('hysteresis', () => {
    it('does not re-fire while active; re-arms once below threshold minus hysteresis', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', condition: { op: 'gt', threshold: 30 }, hysteresis: 2 });
      expect(rules.evaluate(reading(31))).toHaveLength(1);
      expect(rules.evaluate(reading(40))).toHaveLength(0);
      rules.evaluate(reading(29)); // inside the band: still active
      expect(rules.isActive('hot', 'd1')).toBe(true);
      expect(rules.evaluate(reading(31))).toHaveLength(0);
      rules.evaluate(reading(28)); // clears
      expect(rules.isActive('hot', 'd1')).toBe(false);
      expect(rules.evaluate(reading(31))).toHaveLength(1);
    });

    it('applies hysteresis symmetrically for between', () => {
      rules.addRule({ id: 'band', metric: 'humidity', condition: { op: 'between', low: 20, high: 80 }, hysteresis: 5 });
      const h = (v: number) => reading(v, { metric: 'humidity' });
      expect(rules.evaluate(h(85))).toHaveLength(1);
      rules.evaluate(h(78));
      expect(rules.isActive('band', 'd1')).toBe(true);
      rules.evaluate(h(75));
      expect(rules.isActive('band', 'd1')).toBe(false);
    });

    it('tracks state per device independently', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', condition: { op: 'gt', threshold: 30 } });
      expect(rules.evaluate(reading(31, { deviceId: 'a' }))).toHaveLength(1);
      expect(rules.evaluate(reading(31, { deviceId: 'b' }))).toHaveLength(1);
      expect(rules.isActive('hot', 'a')).toBe(true);
      expect(rules.isActive('hot', 'b')).toBe(true);
    });
  });

  describe('debounce', () => {
    it('suppresses a re-fire inside the debounce window and allows it after', () => {
      rules.addRule({ id: 'hot', metric: 'temperature', condition: { op: 'gt', threshold: 30 }, debounceMs: 60_000 });
      expect(rules.evaluate(reading(31, { ts: later(0) }))).toHaveLength(1);
      rules.evaluate(reading(20, { ts: later(10) })); // clears
      expect(rules.evaluate(reading(31, { ts: later(20) }))).toHaveLength(0); // debounced
      rules.evaluate(reading(20, { ts: later(30) }));
      expect(rules.evaluate(reading(31, { ts: later(61) }))).toHaveLength(1);
    });
  });
});
