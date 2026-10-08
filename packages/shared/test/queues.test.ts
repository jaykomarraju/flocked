import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { NOTIFICATION_EVENTS } from '../src/enums';
import {
  DecryptMessageSchema,
  NotifyMessageSchema,
  QUEUE_NAMES,
  QueueMessageSchemas,
} from '../src/queues';
import type { QueueName } from '../src/queues';

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/queues/${name}`, import.meta.url), 'utf8')) as T;

const valid = read<Record<QueueName, unknown[]>>('valid.json');
const invalid = read<Record<QueueName, { why: string; value: unknown }[]>>('invalid.json');

describe('queue messages', () => {
  it('pins the queue names and maps each to a schema', () => {
    expect(QUEUE_NAMES).toEqual(['settle', 'decrypt-daily', 'decrypt-rooms', 'cards', 'notify']);
    expect(Object.keys(QueueMessageSchemas)).toEqual([...QUEUE_NAMES]);
    expect(QueueMessageSchemas['decrypt-daily']).toBe(DecryptMessageSchema);
    expect(QueueMessageSchemas['decrypt-rooms']).toBe(DecryptMessageSchema);
  });

  it('has valid and invalid fixtures for every queue', () => {
    expect(Object.keys(valid).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(Object.keys(invalid).sort()).toEqual([...QUEUE_NAMES].sort());
  });

  it('covers every notification event', () => {
    const events = valid.notify.map((m) => NotifyMessageSchema.parse(m).event);
    expect([...new Set(events)].sort()).toEqual([...NOTIFICATION_EVENTS].sort());
  });

  for (const queue of QUEUE_NAMES) {
    describe(queue, () => {
      it('accepts and round-trips its valid fixtures', () => {
        for (const message of valid[queue]) {
          const parsed = QueueMessageSchemas[queue].parse(message);
          expect(JSON.parse(JSON.stringify(parsed))).toEqual(message);
        }
      });
      for (const c of invalid[queue]) {
        it(`rejects: ${c.why}`, () => {
          expect(QueueMessageSchemas[queue].safeParse(c.value).success).toBe(false);
        });
      }
    });
  }
});
