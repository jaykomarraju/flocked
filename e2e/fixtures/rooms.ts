// Room helpers (W8-D): create and join rooms through the API, read a room and its rounds' bundle
// objects as a member, and backdate an account through the seam. The room minimum counts only
// accounts created at least 24 hours before the room round's close, and every stack account is new.
import {
  CreateRoomResponseSchema,
  JoinRoomResponseSchema,
  RoomDetailResponseSchema,
  RoundVerifyResponseSchema,
  type Room,
  type RoomDetailResponse,
  type RoomQuestionSource,
  type RoundVerifyResponse,
} from '@flocked/shared';
import { http, type HttpResult } from './http';
import type { Stack } from './stack';
import { auth, type User } from './user';

/** A bundle chunk entry as docs/bundle-format.md writes it (the fields the specs read). */
export interface BundleEntry {
  seq: number;
  account: string;
  stake: string;
  option: 0 | 1 | null;
  valid: boolean;
  /** Room rounds only: counts toward the room minimum. */
  qualifies?: boolean;
}

function ok<T>(what: string, res: HttpResult, status = 200): T {
  if (res.status !== status) {
    throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

/** `POST /rooms` as `owner` (a custom room by default); the owner gets the joining room points. */
export async function createRoom(
  stack: Stack,
  owner: User,
  opts: { name?: string; questionSource?: RoomQuestionSource } = {},
): Promise<Room> {
  const res = await stack.api('/rooms', {
    ...auth(owner),
    body: { name: opts.name ?? 'Flock', questionSource: opts.questionSource ?? 'custom' },
  });
  return CreateRoomResponseSchema.parse(ok('POST /rooms', res, 201)).room;
}

/** `POST /rooms/join` with the invite code (joining twice returns the room, so it is retried). */
export async function joinRoom(stack: Stack, user: User, inviteCode: string): Promise<Room> {
  const res = await stack.api('/rooms/join', {
    ...auth(user),
    body: { inviteCode },
    idempotent: true,
  });
  return JoinRoomResponseSchema.parse(ok('POST /rooms/join', res)).room;
}

/** `GET /rooms/:id`, answered as it is; anonymous without `user`. */
export function getRoom(stack: Stack, roomId: string, user?: User): Promise<HttpResult> {
  return stack.api(`/rooms/${roomId}`, user ? auth(user) : {});
}

/** `GET /rooms/:id` as a member (which credits the room grant while a room round is open). */
export async function roomDetail(
  stack: Stack,
  roomId: string,
  user: User,
): Promise<RoomDetailResponse> {
  return RoomDetailResponseSchema.parse(
    ok(`GET /rooms/${roomId}`, await getRoom(stack, roomId, user)),
  );
}

/** Sets the account's `created_at` to `ageMs` ago (`POST /__test/users/age`). */
export async function backdate(stack: Stack, user: User, ageMs: number): Promise<void> {
  const createdAt = Date.now() - ageMs;
  ok(
    'POST /__test/users/age',
    await stack.seam('/users/age', { userId: user.userId, createdAt }, { idempotent: true }),
  );
}

/** `GET /rounds/:id/verify` as `user` (a member, for a room round). */
export async function verifyRound(
  stack: Stack,
  roundId: string,
  user: User,
): Promise<RoundVerifyResponse> {
  return RoundVerifyResponseSchema.parse(
    ok(`GET /rounds/${roundId}/verify`, await stack.api(`/rounds/${roundId}/verify`, auth(user))),
  );
}

/** A bundle object at a URL `/verify` lists (relative to the API origin), answered as it is. */
export function bundleObject(stack: Stack, url: string, user?: User): Promise<HttpResult> {
  return http(new URL(url, stack.apiUrl).href, user ? auth(user) : {});
}

/** Every entry of the mode's bundle, in seq order, read through the chunk URLs `/verify` lists. */
export async function bundleEntries(
  stack: Stack,
  roundId: string,
  mode: 'free' | 'stakes',
  user: User,
): Promise<BundleEntry[]> {
  const bundle = (await verifyRound(stack, roundId, user)).modes[mode];
  if (!bundle) throw new Error(`round ${roundId} has no ${mode} bundle`);
  const entries: BundleEntry[] = [];
  for (const url of bundle.chunkUrls) {
    const chunk = ok<{ entries: BundleEntry[] }>(url, await bundleObject(stack, url, user));
    entries.push(...chunk.entries);
  }
  return entries;
}
