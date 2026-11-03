// Cold start in production: the inventory service answers in ~150 ms, and the
// first device message arrives as soon as the hub has subscribed.
import { bootHub, run, sleep, waitFor } from '../_shared/harness';

const inventory = {
  async load() {
    await sleep(150); // inventory service round-trip
    return [
      { id: 'pump-1', model: 'P-100' },
      { id: 'pump-2', model: 'P-100' },
    ];
  },
};

run(async () => {
  const hub = await bootHub({ seed: inventory });
  try {
    await hub.publish('devices/pump-1/telemetry', { metric: 'pressure', value: 979.8, unit: 'hPa' });
    await waitFor(() => hub.client.stats.handled + hub.client.stats.failed >= 1, 5000, 'first message');
  } finally {
    await hub.shutdown();
  }
});
