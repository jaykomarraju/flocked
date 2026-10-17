// Web push and the Farcaster mini app webhook (route module `push`). Spec: "API", "Notifications",
// "Data model" (`push_subscriptions`).

import { z } from 'zod';

import { Base64UrlSchema, HttpUrlSchema, UlidSchema } from '../wire';

/**
 * POST /push/subscribe: a browser `PushSubscription.toJSON()`. Re-subscribing the same endpoint
 * updates its keys.
 */
export const PushSubscribeRequestSchema = z.strictObject({
  endpoint: HttpUrlSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: Base64UrlSchema.min(1),
    auth: Base64UrlSchema.min(1),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

/** POST /push/subscribe response. */
export const PushSubscribeResponseSchema = z.object({ id: UlidSchema });
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponseSchema>;

/**
 * POST /farcaster/webhook: a mini app event as a JSON Farcaster Signature (base64url header, payload
 * and signature). No session: the signature, checked against the app key on a hub, authenticates it.
 */
export const FarcasterWebhookRequestSchema = z.object({
  header: z.string().min(1).max(4096),
  payload: z.string().min(1).max(4096),
  signature: z.string().min(1).max(256),
});
export type FarcasterWebhookRequest = z.infer<typeof FarcasterWebhookRequestSchema>;

/** POST /farcaster/webhook response: what happened to the user's notification token. */
export const FarcasterWebhookResponseSchema = z.object({
  ok: z.literal(true),
  result: z.enum(['stored', 'disabled', 'ignored']),
});
export type FarcasterWebhookResponse = z.infer<typeof FarcasterWebhookResponseSchema>;
