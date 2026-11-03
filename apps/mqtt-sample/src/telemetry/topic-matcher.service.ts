import { Injectable } from '@nestjs/common';
import { InvalidTopicFilterError } from '../errors';

function escapeRegExp(level: string): string {
  return level.replace(/[.*?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MQTT 3.1.1 topic-filter matching (section 4.7).
 *
 *  - `+` matches exactly one level (which may be empty: `a/+/c` matches `a//c`).
 *  - `#` matches the parent level and any number of child levels, and must be
 *    the last character of the filter.
 *  - Topics beginning with `$` (e.g. `$SYS/...`) are never matched by a filter
 *    whose first level is a wildcard, but `$SYS/#` and `$SYS/+/x` do match.
 */
@Injectable()
export class TopicMatcherService {
  private readonly cache = new Map<string, RegExp>();

  matches(filter: string, topic: string): boolean {
    if (topic.startsWith('$') && (filter.startsWith('#') || filter.startsWith('+'))) {
      return false;
    }
    return this.compile(filter).test(topic);
  }

  /** Values captured by the wildcards of `filter`, in order. `#` captures the remainder. */
  captures(filter: string, topic: string): string[] | null {
    if (!this.matches(filter, topic)) return null;
    const m = this.compile(filter).exec(topic);
    if (!m) return null;
    return m.slice(1).map((v) => v ?? '');
  }

  validateFilter(filter: string): void {
    if (filter.length === 0) throw new InvalidTopicFilterError('topic filter must not be empty');
    if (filter.includes('\u0000')) throw new InvalidTopicFilterError('topic filter must not contain NUL');
    const levels = filter.split('/');
    levels.forEach((level, i) => {
      if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) {
        throw new InvalidTopicFilterError(`"${filter}": "#" must occupy the entire last level`);
      }
      if (level.includes('+') && level !== '+') {
        throw new InvalidTopicFilterError(`"${filter}": "+" must occupy an entire level`);
      }
    });
  }

  private compile(filter: string): RegExp {
    const cached = this.cache.get(filter);
    if (cached) return cached;
    this.validateFilter(filter);

    const levels = filter.split('/');
    const hasHash = levels[levels.length - 1] === '#';
    const body = (hasHash ? levels.slice(0, -1) : levels)
      .map((level) => (level === '+' ? '([^/]*)' : escapeRegExp(level)))
      .join('/');

    let source: string;
    if (hasHash) {
      source = body.length === 0 ? '(.*)' : `${body}(?:/(.*))?`;
    } else {
      source = body;
    }
    const re = new RegExp(`^${source}$`);
    this.cache.set(filter, re);
    return re;
  }
}
