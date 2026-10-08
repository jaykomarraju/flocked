// Queue consumer entry point (spec "Architecture": settle, decrypt-daily, decrypt-rooms, cards,
// notify). `queue()` maps the physical queue name to its logical name, validates every message
// with the shared schema, and hands valid bodies to that queue's handler:
//   * handler resolves  → ack;
//   * handler throws    → retry (wrangler.jsonc max_retries, then the queue's DLQ);
//   * invalid message   → logged and acked: retrying a malformed body can never succeed.
// Handlers are stubs until their owners replace them: settle and decrypt (W5-A), cards (W10-A),
// notify (W9-A). Each owner edits only its entry in HANDLERS.
import {
  QUEUE_NAMES,
  QueueMessageSchemas,
  type QueueMessage,
  type QueueName,
} from '@flocked/shared';
import type { Env } from '../env.js';
import { NotImplementedError } from '../lib/errors.js';
import { log } from '../lib/log.js';

/** Staging queues carry this suffix (wrangler.jsonc env.staging); local and production do not. */
const ENV_SUFFIXES = ['-staging'] as const;

/** The logical queue for a physical queue name, or null for a queue this Worker doesn't consume. */
export function logicalQueue(name: string): QueueName | null {
  let base = name;
  for (const suffix of ENV_SUFFIXES) {
    if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  }
  return (QUEUE_NAMES as readonly string[]).includes(base) ? (base as QueueName) : null;
}

export type QueueHandler<Q extends QueueName> = (
  body: QueueMessage<Q>,
  message: Message<unknown>,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>;

type Handlers = { [Q in QueueName]: QueueHandler<Q> };

const stub =
  (queue: QueueName): QueueHandler<QueueName> =>
  () =>
    Promise.reject(new NotImplementedError(`queue ${queue}`));

/** One handler per logical queue. */
export const HANDLERS: Handlers = {
  settle: stub('settle'),
  'decrypt-daily': stub('decrypt-daily'),
  'decrypt-rooms': stub('decrypt-rooms'),
  cards: stub('cards'),
  notify: stub('notify'),
};

/** Runs one message through its schema and handler, then acks or retries it. */
async function handleMessage<Q extends QueueName>(
  queue: Q,
  message: Message<unknown>,
  env: Env,
  ctx: ExecutionContext,
  handlers: Handlers,
): Promise<void> {
  const parsed = QueueMessageSchemas[queue].safeParse(message.body);
  if (!parsed.success) {
    log.error('queue_message_invalid', {
      queue,
      messageId: message.id,
      attempts: message.attempts,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    message.ack();
    return;
  }
  try {
    await (handlers[queue] as QueueHandler<Q>)(parsed.data as QueueMessage<Q>, message, env, ctx);
    message.ack();
  } catch (err) {
    log.warn('queue_message_retry', {
      queue,
      messageId: message.id,
      attempts: message.attempts,
      error: err instanceof Error ? err.message : String(err),
    });
    message.retry();
  }
}

/** The Worker's `queue` export. */
export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  handlers: Handlers = HANDLERS,
): Promise<void> {
  const name = logicalQueue(batch.queue);
  if (!name) {
    log.error('queue_unknown', { queue: batch.queue, messages: batch.messages.length });
    batch.retryAll();
    return;
  }
  // Messages in a batch are independent; acks and retries are per message.
  for (const message of batch.messages) {
    await handleMessage(name, message, env, ctx, handlers);
  }
}
