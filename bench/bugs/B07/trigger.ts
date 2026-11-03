// A freshly installed pump has sent a handful of readings when the periodic
// metrics report runs.
import { logger } from '../../../apps/mqtt-sample/src/logger';
import { bootHub, job, run, waitFor } from '../_shared/harness';

run(async () => {
  const hub = await bootHub();
  try {
    for (const value of [980.1, 982.4, 979.6]) {
      await hub.publish('devices/pump-2/telemetry', { metric: 'pressure', value, unit: 'hPa' });
    }
    await waitFor(() => hub.ingest.snapshot().readings >= 3, 5000, 'three readings');

    await job('metrics-report', () => {
      const rows = hub.ingest.summary();
      logger.info('metrics report', { rows: rows.length, devices: hub.registry.size });
    });
  } finally {
    await hub.shutdown();
  }
});
