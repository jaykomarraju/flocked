// REST API schemas and the endpoint table. Plan P2.4. Spec: "API".

import type { z } from 'zod';

import { WsServerMessageSchema } from '../ws';
import { IdParamsSchema } from '../wire';
import * as admin from './admin';
import * as auth from './auth';
import * as boards from './boards';
import * as cards from './cards';
import * as claims from './claims';
import * as entries from './entries';
import * as limits from './limits';
import * as me from './me';
import * as push from './push';
import * as questions from './questions';
import * as rooms from './rooms';
import * as rounds from './rounds';

export * from './admin';
export * from './auth';
export * from './boards';
export * from './cards';
export * from './claims';
export * from './entries';
export * from './errors';
export * from './limits';
export * from './me';
export * from './push';
export * from './questions';
export * from './rooms';
export * from './rounds';

/** Every path below is relative to this base (spec "API": "a JSON REST API under /api/v1"). */
export const API_BASE_PATH = '/api/v1';

/** Route modules: one Hono sub-app each in `apps/api/src/routes/` (plan P2.4). */
export const ROUTE_MODULES = [
  'auth',
  'me',
  'rounds',
  'entries',
  'stakes',
  'claims',
  'questions',
  'boards',
  'users',
  'rooms',
  'cards',
  'push',
  'limits',
  'admin',
  'paymaster',
] as const;
export type RouteModule = (typeof ROUTE_MODULES)[number];

/**
 * One endpoint. `auth` maps the spec's Auth column: `none`; `user`; `admin`; `state` (the
 * personhood callback, authenticated by its OAuth state) → `none`; `user or wallet` → `optional`;
 * `member` and `owner` → `user` (the handler checks membership or ownership). `optional` also
 * marks public reads that personalise when a session is present.
 */
export interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Hono syntax, e.g. '/rounds/:id'. */
  path: string;
  module: RouteModule;
  auth: 'none' | 'optional' | 'user' | 'admin';
  /** The JSON body schema, or null when the endpoint takes no body. */
  request: z.ZodType | null;
  /** The success body (JSON unless `responseType` says otherwise). */
  response: z.ZodType;
  /** Path parameters (additive to the pinned shape). */
  params?: z.ZodType;
  /** Query parameters (additive to the pinned shape). */
  query?: z.ZodType;
  /**
   * What the route answers with (additive): `json` (default), `html`, `png`, or `websocket`
   * (an upgrade; `response` is then the server-to-client message schema).
   */
  responseType?: 'json' | 'html' | 'png' | 'websocket';
}

const PNG_VARIANT = ':variant{(?:og|embed|square)\\.png}';

/**
 * Every endpoint, in the order of the spec's API table. The table's `* /admin/*` row ("See Admin
 * console") is expanded into the drafted admin endpoints right after `POST /admin/users/:id/role`.
 * `POST /paymaster` comes last, as in the table (after `* /admin/*`).
 */
