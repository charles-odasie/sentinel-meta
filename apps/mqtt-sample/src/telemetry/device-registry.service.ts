import { Inject, Injectable, Optional } from '@nestjs/common';
import { InvalidDeviceIdError, RegistryNotReadyError } from '../errors';
import { DEVICE_SEED_PROVIDER, DeviceRecord, DeviceSeedProvider, DeviceStatus } from './reading';

const DEVICE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * In-memory device registry with last-seen tracking and offline detection.
 *
 * When a seed provider is configured the registry must be `load()`ed before
 * use; without one it is ready immediately.
 */
@Injectable()
export class DeviceRegistryService {
  private readonly devices = new Map<string, DeviceRecord>();
  private ready: boolean;

  constructor(@Optional() @Inject(DEVICE_SEED_PROVIDER) private readonly seed?: DeviceSeedProvider) {
    this.ready = !seed;
  }

  async load(): Promise<number> {
    if (!this.seed) {
      this.ready = true;
      return 0;
    }
    const seeds = await this.seed.load();
    for (const s of seeds) {
      this.assertValidId(s.id);
      if (!this.devices.has(s.id)) {
        this.devices.set(s.id, { id: s.id, model: s.model, firstSeen: null, lastSeen: null, status: 'unknown' });
      }
    }
    this.ready = true;
    return seeds.length;
  }

  get isReady(): boolean {
    return this.ready;
  }

  register(id: string, model?: string): DeviceRecord {
    this.assertReady();
    this.assertValidId(id);
    let rec = this.devices.get(id);
    if (!rec) {
      rec = { id, model, firstSeen: null, lastSeen: null, status: 'unknown' };
      this.devices.set(id, rec);
    } else if (model !== undefined) {
      rec.model = model;
    }
    return rec;
  }

  /** Record activity from a device; unknown devices are auto-registered. */
  touch(id: string, ts: Date = new Date()): DeviceRecord {
    const rec = this.register(id);
    if (rec.firstSeen === null || ts < rec.firstSeen) rec.firstSeen = ts;
    if (rec.lastSeen === null || ts > rec.lastSeen) rec.lastSeen = ts;
    rec.status = 'online';
    return rec;
  }

  setStatus(id: string, status: DeviceStatus, ts: Date = new Date()): DeviceRecord {
    const rec = this.register(id);
    rec.status = status;
    if (status === 'online') {
      if (rec.firstSeen === null) rec.firstSeen = ts;
      if (rec.lastSeen === null || ts > rec.lastSeen) rec.lastSeen = ts;
    }
    return rec;
  }

  get(id: string): DeviceRecord | undefined {
    this.assertReady();
    return this.devices.get(id);
  }

  list(): DeviceRecord[] {
    this.assertReady();
    return [...this.devices.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.devices.size;
  }

  /**
   * Devices whose last activity is older than `thresholdMs`.
   * Devices that have never reported are "unknown", not offline.
   */
  offlineDevices(thresholdMs: number, now: Date = new Date()): DeviceRecord[] {
    this.assertReady();
    const out: DeviceRecord[] = [];
    for (const d of this.devices.values()) {
      if (d.status === 'offline' || !d.lastSeen) continue;
      if (now.getTime() - d.lastSeen.getTime() > thresholdMs) out.push(d);
    }
    return out;
  }

  /** Mark stale devices offline; returns the ids that transitioned. */
  sweep(thresholdMs: number, now: Date = new Date()): string[] {
    const stale = this.offlineDevices(thresholdMs, now);
    for (const d of stale) d.status = 'offline';
    return stale.map((d) => d.id);
  }

  private assertReady(): void {
    if (!this.ready) throw new RegistryNotReadyError();
  }

  private assertValidId(id: unknown): void {
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) throw new InvalidDeviceIdError(id);
  }
}
