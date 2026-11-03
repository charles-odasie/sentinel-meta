import { Module } from '@nestjs/common';
import { MqttModule } from '../mqtt/mqtt.module';
import { AlertRuleService } from './alert-rule.service';
import { DeviceRegistryService } from './device-registry.service';
import { IngestService } from './ingest.service';
import { RetainedStateService } from './retained-state.service';
import { TelemetryParserService } from './telemetry-parser.service';

@Module({
  imports: [MqttModule],
  providers: [TelemetryParserService, DeviceRegistryService, AlertRuleService, RetainedStateService, IngestService],
  exports: [TelemetryParserService, DeviceRegistryService, AlertRuleService, RetainedStateService, IngestService],
})
export class TelemetryModule {}
