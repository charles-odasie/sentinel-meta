import { Injectable } from '@nestjs/common';
import { logger } from '../logger';
import { MqttClientService } from '../mqtt/mqtt-client.service';
import { AlertRuleService } from './alert-rule.service';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceStatus, Reading } from './reading';
import { Aggregate, RetainedStateService } from './retained-state.service';
import { TelemetryParserService } from './telemetry-parser.service';
import { TopicMatcherService } from './topic-matcher.service';

export const TELEMETRY_FILTER = 'devices/+/telemetry';
/** Leaf nodes relayed by a gateway: devices/{gatewayId}/children/{childId}/telemetry */
export const CHILD_TELEMETRY_FILTER = 'devices/+/children/+/telemetry';
export const STATUS_FILTER = 'devices/+/status';
export const HEARTBEAT_FILTER = '$SYS/+/heartbeat';

const STATUS_VALUES: ReadonlySet<string> = new Set<DeviceStatus>(['online', 'offline', 'unknown']);

export interface IngestStats {
  readings: number;
  alerts: number;
  statusUpdates: number;
  brokerLastBeat: Date | null;
}

export interface MetricSummary extends Aggregate {
  deviceId: string;
  metric: string;
}

/**
 * Wires the MQTT client to the domain services:
 * telemetry -> parser -> registry -> rules -> retained state, alerts out.
 */
@Injectable()
export class IngestService {
  private readonly stats: IngestStats = { readings: 0, alerts: 0, statusUpdates: 0, brokerLastBeat: null };

  constructor(
    private readonly mqtt: MqttClientService,
    private readonly matcher: TopicMatcherService,
    private readonly parser: TelemetryParserService,
    private readonly registry: DeviceRegistryService,
    private readonly rules: AlertRuleService,
    private readonly retained: RetainedStateService,
  ) {}

  async start(): Promise<void> {
    await this.registry.load();
    logger.info('device registry loaded', { devices: this.registry.size });
    await this.mqtt.subscribe(TELEMETRY_FILTER, (t, p) => this.handleTelemetry(t, p));
    await this.mqtt.subscribe(CHILD_TELEMETRY_FILTER, (t, p) => this.handleChildTelemetry(t, p));
    await this.mqtt.subscribe(STATUS_FILTER, (t, p) => this.handleStatus(t, p));
    await this.mqtt.subscribe(HEARTBEAT_FILTER, (t, p) => this.handleHeartbeat(t, p));
    logger.info('ingest started', { filters: this.mqtt.filters });
  }

  async stop(): Promise<void> {
    await this.mqtt.close();
    logger.info('ingest stopped', { ...this.snapshot() });
  }

  snapshot(): IngestStats {
    return { ...this.stats };
  }

  /** Window aggregates for every device/metric seen so far (stats endpoint, periodic report). */
  summary(): MetricSummary[] {
    const out: MetricSummary[] = [];
    for (const device of this.registry.list()) {
      for (const metric of this.retained.metricsFor(device.id)) {
        const agg = this.retained.aggregate(device.id, metric);
        if (agg) out.push({ deviceId: device.id, metric, ...agg });
      }
    }
    return out;
  }

  /** Offline sweep: mark silent devices offline and raise an alert for each. */
  async sweepOffline(thresholdMs: number, now: Date = new Date()): Promise<string[]> {
    const ids = this.registry.sweep(thresholdMs, now);
    for (const deviceId of ids) {
      logger.warn('device offline', { deviceId, thresholdMs });
      await this.mqtt.publish(`alerts/${deviceId}`, { ruleId: 'device-offline', deviceId, ts: now, severity: 'warning' });
    }
    return ids;
  }

  async handleTelemetry(topic: string, payload: Buffer): Promise<void> {
    await this.process(topic, this.parser.parse(topic, payload));
  }

  async handleChildTelemetry(topic: string, payload: Buffer): Promise<void> {
    const [gatewayId, childId] = this.matcher.captures(CHILD_TELEMETRY_FILTER, topic) ?? [];
    const readings = this.parser.parseFor(childId, payload, topic);
    this.registry.touch(gatewayId, readings[0].ts); // the gateway relayed it, so it is alive too
    await this.process(topic, readings);
  }

  async handleStatus(topic: string, payload: Buffer): Promise<void> {
    const [deviceId] = this.matcher.captures(STATUS_FILTER, topic) ?? [];
    const body = JSON.parse(payload.toString('utf8')) as { status?: unknown; ts?: unknown };
    const status = String(body.status ?? '').toLowerCase();
    if (!STATUS_VALUES.has(status)) {
      logger.warn('ignoring unknown device status', { topic, deviceId, status });
      return;
    }
    const ts = body.ts ? new Date(body.ts as string) : new Date();
    this.registry.setStatus(deviceId, status as DeviceStatus, ts);
    this.stats.statusUpdates += 1;
  }

  async handleHeartbeat(topic: string, payload: Buffer): Promise<void> {
    const beat = Number(payload.toString('utf8'));
    this.stats.brokerLastBeat = Number.isFinite(beat) ? new Date(beat) : new Date();
    logger.debug('broker heartbeat', { topic, at: this.stats.brokerLastBeat.toISOString() });
  }

  private async process(topic: string, readings: Reading[]): Promise<void> {
    for (const reading of readings) {
      this.registry.touch(reading.deviceId, reading.ts);
      await this.retained.record(reading);
      this.stats.readings += 1;

      for (const alert of this.rules.evaluate(reading)) {
        this.stats.alerts += 1;
        logger.warn('alert raised', { topic, deviceId: alert.deviceId, ruleId: alert.ruleId, value: alert.value });
        await this.mqtt.publish(`alerts/${alert.deviceId}`, alert, { qos: 1 });
      }
    }
  }
}
