// Broker liveness: the hub tracks the broker's $SYS heartbeat. Nothing else
// happens; a quiet hub should simply see a beat and shut down cleanly.
import { bootHub, run, waitFor } from '../_shared/harness';

run(async () => {
  const hub = await bootHub({ broker: { heartbeatIntervalMs: 200 } });
  try {
    await waitFor(
      () => hub.ingest.snapshot().brokerLastBeat !== null || hub.client.stats.failed > 0,
      5000,
      'broker heartbeat',
    );
  } finally {
    await hub.shutdown();
  }
});
