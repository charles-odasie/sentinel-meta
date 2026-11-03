/** Base class so callers can distinguish domain errors from programming errors. */
export class TelemetryHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Payload or topic rejected by the parser. */
export class TelemetryValidationError extends TelemetryHubError {
  constructor(message: string, public readonly topic?: string) {
    super(message);
  }
}

/** Topic filter that violates the MQTT 3.1.1 filter grammar. */
export class InvalidTopicFilterError extends TelemetryHubError {}

/** A device id that does not satisfy the registry naming rules. */
export class InvalidDeviceIdError extends TelemetryHubError {
  constructor(deviceId: unknown) {
    super(`"${String(deviceId)}" is not a valid device id (expected [A-Za-z0-9_.-]{1,64})`);
  }
}

/** Registry used before its seed data finished loading. */
export class RegistryNotReadyError extends TelemetryHubError {
  constructor() {
    super('device registry accessed before load() completed');
  }
}

/** Rule definition rejected at registration time. */
export class InvalidRuleError extends TelemetryHubError {}

/**
 * The broker delivered a message that no local subscription handler claims.
 * This should be impossible: the broker only delivers topics we subscribed to,
 * so the local matcher must agree with the broker.
 */
export class UnroutedMessageError extends TelemetryHubError {
  constructor(public readonly topic: string, filters: string[]) {
    super(`broker delivered "${topic}" but no local subscription matches (subscribed: ${filters.join(', ')})`);
  }
}
