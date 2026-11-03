import { Injectable } from '@nestjs/common';
import { connectAsync, MqttClient } from 'mqtt';
import { UnroutedMessageError } from '../errors';
import { logger } from '../logger';
import { TopicMatcherService } from '../telemetry/topic-matcher.service';

export type MessageHandler = (topic: string, payload: Buffer) => void | Promise<void>;

interface Subscription {
  filter: string;
  handler: MessageHandler;
}

export interface PublishOptions {
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

/**
 * Thin wrapper over mqtt.js that dispatches incoming messages to per-filter
 * handlers using the same matching rules as the broker, and tracks in-flight
 * handlers so that `close()` can drain them before the connection goes away.
 */
@Injectable()
export class MqttClientService {
  private client: MqttClient | null = null;
  private readonly subscriptions: Subscription[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private handled = 0;
  private failed = 0;

  constructor(private readonly matcher: TopicMatcherService) {}

  async connect(port: number, host = '127.0.0.1', clientId = `telemetry-hub-${process.pid}`): Promise<void> {
    if (this.client) return;
    const client = await connectAsync(`mqtt://${host}:${port}`, {
      clientId,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 5_000,
    });
    client.on('message', (topic, payload) => this.dispatch(topic, payload));
    client.on('error', (err) => logger.error('mqtt client error', { clientId }, err));
    this.client = client;
    logger.info('mqtt client connected', { port, clientId });
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  get stats(): { handled: number; failed: number; inFlight: number } {
    return { handled: this.handled, failed: this.failed, inFlight: this.inFlight.size };
  }

  get filters(): string[] {
    return this.subscriptions.map((s) => s.filter);
  }

  async subscribe(filter: string, handler: MessageHandler): Promise<void> {
    this.matcher.validateFilter(filter);
    this.subscriptions.push({ filter, handler });
    await this.requireClient().subscribeAsync(filter, { qos: 1 });
  }

  async publish(topic: string, payload: Buffer | string | object, opts: PublishOptions = {}): Promise<void> {
    const body = Buffer.isBuffer(payload) || typeof payload === 'string' ? payload : JSON.stringify(payload);
    await this.requireClient().publishAsync(topic, body, { qos: opts.qos ?? 0, retain: opts.retain ?? false });
  }

  /** Resolve once every handler started so far has settled. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await this.drain();
    this.client = null;
    this.subscriptions.length = 0;
    await client.endAsync();
    logger.info('mqtt client closed');
  }

  private dispatch(topic: string, payload: Buffer): void {
    const task = this.run(topic, payload).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async run(topic: string, payload: Buffer): Promise<void> {
    try {
      const targets = this.subscriptions.filter((s) => this.matcher.matches(s.filter, topic));
      if (targets.length === 0) throw new UnroutedMessageError(topic, this.filters);
      // Every matching handler runs, like broker fan-out; one failing does not starve the others.
      const results = await Promise.allSettled(targets.map((t) => t.handler(topic, payload)));
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected) throw rejected.reason;
      this.handled += 1;
    } catch (err) {
      this.failed += 1;
      logger.error('message handling failed', { topic, bytes: payload.length }, err);
    }
  }

  private requireClient(): MqttClient {
    if (!this.client) throw new Error('mqtt client is not connected');
    return this.client;
  }
}
