import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MqttBrokerService } from './mqtt/mqtt-broker.service';
import { MqttClientService } from './mqtt/mqtt-client.service';
import { MqttModule } from './mqtt/mqtt.module';
import { AlertRuleService } from './telemetry/alert-rule.service';
import { IngestService } from './telemetry/ingest.service';
import { TelemetryModule } from './telemetry/telemetry.module';

/** Default rules shipped with the hub; real deployments load these from config. */
export const DEFAULT_RULES = [
  { id: 'temp-high', metric: 'temperature', condition: { op: 'gt', threshold: 80 }, hysteresis: 2, severity: 'critical' },
  { id: 'battery-low', metric: 'battery', condition: { op: 'lt', threshold: 15 }, hysteresis: 5, debounceMs: 60_000 },
  { id: 'humidity-band', metric: 'humidity', condition: { op: 'between', low: 20, high: 80 }, hysteresis: 1 },
] as const;

/**
 * Root module. Owns the lifecycle ordering: broker -> client -> ingest on
 * init, and the reverse on destroy, so no step races another.
 */
@Module({ imports: [MqttModule, TelemetryModule] })
export class AppModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly broker: MqttBrokerService,
    private readonly client: MqttClientService,
    private readonly ingest: IngestService,
    private readonly rules: AlertRuleService,
  ) {}

  async onModuleInit(): Promise<void> {
    const port = await this.broker.start({ port: Number(process.env.MQTT_PORT ?? 0) });
    await this.client.connect(port);
    for (const rule of DEFAULT_RULES) this.rules.addRule({ ...rule });
    await this.ingest.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.ingest.stop();
    await this.broker.stop();
  }
}
