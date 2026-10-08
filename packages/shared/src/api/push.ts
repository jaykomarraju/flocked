// Web push (route module `push`). Spec: "API", "Notifications", "Data model"
// (`push_subscriptions`).

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
