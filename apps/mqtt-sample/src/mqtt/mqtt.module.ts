import { Module } from '@nestjs/common';
import { TopicMatcherService } from '../telemetry/topic-matcher.service';
import { MqttBrokerService } from './mqtt-broker.service';
import { MqttClientService } from './mqtt-client.service';

/**
 * Provides an in-process aedes broker and an mqtt.js client bound to it.
 * Lifecycle (start/connect/close) is driven by whoever owns the module so
 * that tests and the application can control ordering explicitly.
 */
@Module({
  providers: [TopicMatcherService, MqttBrokerService, MqttClientService],
  exports: [TopicMatcherService, MqttBrokerService, MqttClientService],
})
export class MqttModule {}
