// Air-quality sensor firmware adds a CO2 metric and, unlike the other
// metrics, publishes it without a "unit" field.
import { bootHub, run, waitFor } from '../_shared/harness';

run(async () => {
  const hub = await bootHub();
  try {
    await hub.publish('devices/air-3/telemetry', { metric: 'temperature', value: 21.4, unit: 'C' });
    await hub.publish('devices/air-3/telemetry', { metric: 'co2', value: 812 });
    await waitFor(() => hub.client.stats.handled + hub.client.stats.failed >= 2, 5000, 'both messages');
  } finally {
    await hub.shutdown();
  }
});
