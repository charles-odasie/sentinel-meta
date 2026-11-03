import { Test, TestingModule } from '@nestjs/testing';
import { connectAsync, MqttClient } from 'mqtt';
import { AppModule } from '../src/app.module';
import { MqttBrokerService } from '../src/mqtt/mqtt-broker.service';
import { MqttClientService } from '../src/mqtt/mqtt-client.service';
import { AlertRuleService } from '../src/telemetry/alert-rule.service';
import { DeviceRegistryService } from '../src/telemetry/device-registry.service';
import { IngestService } from '../src/telemetry/ingest.service';
import { RetainedStateService } from '../src/telemetry/retained-state.service';
import { TopicMatcherService } from '../src/telemetry/topic-matcher.service';

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('telemetry-hub through the in-process broker', () => {
  let app: TestingModule;
  let broker: MqttBrokerService;
  let hub: MqttClientService;
  let ingest: IngestService;
  let registry: DeviceRegistryService;
  let retained: RetainedStateService;
  let device: MqttClient;
  const alerts: Array<{ topic: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    broker = app.get(MqttBrokerService);
    hub = app.get(MqttClientService);
    ingest = app.get(IngestService);
    registry = app.get(DeviceRegistryService);
    retained = app.get(RetainedStateService);

    device = await connectAsync(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'device-sim', reconnectPeriod: 0 });
    device.on('message', (topic, payload) => alerts.push({ topic, body: JSON.parse(payload.toString()) }));
    await device.subscribeAsync('alerts/#', { qos: 1 });
  });

  afterAll(async () => {
    await device.endAsync();
    await app.close();
  });

  it('starts the broker on an ephemeral port with the hub connected', () => {
    expect(broker.port).toBeGreaterThan(0);
    expect(hub.connected).toBe(true);
    expect(hub.filters).toEqual([
      'devices/+/telemetry',
      'devices/+/children/+/telemetry',
      'devices/+/status',
      '$SYS/+/heartbeat',
    ]);
    expect(app.get(AlertRuleService).listRules().map((r) => r.id)).toEqual(['temp-high', 'battery-low', 'humidity-band']);
  });

  it('ingests a telemetry message end-to-end', async () => {
    await device.publishAsync(
      'devices/greenhouse-1/telemetry',
      JSON.stringify({ metric: 'temperature', value: 22.5, unit: 'C', ts: '2026-03-01T10:00:00Z' }),
      { qos: 1 },
    );
    await waitFor(() => ingest.snapshot().readings >= 1);

    expect(registry.get('greenhouse-1')).toMatchObject({ status: 'online', lastSeen: new Date('2026-03-01T10:00:00Z') });
    expect(retained.lastValue('greenhouse-1', 'temperature')?.value).toBe(22.5);
    expect(alerts).toHaveLength(0);
  });

  it('publishes an alert to alerts/{deviceId} when a rule is breached', async () => {
    await device.publishAsync(
      'devices/greenhouse-1/telemetry',
      JSON.stringify([
        { metric: 'temperature', value: 85, unit: 'C' },
        { metric: 'humidity', value: 50, unit: '%' },
      ]),
      { qos: 1 },
    );
    await waitFor(() => alerts.length >= 1);

    expect(alerts[0].topic).toBe('alerts/greenhouse-1');
    expect(alerts[0].body).toMatchObject({ ruleId: 'temp-high', metric: 'temperature', value: 85, severity: 'critical' });
    expect(ingest.snapshot()).toMatchObject({ readings: 3, alerts: 1 });
  });

  it('applies status messages to the registry', async () => {
    await device.publishAsync('devices/greenhouse-1/status', JSON.stringify({ status: 'offline' }), { qos: 1 });
    await waitFor(() => ingest.snapshot().statusUpdates >= 1);
    expect(registry.get('greenhouse-1')?.status).toBe('offline');
  });

  it('attributes gateway-relayed readings to the child and marks the gateway alive', async () => {
    await device.publishAsync(
      'devices/gw-1/children/node-7/telemetry',
      JSON.stringify({ metric: 'battery', value: 64, ts: '2026-03-01T11:00:00Z' }),
      { qos: 1 },
    );
    await waitFor(() => registry.get('node-7') !== undefined);
    expect(retained.lastValue('node-7', 'battery')?.value).toBe(64);
    expect(registry.get('gw-1')).toMatchObject({ status: 'online', lastSeen: new Date('2026-03-01T11:00:00Z') });
    expect(retained.metricsFor('gw-1')).toEqual([]);
  });

  it('logs and counts a bad payload without crashing the pipeline', async () => {
    const failedBefore = hub.stats.failed;
    await device.publishAsync('devices/greenhouse-1/telemetry', '{"metric":"temperature","value":"hot"}', { qos: 1 });
    await waitFor(() => hub.stats.failed > failedBefore);

    await device.publishAsync('devices/greenhouse-2/telemetry', JSON.stringify({ metric: 'battery', value: 90 }), {
      qos: 1,
    });
    await waitFor(() => registry.get('greenhouse-2') !== undefined);
    expect(hub.connected).toBe(true);
  });
});

describe('MqttClientService dispatch', () => {
  const broker = new MqttBrokerService();
  const client = new MqttClientService(new TopicMatcherService());

  beforeAll(async () => {
    const port = await broker.start({ heartbeatIntervalMs: 50 });
    await client.connect(port, '127.0.0.1', 'dispatch-test');
  });

  afterAll(async () => {
    await client.close();
    await broker.stop();
  });

  it('receives the broker $SYS heartbeat through an explicit $SYS filter', async () => {
    const beats: string[] = [];
    await client.subscribe('$SYS/+/heartbeat', (topic) => {
      beats.push(topic);
    });
    await waitFor(() => beats.length >= 2);
    expect(beats[0]).toBe(`$SYS/${broker.id}/heartbeat`);
  });

  it('fans a message out to every matching handler and waits for them on drain()', async () => {
    const seen: string[] = [];
    await client.subscribe('fanout/+', async (topic) => {
      await new Promise((r) => setTimeout(r, 30));
      seen.push(`a:${topic}`);
    });
    await client.subscribe('fanout/#', (topic) => {
      seen.push(`b:${topic}`);
    });
    await client.publish('fanout/x', 'hi');
    await waitFor(() => client.stats.inFlight > 0);
    await client.drain();
    expect(seen.sort()).toEqual(['a:fanout/x', 'b:fanout/x']);
    expect(client.stats.inFlight).toBe(0);
  });

  it('counts a failing handler as failed and keeps serving', async () => {
    const before = client.stats;
    await client.subscribe('boom/+', () => {
      throw new Error('handler exploded');
    });
    await client.publish('boom/1', '');
    await waitFor(() => client.stats.failed > before.failed);
    await client.publish('fanout/y', '');
    await waitFor(() => client.stats.handled > before.handled);
  });

  it('rejects malformed filters before subscribing', async () => {
    await expect(client.subscribe('bad/#/filter', () => undefined)).rejects.toThrow(/"#" must occupy/);
  });
});
