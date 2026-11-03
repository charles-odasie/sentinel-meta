// Early-morning condensation in a greenhouse: the humidity sensor saturates
// and reports exactly 100 %, which is a legitimate reading.
import { bootHub, run, waitFor } from '../_shared/harness';

run(async () => {
  const hub = await bootHub();
  try {
    await hub.publish('devices/greenhouse-4/telemetry', [
      { metric: 'humidity', value: 100, unit: '%' },
      { metric: 'temperature', value: 14.8, unit: 'C' },
    ]);
    await waitFor(() => hub.client.stats.handled + hub.client.stats.failed >= 1, 5000, 'message');
  } finally {
    await hub.shutdown();
  }
});
