// API fixtures for component tests: the shared package's valid examples (packages/shared/test/
// fixtures/api), which its own tests check against the schemas, so they can't drift.
import { MeResponseSchema, type MeResponse } from '@flocked/shared';
import meFixtures from '../../../../packages/shared/test/fixtures/api/me.json';

/** A signed-in user's `GET /me` (handle `woolly`). */
export const ME: MeResponse = MeResponseSchema.parse(meFixtures.valid.MeResponseSchema[0]);

/** A session response for ME's user. */
export const SESSION = {
  user: {
    id: ME.user.id,
    handle: ME.user.handle,
    displayName: ME.user.displayName,
    avatarUrl: ME.user.avatarUrl,
    role: ME.user.role,
  },
  created: false,
  token: null as string | null,
  expiresAt: 1_791_468_191_250,
};

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
