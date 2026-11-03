// A gateway reports its own battery and relays a reading from one of its
// leaf nodes on the children topic.
import { bootHub, run, waitFor } from '../_shared/harness';

run(async () => {
  const hub = await bootHub();
  try {
    await hub.publish('devices/gw-1/telemetry', { metric: 'battery', value: 77, unit: '%' });
    await hub.publish('devices/gw-1/children/node-7/telemetry', { metric: 'temperature', value: 19.2, unit: 'C' });
    await waitFor(() => hub.client.stats.handled + hub.client.stats.failed >= 2, 5000, 'both messages');
  } finally {
    await hub.shutdown();
  }
});
