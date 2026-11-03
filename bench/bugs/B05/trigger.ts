// Rolling deploy: SIGTERM arrives while a telemetry message is still being
// processed (the snapshot store write takes ~40 ms). The handler goes on to
// raise an alert after the hub has started its graceful shutdown.
import { logger } from '../../../apps/mqtt-sample/src/logger';
import { bootHub, run, sleep, waitFor } from '../_shared/harness';

const snapshotStore = {
  async put() {
    await sleep(40); // remote cache round-trip
  },
};

run(async () => {
  const hub = await bootHub({ store: snapshotStore });
  try {
    await hub.publish('devices/boiler-2/telemetry', { metric: 'temperature', value: 96, unit: 'C' });
    await waitFor(() => hub.client.stats.inFlight > 0, 5000, 'message in flight');

    logger.info('SIGTERM received, shutting down', { inFlight: hub.client.stats.inFlight });
    await hub.ingest.stop();
    await sleep(150); // give the in-flight handler time to finish
  } finally {
    await hub.shutdown();
  }
});
