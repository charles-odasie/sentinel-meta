/** One normalised telemetry sample. */
export interface Reading {
  deviceId: string;
  metric: string;
  value: number;
  unit: string;
  ts: Date;
}

/** Device status as reported on `devices/{deviceId}/status`. */
export type DeviceStatus = 'online' | 'offline' | 'unknown';

export interface DeviceRecord {
  id: string;
  model?: string;
  firstSeen: Date | null;
  lastSeen: Date | null;
  status: DeviceStatus;
}

export interface DeviceSeed {
  id: string;
  model?: string;
}

/** Async source of pre-provisioned devices (inventory DB, config file, ...). */
export interface DeviceSeedProvider {
  load(): Promise<DeviceSeed[]>;
}

export const DEVICE_SEED_PROVIDER = Symbol('DEVICE_SEED_PROVIDER');

/** Optional async sink for last-known values (persistence, cache, ...). */
export interface SnapshotStore {
  put(key: string, reading: Reading): Promise<void>;
}

export const SNAPSHOT_STORE = Symbol('SNAPSHOT_STORE');

/** Optional override for the sliding-window length of RetainedStateService. */
export const WINDOW_SIZE = Symbol('WINDOW_SIZE');
