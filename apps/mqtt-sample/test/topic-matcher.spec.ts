import { InvalidTopicFilterError } from '../src/errors';
import { TopicMatcherService } from '../src/telemetry/topic-matcher.service';

describe('TopicMatcherService', () => {
  let matcher: TopicMatcherService;

  beforeEach(() => {
    matcher = new TopicMatcherService();
  });

  describe('exact filters', () => {
    it('matches only an identical topic (case sensitive, no prefix matching)', () => {
      expect(matcher.matches('devices/d1/telemetry', 'devices/d1/telemetry')).toBe(true);
      expect(matcher.matches('devices/d1/telemetry', 'devices/d2/telemetry')).toBe(false);
      expect(matcher.matches('devices/d1', 'devices/d1/telemetry')).toBe(false);
      expect(matcher.matches('devices/d1/telemetry', 'devices/d1')).toBe(false);
      expect(matcher.matches('Devices/d1', 'devices/d1')).toBe(false);
    });

    it('treats regex metacharacters in topics literally', () => {
      expect(matcher.matches('sensors/temp.1', 'sensors/temp.1')).toBe(true);
      expect(matcher.matches('sensors/temp.1', 'sensors/tempX1')).toBe(false);
      expect(matcher.matches('a/(b)/c', 'a/(b)/c')).toBe(true);
    });
  });

  describe('single-level wildcard +', () => {
    it('matches one level anywhere in the filter, including an empty level', () => {
      expect(matcher.matches('devices/+/telemetry', 'devices/d1/telemetry')).toBe(true);
      expect(matcher.matches('+/d1/telemetry', 'devices/d1/telemetry')).toBe(true);
      expect(matcher.matches('devices/d1/+', 'devices/d1/telemetry')).toBe(true);
      expect(matcher.matches('devices/+/telemetry', 'devices//telemetry')).toBe(true);
    });

    it('still requires the literal levels to match and the level to exist', () => {
      expect(matcher.matches('devices/+/telemetry', 'devices/d1/status')).toBe(false);
      expect(matcher.matches('devices/+/telemetry', 'gateways/d1/telemetry')).toBe(false);
      expect(matcher.matches('devices/+', 'devices')).toBe(false);
    });
  });

  describe('multi-level wildcard #', () => {
    it('matches the parent and any depth of children', () => {
      expect(matcher.matches('devices/#', 'devices')).toBe(true);
      expect(matcher.matches('devices/#', 'devices/d1')).toBe(true);
      expect(matcher.matches('devices/#', 'devices/d1/telemetry/raw')).toBe(true);
      expect(matcher.matches('#', 'a')).toBe(true);
      expect(matcher.matches('#', 'a/b/c')).toBe(true);
      expect(matcher.matches('devices/+/#', 'devices/d1/telemetry/raw')).toBe(true);
      expect(matcher.matches('devices/+/#', 'devices/d1')).toBe(true);
    });

    it('does not match siblings of the parent', () => {
      expect(matcher.matches('devices/#', 'gateways/d1')).toBe(false);
      expect(matcher.matches('devices/#', 'devicesX')).toBe(false);
    });
  });

  describe('$SYS topics', () => {
    it('are hidden from leading-wildcard filters but visible to explicit $SYS filters', () => {
      expect(matcher.matches('#', '$SYS/broker/uptime')).toBe(false);
      expect(matcher.matches('+/broker/uptime', '$SYS/broker/uptime')).toBe(false);
      expect(matcher.matches('$SYS/broker/uptime', '$SYS/broker/uptime')).toBe(true);
    });
  });

  describe('captures', () => {
    it('returns the values matched by each wildcard, the remainder for #', () => {
      expect(matcher.captures('devices/+/telemetry', 'devices/d-42/telemetry')).toEqual(['d-42']);
      expect(matcher.captures('devices/+/+', 'devices/d1/status')).toEqual(['d1', 'status']);
      expect(matcher.captures('devices/#', 'devices/d1/telemetry/raw')).toEqual(['d1/telemetry/raw']);
      expect(matcher.captures('devices/#', 'devices')).toEqual(['']);
    });

    it('returns null when the topic does not match', () => {
      expect(matcher.captures('devices/+/telemetry', 'devices/d1/status')).toBeNull();
    });
  });

  describe('validateFilter', () => {
    it('rejects misplaced wildcards and empty filters', () => {
      expect(() => matcher.validateFilter('devices/#/telemetry')).toThrow(InvalidTopicFilterError);
      expect(() => matcher.validateFilter('devices/d#')).toThrow(InvalidTopicFilterError);
      expect(() => matcher.validateFilter('devices/d+/telemetry')).toThrow(InvalidTopicFilterError);
      expect(() => matcher.validateFilter('')).toThrow(InvalidTopicFilterError);
    });

    it('accepts well-formed filters', () => {
      for (const f of ['#', '+', 'a/+/c', 'a/#', '+/+/#', '$SYS/+/heartbeat']) {
        expect(() => matcher.validateFilter(f)).not.toThrow();
      }
    });
  });
});