// prettier-ignore
export const ENDPOINTS: readonly EndpointDef[] = [
  // auth
  { method: 'POST', path: '/auth/siwe/nonce', module: 'auth', auth: 'none', request: null, response: auth.SiweNonceResponseSchema },
  { method: 'POST', path: '/auth/siwe/verify', module: 'auth', auth: 'none', request: auth.SiweVerifyRequestSchema, response: auth.SiweVerifyResponseSchema },
  { method: 'POST', path: '/auth/farcaster', module: 'auth', auth: 'none', request: auth.FarcasterAuthRequestSchema, response: auth.FarcasterAuthResponseSchema },
  { method: 'POST', path: '/auth/email/start', module: 'auth', auth: 'none', request: auth.EmailStartRequestSchema, response: auth.EmailStartResponseSchema },
  { method: 'POST', path: '/auth/email/verify', module: 'auth', auth: 'none', request: auth.EmailVerifyRequestSchema, response: auth.EmailVerifyResponseSchema },
  { method: 'POST', path: '/auth/logout', module: 'auth', auth: 'user', request: null, response: auth.LogoutResponseSchema },
  // me
  { method: 'GET', path: '/me', module: 'me', auth: 'user', request: null, response: me.MeResponseSchema },
  { method: 'PATCH', path: '/me', module: 'me', auth: 'user', request: me.UpdateMeRequestSchema, response: me.UpdateMeResponseSchema },
  { method: 'POST', path: '/me/tos', module: 'me', auth: 'user', request: me.AcceptTosRequestSchema, response: me.AcceptTosResponseSchema },
  { method: 'POST', path: '/me/identities/link', module: 'me', auth: 'user', request: me.LinkIdentityRequestSchema, response: me.LinkIdentityResponseSchema },
  { method: 'POST', path: '/me/merges/:id/confirm', module: 'me', auth: 'user', request: me.ConfirmMergeRequestSchema, response: me.ConfirmMergeResponseSchema, params: IdParamsSchema },
  { method: 'DELETE', path: '/me/identities/:id', module: 'me', auth: 'user', request: null, response: me.UnlinkIdentityResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/me/email', module: 'me', auth: 'user', request: me.AddEmailRequestSchema, response: me.AddEmailResponseSchema },
  { method: 'POST', path: '/me/email/verify', module: 'me', auth: 'user', request: me.VerifyEmailRequestSchema, response: me.VerifyEmailResponseSchema },
  { method: 'POST', path: '/me/personhood', module: 'me', auth: 'user', request: null, response: me.StartPersonhoodResponseSchema },
  { method: 'GET', path: '/me/personhood/callback', module: 'me', auth: 'none', request: null, response: me.PersonhoodCallbackResponseSchema, query: me.PersonhoodCallbackQuerySchema },
  { method: 'GET', path: '/me/referrals', module: 'me', auth: 'user', request: null, response: me.ReferralsResponseSchema },
  // rounds, entries, stakes
  { method: 'GET', path: '/rounds/today', module: 'rounds', auth: 'none', request: null, response: rounds.RoundsTodayResponseSchema },
  { method: 'GET', path: '/rounds/:id', module: 'rounds', auth: 'none', request: null, response: rounds.RoundDetailResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/rounds', module: 'rounds', auth: 'none', request: null, response: rounds.RoundsArchiveResponseSchema, query: rounds.RoundsArchiveQuerySchema },
  { method: 'POST', path: '/rounds/:id/entries', module: 'entries', auth: 'user', request: entries.CreateEntryRequestSchema, response: entries.CreateEntryResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/rounds/:id/entries/stakes/prepare', module: 'stakes', auth: 'user', request: entries.StakesPrepareRequestSchema, response: entries.StakesPrepareResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/rounds/:id/me', module: 'entries', auth: 'user', request: null, response: entries.RoundMeResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/rounds/:id/verify', module: 'rounds', auth: 'none', request: null, response: rounds.RoundVerifyResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/rounds/:id/ws', module: 'rounds', auth: 'none', request: null, response: WsServerMessageSchema, params: IdParamsSchema, responseType: 'websocket' },
  // claims
  { method: 'GET', path: '/claims', module: 'claims', auth: 'optional', request: null, response: claims.ClaimsResponseSchema, query: claims.ClaimsQuerySchema },
  // questions
  { method: 'GET', path: '/questions', module: 'questions', auth: 'optional', request: null, response: questions.QuestionsListResponseSchema, query: questions.QuestionsListQuerySchema },
  { method: 'POST', path: '/questions', module: 'questions', auth: 'user', request: questions.SubmitQuestionRequestSchema, response: questions.SubmitQuestionResponseSchema },
  { method: 'POST', path: '/questions/:id/vote', module: 'questions', auth: 'user', request: questions.VoteQuestionRequestSchema, response: questions.VoteQuestionResponseSchema, params: IdParamsSchema },
  // boards, users
  { method: 'GET', path: '/leaderboards/:board', module: 'boards', auth: 'optional', request: null, response: boards.LeaderboardResponseSchema, params: boards.LeaderboardParamsSchema, query: boards.LeaderboardQuerySchema },
  { method: 'GET', path: '/users/:handle', module: 'users', auth: 'none', request: null, response: boards.UserProfileResponseSchema, params: boards.UserProfileParamsSchema },
  // rooms
  { method: 'POST', path: '/rooms', module: 'rooms', auth: 'user', request: rooms.CreateRoomRequestSchema, response: rooms.CreateRoomResponseSchema },
  { method: 'POST', path: '/rooms/join', module: 'rooms', auth: 'user', request: rooms.JoinRoomRequestSchema, response: rooms.JoinRoomResponseSchema },
  { method: 'GET', path: '/rooms/:id', module: 'rooms', auth: 'user', request: null, response: rooms.RoomDetailResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/rooms/:id/questions', module: 'rooms', auth: 'user', request: rooms.SetRoomQuestionRequestSchema, response: rooms.SetRoomQuestionResponseSchema, params: IdParamsSchema },
  // cards
  { method: 'GET', path: '/s/:shareId', module: 'cards', auth: 'none', request: null, response: cards.SharePageResponseSchema, params: cards.SharePageParamsSchema, responseType: 'html' },
  { method: 'GET', path: `/cards/:shareId/${PNG_VARIANT}`, module: 'cards', auth: 'none', request: null, response: cards.CardImageResponseSchema, params: cards.CardImageParamsSchema, responseType: 'png' },
  { method: 'GET', path: `/rounds/:id/card/${PNG_VARIANT}`, module: 'cards', auth: 'none', request: null, response: cards.RoundCardResponseSchema, params: cards.RoundCardParamsSchema, responseType: 'png' },
  // me (deletion), push, limits
  { method: 'DELETE', path: '/me', module: 'me', auth: 'user', request: null, response: me.DeleteMeResponseSchema },
  { method: 'POST', path: '/push/subscribe', module: 'push', auth: 'user', request: push.PushSubscribeRequestSchema, response: push.PushSubscribeResponseSchema },
  { method: 'PUT', path: '/me/limits', module: 'limits', auth: 'user', request: limits.SetLimitsRequestSchema, response: limits.SetLimitsResponseSchema },
  { method: 'POST', path: '/me/limits/exclusion-lift', module: 'limits', auth: 'user', request: null, response: limits.ExclusionLiftResponseSchema },
  // admin: the spec's role row, then the drafted `/admin/*` endpoints
  { method: 'POST', path: '/admin/users/:id/role', module: 'admin', auth: 'admin', request: admin.SetUserRoleRequestSchema, response: admin.SetUserRoleResponseSchema, params: admin.AdminUserParamsSchema },
  { method: 'GET', path: '/admin/schedule', module: 'admin', auth: 'admin', request: null, response: admin.AdminScheduleResponseSchema, query: admin.AdminScheduleQuerySchema },
  { method: 'PUT', path: '/admin/schedule/:gameDay', module: 'admin', auth: 'admin', request: admin.AssignQuestionRequestSchema, response: admin.AssignQuestionResponseSchema, params: admin.AdminScheduleDayParamsSchema },
  { method: 'PATCH', path: '/admin/rounds/:id/config', module: 'admin', auth: 'admin', request: admin.EditRoundConfigRequestSchema, response: admin.EditRoundConfigResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/admin/rounds/:id/live', module: 'admin', auth: 'admin', request: null, response: admin.AdminLiveRoundResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/admin/rounds/:id/void', module: 'admin', auth: 'admin', request: admin.VoidRoundRequestSchema, response: admin.VoidRoundResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/admin/rounds/:id/settlement/retry', module: 'admin', auth: 'admin', request: admin.RetrySettlementRequestSchema, response: admin.RetrySettlementResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/admin/contract/pause', module: 'admin', auth: 'admin', request: admin.PauseContractRequestSchema, response: admin.PauseContractResponseSchema },
  { method: 'GET', path: '/admin/challenges', module: 'admin', auth: 'admin', request: null, response: admin.AdminChallengesResponseSchema },
  { method: 'GET', path: '/admin/questions', module: 'admin', auth: 'admin', request: null, response: admin.AdminQuestionsResponseSchema, query: admin.AdminQuestionsQuerySchema },
  { method: 'POST', path: '/admin/questions', module: 'admin', auth: 'admin', request: admin.AddHouseQuestionRequestSchema, response: admin.AddHouseQuestionResponseSchema },
  { method: 'PATCH', path: '/admin/questions/:id', module: 'admin', auth: 'admin', request: admin.EditQuestionRequestSchema, response: admin.EditQuestionResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/admin/questions/:id/approve', module: 'admin', auth: 'admin', request: null, response: admin.ApproveQuestionResponseSchema, params: IdParamsSchema },
  { method: 'POST', path: '/admin/questions/:id/reject', module: 'admin', auth: 'admin', request: admin.RejectQuestionRequestSchema, response: admin.RejectQuestionResponseSchema, params: IdParamsSchema },
  { method: 'GET', path: '/admin/users', module: 'admin', auth: 'admin', request: null, response: admin.AdminUsersResponseSchema, query: admin.AdminUsersQuerySchema },
  { method: 'GET', path: '/admin/users/:id', module: 'admin', auth: 'admin', request: null, response: admin.AdminUserDetailResponseSchema, params: admin.AdminUserParamsSchema },
  { method: 'POST', path: '/admin/users/:id/status', module: 'admin', auth: 'admin', request: admin.SetUserStatusRequestSchema, response: admin.SetUserStatusResponseSchema, params: admin.AdminUserParamsSchema },
  { method: 'POST', path: '/admin/users/:id/points', module: 'admin', auth: 'admin', request: admin.AdjustPointsRequestSchema, response: admin.AdjustPointsResponseSchema, params: admin.AdminUserParamsSchema },
  { method: 'GET', path: '/admin/config', module: 'admin', auth: 'admin', request: null, response: admin.AdminConfigResponseSchema },
  { method: 'PUT', path: '/admin/config', module: 'admin', auth: 'admin', request: admin.UpdateAdminConfigRequestSchema, response: admin.UpdateAdminConfigResponseSchema },
  // paymaster (plan wave 10). Wallet SDKs call it without a session;
  // the route keys the daily cap on the user operation's sender.
  { method: 'POST', path: '/paymaster', module: 'paymaster', auth: 'none', request: entries.PaymasterRequestSchema, response: entries.PaymasterResponseSchema },
];
