/**
 * Shared bootstrap for the bug trigger scripts. Boots the real hub (in-process
 * aedes broker + mqtt.js client + all services, wired exactly like AppModule)
 * plus a simulated device client. Run a trigger from apps/mqtt-sample:
 *
 *   npx tsx ../../bench/bugs/B01/trigger.ts
 *
 * Exit code is 1 when any error was logged, 0 otherwise.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { MqttClient } from 'mqtt';
import { DEFAULT_RULES } from '../../../apps/mqtt-sample/src/app.module';
import { logger } from '../../../apps/mqtt-sample/src/logger';
import { BrokerOptions, MqttBrokerService } from '../../../apps/mqtt-sample/src/mqtt/mqtt-broker.service';
import { MqttClientService } from '../../../apps/mqtt-sample/src/mqtt/mqtt-client.service';
import { AlertRule, AlertRuleService } from '../../../apps/mqtt-sample/src/telemetry/alert-rule.service';
import { DeviceRegistryService } from '../../../apps/mqtt-sample/src/telemetry/device-registry.service';
import { IngestService } from '../../../apps/mqtt-sample/src/telemetry/ingest.service';
import { DeviceSeedProvider, SnapshotStore } from '../../../apps/mqtt-sample/src/telemetry/reading';
import { RetainedStateService } from '../../../apps/mqtt-sample/src/telemetry/retained-state.service';
import { TelemetryParserService } from '../../../apps/mqtt-sample/src/telemetry/telemetry-parser.service';
import { TopicMatcherService } from '../../../apps/mqtt-sample/src/telemetry/topic-matcher.service';

// Resolve third-party packages from the app's node_modules, not from bench/.
const appRequire = createRequire(resolve(__dirname, '../../../apps/mqtt-sample/package.json'));
const mqtt = appRequire('mqtt') as typeof import('mqtt');

export interface HubOptions {
  seed?: DeviceSeedProvider;
  store?: SnapshotStore;
  rules?: AlertRule[];
  broker?: BrokerOptions;
}

export interface Hub {
  broker: MqttBrokerService;
  client: MqttClientService;
  matcher: TopicMatcherService;
  registry: DeviceRegistryService;
  rules: AlertRuleService;
  retained: RetainedStateService;
  ingest: IngestService;
  device: MqttClient;
  /** Publish as a device (QoS 1, awaits the broker ack). */
  publish(topic: string, payload: unknown): Promise<void>;
  shutdown(): Promise<void>;
}

let loggedErrors = 0;
logger.level = (process.env.LOG_LEVEL as typeof logger.level) ?? 'info';
logger.on('log', (level: string) => {
  if (level === 'error') loggedErrors += 1;
});

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(10);
  }
}

export async function bootHub(opts: HubOptions = {}): Promise<Hub> {
  const matcher = new TopicMatcherService();
  const broker = new MqttBrokerService();
  const client = new MqttClientService(matcher);
  const registry = new DeviceRegistryService(opts.seed);
  const rules = new AlertRuleService();
  const retained = new RetainedStateService(opts.store);
  const ingest = new IngestService(client, matcher, new TelemetryParserService(), registry, rules, retained);

  const port = await broker.start(opts.broker);
  await client.connect(port, '127.0.0.1', 'telemetry-hub-1');
  for (const rule of opts.rules ?? DEFAULT_RULES.map((r) => ({ ...r }) as AlertRule)) rules.addRule(rule);
  await ingest.start();

  const device = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { clientId: 'device-sim', reconnectPeriod: 0 });

  let stopped = false;
  return {
    broker,
    client,
    matcher,
    registry,
    rules,
    retained,
    ingest,
    device,
    async publish(topic, payload) {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await device.publishAsync(topic, body, { qos: 1 });
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      await device.endAsync();
      await ingest.stop();
      await broker.stop();
    },
  };
}

/** Run a background job the way the scheduler does: log start, log failure with context. */
export async function job(name: string, fn: () => Promise<void> | void): Promise<void> {
  logger.info('job started', { job: name });
  try {
    await fn();
    logger.info('job finished', { job: name });
  } catch (err) {
    logger.error('job failed', { job: name }, err);
  }
}

export async function run(fn: () => Promise<void>): Promise<void> {
  logger.info('telemetry-hub starting', { pid: process.pid, node: process.version, env: 'production' });
  try {
    await fn();
  } catch (err) {
    logger.error('unhandled error', {}, err);
  }
  logger.info('telemetry-hub exited', { errors: loggedErrors });
  process.exitCode = loggedErrors > 0 ? 1 : 0;
}
