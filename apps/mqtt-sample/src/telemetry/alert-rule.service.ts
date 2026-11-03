import { Injectable } from '@nestjs/common';
import { InvalidRuleError } from '../errors';
import { Reading } from './reading';

export type RuleCondition =
  | { op: 'gt'; threshold: number }
  | { op: 'lt'; threshold: number }
  | { op: 'between'; low: number; high: number };

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  metric: string;
  /** Restrict to one device; omit or `*` for all devices. */
  deviceId?: string;
  condition: RuleCondition;
  /** Margin the value must come back inside before the rule can re-arm. */
  hysteresis?: number;
  /** Minimum time between two alerts of the same rule for the same device. */
  debounceMs?: number;
  severity?: AlertSeverity;
}

export interface Alert {
  ruleId: string;
  deviceId: string;
  metric: string;
  value: number;
  unit: string;
  ts: Date;
  severity: AlertSeverity;
  message: string;
}

interface RuleState {
  active: boolean;
  lastFiredAt: number | null;
}

/**
 * Threshold rules evaluated per reading. A rule fires when its condition is
 * breached while inactive; it re-arms once the value is back inside the
 * condition by at least `hysteresis`; `debounceMs` suppresses re-fires.
 */
@Injectable()
export class AlertRuleService {
  private readonly rules = new Map<string, AlertRule>();
  private readonly state = new Map<string, RuleState>();

  addRule(rule: AlertRule): void {
    if (!rule.id) throw new InvalidRuleError('rule id is required');
    if (this.rules.has(rule.id)) throw new InvalidRuleError(`rule "${rule.id}" already exists`);
    if (!rule.metric) throw new InvalidRuleError(`rule "${rule.id}": metric is required`);
    const c = rule.condition;
    if (c.op === 'between' && !(c.low < c.high)) {
      throw new InvalidRuleError(`rule "${rule.id}": "between" requires low < high`);
    }
    if ((rule.hysteresis ?? 0) < 0) throw new InvalidRuleError(`rule "${rule.id}": hysteresis must be >= 0`);
    if ((rule.debounceMs ?? 0) < 0) throw new InvalidRuleError(`rule "${rule.id}": debounceMs must be >= 0`);
    this.rules.set(rule.id, { severity: 'warning', ...rule });
  }

  removeRule(id: string): boolean {
    for (const key of this.state.keys()) if (key.startsWith(`${id}|`)) this.state.delete(key);
    return this.rules.delete(id);
  }

  listRules(): AlertRule[] {
    return [...this.rules.values()];
  }

  /** Evaluate every applicable rule against one reading; returns the alerts that fired. */
  evaluate(reading: Reading): Alert[] {
    const alerts: Alert[] = [];
    for (const rule of this.rules.values()) {
      if (rule.metric !== reading.metric) continue;
      if (rule.deviceId && rule.deviceId !== '*' && rule.deviceId !== reading.deviceId) continue;

      const key = `${rule.id}|${reading.deviceId}`;
      const st = this.state.get(key) ?? { active: false, lastFiredAt: null };
      const breached = this.isBreached(rule.condition, reading.value);
      const now = reading.ts.getTime();

      if (!st.active && breached) {
        const debounce = rule.debounceMs ?? 0;
        if (st.lastFiredAt !== null && now - st.lastFiredAt < debounce) {
          this.state.set(key, st);
          continue;
        }
        st.active = true;
        st.lastFiredAt = now;
        alerts.push(this.buildAlert(rule, reading));
      } else if (st.active && !breached && this.isClear(rule, reading.value)) {
        st.active = false;
      }
      this.state.set(key, st);
    }
    return alerts;
  }

  isActive(ruleId: string, deviceId: string): boolean {
    return this.state.get(`${ruleId}|${deviceId}`)?.active ?? false;
  }

  private isBreached(c: RuleCondition, value: number): boolean {
    switch (c.op) {
      case 'gt':
        return value > c.threshold;
      case 'lt':
        return value < c.threshold;
      case 'between':
        return value < c.low || value > c.high;
    }
  }

  /** True once the value is back inside the condition by at least the hysteresis margin. */
  private isClear(rule: AlertRule, value: number): boolean {
    const h = rule.hysteresis ?? 0;
    const c = rule.condition;
    switch (c.op) {
      case 'gt':
        return value <= c.threshold - h;
      case 'lt':
        return value >= c.threshold + h;
      case 'between':
        return value >= c.low + h && value <= c.high - h;
    }
  }

  private buildAlert(rule: AlertRule, r: Reading): Alert {
    return {
      ruleId: rule.id,
      deviceId: r.deviceId,
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      ts: r.ts,
      severity: rule.severity ?? 'warning',
      message: `${r.metric}=${r.value}${r.unit} breached rule ${rule.id} (${describe(rule.condition)})`,
    };
  }
}

function describe(c: RuleCondition): string {
  switch (c.op) {
    case 'gt':
      return `> ${c.threshold}`;
    case 'lt':
      return `< ${c.threshold}`;
    case 'between':
      return `outside [${c.low}, ${c.high}]`;
  }
}
