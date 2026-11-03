# telemetry-hub

A small, realistic NestJS + MQTT IoT telemetry hub, written as the benchmark
target for the **Sentinel** hackathon project (MIT). Everything runs
in-process: an [aedes](https://github.com/moscajs/aedes) broker is started on
an ephemeral TCP port and an [mqtt.js](https://github.com/mqttjs/MQTT.js)
client connects to it. No Docker, no external broker.

## What it does

Devices publish JSON to `devices/{deviceId}/telemetry` (single reading, array,
or `{ "readings": [...] }`) and `devices/{deviceId}/status`. The hub:

| Service                  | Responsibility                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `TopicMatcherService`    | MQTT 3.1.1 filter matching (`+`, `#`, `$SYS` rules), wildcard captures    |
| `TelemetryParserService` | Payload -> `Reading`, range validation, unit normalisation, batches        |
| `DeviceRegistryService`  | In-memory registry, last-seen tracking, offline detection, seed loading   |
| `AlertRuleService`       | `gt` / `lt` / `between` rules with hysteresis and debounce                 |
| `RetainedStateService`   | Last-known value per device/metric + sliding-window avg/min/max/p95        |
| `IngestService`          | Subscribes, wires parser -> registry -> rules -> state, publishes alerts   |
| `MqttBrokerService`      | In-process aedes broker                                                    |
| `MqttClientService`      | mqtt.js wrapper with per-filter handler dispatch and in-flight draining    |

Alerts are published to `alerts/{deviceId}`.

## Running

```bash
npm ci
npm test                                   # full Jest suite (~60 tests, in-process broker)
npm run test:file -- test/alert-rule.spec.ts   # a single spec file
npx jest test/telemetry-parser.spec.ts         # equivalent
npm run typecheck
npx tsx src/main.ts                        # start the hub standalone (MQTT_PORT=1883 to pin a port)
```

The suite runs with `--detectOpenHandles` and without `--forceExit`; the
broker and client are started in `beforeAll` and torn down in `afterAll`.

Set `LOG_LEVEL=debug` to see the structured JSON service logs during tests.
