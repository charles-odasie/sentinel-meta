import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from './logger';
import { MqttBrokerService } from './mqtt/mqtt-broker.service';

/**
 * Standalone entry point: starts the in-process broker, connects the hub and
 * waits for telemetry. Set MQTT_PORT to bind a fixed port (default: ephemeral).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const broker = app.get(MqttBrokerService);
  logger.info('telemetry-hub ready', { port: broker.port });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('bootstrap failed', {}, err);
  process.exit(1);
});
