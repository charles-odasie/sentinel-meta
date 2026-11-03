// Registry is seeded from the inventory service at boot; two of the three
// provisioned devices have not been installed yet. The nightly offline sweep
// then runs.
import { logger } from '../../../apps/mqtt-sample/src/logger';
import { bootHub, job, run, waitFor } from '../_shared/harness';

const inventory = {
  async load() {
    return [
      { id: 'pump-1', model: 'P-100' },
      { id: 'pump-2', model: 'P-100' },
      { id: 'valve-9', model: 'V-20' },
    ];
  },
};

run(async () => {
  const hub = await bootHub({ seed: inventory });
  try {
    await hub.publish('devices/pump-1/telemetry', { metric: 'pressure', value: 981.5, unit: 'hPa' });
    await waitFor(() => hub.ingest.snapshot().readings >= 1, 5000, 'first reading');

    await job('offline-sweep', async () => {
      const offline = await hub.ingest.sweepOffline(60_000);
      logger.info('offline sweep complete', { offline, devices: hub.registry.size });
    });
  } finally {
    await hub.shutdown();
  }
});
