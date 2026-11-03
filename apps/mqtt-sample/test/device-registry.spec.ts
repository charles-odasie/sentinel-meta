import { InvalidDeviceIdError, RegistryNotReadyError } from '../src/errors';
import { DeviceRegistryService } from '../src/telemetry/device-registry.service';
import { DeviceSeedProvider } from '../src/telemetry/reading';

const T0 = new Date('2026-03-01T10:00:00Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

describe('DeviceRegistryService', () => {
  let registry: DeviceRegistryService;

  beforeEach(() => {
    registry = new DeviceRegistryService();
  });

  describe('registration and ids', () => {
    it('is ready immediately without a seed provider and registers a device once', () => {
      expect(registry.isReady).toBe(true);
      registry.register('d1', 'thermo-v2');
      registry.register('d1');
      expect(registry.size).toBe(1);
      expect(registry.get('d1')?.model).toBe('thermo-v2');
      expect(registry.get('d1')?.status).toBe('unknown');
    });

    it('rejects malformed device ids', () => {
      expect(() => registry.register('')).toThrow(InvalidDeviceIdError);
      expect(() => registry.register('has space')).toThrow(InvalidDeviceIdError);
      expect(() => registry.register('a/b')).toThrow(InvalidDeviceIdError);
      expect(() => registry.register('x'.repeat(65))).toThrow(InvalidDeviceIdError);
    });

    it('lists devices sorted by id', () => {
      registry.register('zeta');
      registry.register('alpha');
      expect(registry.list().map((d) => d.id)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('last-seen tracking', () => {
    it('auto-registers on touch, advances lastSeen and keeps the earliest firstSeen', () => {
      const rec = registry.touch('d1', at(1000));
      expect(rec.status).toBe('online');
      registry.touch('d1', at(5000));
      registry.touch('d1', at(3000)); // late-arriving sample
      expect(registry.get('d1')).toMatchObject({ firstSeen: at(1000), lastSeen: at(5000) });
    });

    it('setStatus(online) counts as activity, setStatus(offline) does not', () => {
      registry.setStatus('d1', 'online', at(0));
      expect(registry.get('d1')?.lastSeen).toEqual(at(0));
      registry.setStatus('d1', 'offline', at(9000));
      expect(registry.get('d1')?.lastSeen).toEqual(at(0));
      expect(registry.get('d1')?.status).toBe('offline');
    });
  });

  describe('offline detection', () => {
    it('reports devices silent for longer than the threshold (exclusive at the edge)', () => {
      registry.touch('fresh', at(0));
      registry.touch('stale', at(-120_000));
      registry.touch('edge', at(-60_000));
      expect(registry.offlineDevices(60_000, at(0)).map((d) => d.id)).toEqual(['stale']);
      expect(registry.offlineDevices(59_999, at(0)).map((d) => d.id).sort()).toEqual(['edge', 'stale']);
    });

    it('sweep marks stale devices offline once and returns their ids', () => {
      registry.touch('a', at(-100_000));
      registry.touch('b', at(-100_000));
      registry.touch('c', at(0));
      expect(registry.sweep(30_000, at(0)).sort()).toEqual(['a', 'b']);
      expect(registry.get('a')?.status).toBe('offline');
      expect(registry.sweep(30_000, at(0))).toEqual([]);
    });

    it('a swept device comes back online when it reports again', () => {
      registry.touch('a', at(-100_000));
      registry.sweep(30_000, at(0));
      registry.touch('a', at(1000));
      expect(registry.get('a')?.status).toBe('online');
    });
  });

  describe('seed loading', () => {
    const seed: DeviceSeedProvider = {
      load: async () => [
        { id: 'seed-1', model: 'gw' },
        { id: 'seed-2' },
      ],
    };

    it('is not ready until load() resolves', async () => {
      const r = new DeviceRegistryService(seed);
      expect(r.isReady).toBe(false);
      expect(() => r.register('x')).toThrow(RegistryNotReadyError);
      await expect(r.load()).resolves.toBe(2);
      expect(r.isReady).toBe(true);
    });

    it('seeds devices as unknown until they report', async () => {
      const r = new DeviceRegistryService(seed);
      await r.load();
      expect(r.list().map((d) => d.id)).toEqual(['seed-1', 'seed-2']);
      expect(r.get('seed-1')).toMatchObject({ model: 'gw', status: 'unknown', firstSeen: null, lastSeen: null });
      r.touch('seed-2', at(0));
      expect(r.get('seed-2')?.status).toBe('online');
      expect(r.size).toBe(2);
    });
  });
});
