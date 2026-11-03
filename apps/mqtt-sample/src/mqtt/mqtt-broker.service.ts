import { Injectable } from '@nestjs/common';
import Aedes from 'aedes';
import { AddressInfo, createServer, Server } from 'node:net';
import { logger } from '../logger';

export interface BrokerOptions {
  /** 0 = ephemeral port (default). */
  port?: number;
  host?: string;
  /** How often the broker publishes `$SYS/{id}/heartbeat`. */
  heartbeatIntervalMs?: number;
  /** Broker id, used as the `$SYS/{id}/...` prefix. */
  id?: string;
}

export const DEFAULT_BROKER_ID = 'hub-broker';

/**
 * In-process MQTT broker (aedes over a plain TCP server). Used both by the
 * running service and by the test-suite so no external broker is required.
 */
@Injectable()
export class MqttBrokerService {
  private aedes: Aedes | null = null;
  private server: Server | null = null;
  private boundPort = 0;

  async start(opts: BrokerOptions = {}): Promise<number> {
    if (this.server) return this.boundPort;
    const aedes = new Aedes({ id: opts.id ?? DEFAULT_BROKER_ID, heartbeatInterval: opts.heartbeatIntervalMs ?? 60_000 });
    const server = createServer(aedes.handle);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.aedes = aedes;
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    logger.info('broker listening', { port: this.boundPort, brokerId: aedes.id });
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }

  get id(): string | undefined {
    return this.aedes?.id;
  }

  get connectedClients(): number {
    return this.aedes?.connectedClients ?? 0;
  }

  async stop(): Promise<void> {
    const { aedes, server } = this;
    this.aedes = null;
    this.server = null;
    if (aedes) await new Promise<void>((resolve) => aedes.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.boundPort = 0;
  }
}
