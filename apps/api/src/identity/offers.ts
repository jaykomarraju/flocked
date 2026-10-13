// Wallets verified on the user's Farcaster account are offered for linking automatically (spec
// "Identity and personhood" › Identities). An offer is an unverified `identities` row (verified_at
// NULL): `GET /me` lists it, the user links it with SIWE like any wallet (POST /me/identities/link),
// and it never blocks sign-in or another account's link (src/identity/link.ts). A wallet some
// account already holds, verified or offered, is not offered again.
//
// The verified addresses come from a Farcaster hub's HTTP API (`GET /v1/verificationsByFid`), at
// `FARCASTER_HUB_URL`. Without it nothing is offered. Offers are refreshed at most once a day per
// Farcaster identity, when the user links Farcaster or loads `GET /me`; a failure only logs.
import { newUlid } from '@flocked/shared';
import { isAddress } from 'viem';
import type { Env } from '../env.js';
import { log } from '../lib/log.js';
import { DAY_MS } from '../limits/rules.js';

/** Looks up the Ethereum addresses verified on a Farcaster account (lowercase). */
export type FarcasterWalletLookup = (fid: string) => Promise<string[]>;

const overrides = new WeakMap<object, FarcasterWalletLookup>();

/**
 * Test hook: `env` (the same object, so its other test hooks stay) now looks wallets up through
 * `lookup`.
 */
export function withFarcasterWallets<E extends Env>(env: E, lookup: FarcasterWalletLookup): E {
  overrides.set(env, lookup);
  return env;
}

/** The hub origin (`FARCASTER_HUB_URL`). */
function hubUrl(env: Env): string | undefined {
  return env.FARCASTER_HUB_URL || undefined;
}

const MAX_PAGES = 5;

interface HubVerification {
  data?: {
    verificationAddAddressBody?: { address?: string; protocol?: string };
    verificationAddEthAddressBody?: { address?: string };
  };
}

/** The real lookup: a hub's `verificationsByFid`, every page (at most 5). */
function hubLookup(origin: string): FarcasterWalletLookup {
  return async (fid) => {
    const found = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('/v1/verificationsByFid', origin);
      url.searchParams.set('fid', fid);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      const body = await res.json<{ messages?: HubVerification[]; nextPageToken?: string }>();
      for (const m of body.messages ?? []) {
        const v = m.data?.verificationAddAddressBody;
        const address = v?.address ?? m.data?.verificationAddEthAddressBody?.address;
        if (v?.protocol && v.protocol !== 'PROTOCOL_ETHEREUM') continue;
        if (address && isAddress(address, { strict: false })) found.add(address.toLowerCase());
      }
      pageToken = body.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return [...found];
  };
}

function lookupFor(env: Env): FarcasterWalletLookup | null {
  const override = overrides.get(env);
  if (override) return override;
  const origin = hubUrl(env);
  return origin ? hubLookup(origin) : null;
}

interface FarcasterRow {
  id: string;
  external_id: string;
  data_json: string;
}

/**
 * Offers the wallets verified on `userId`'s Farcaster account, unless they were looked up within
 * the last day (`force` skips that). Returns how many new offers were written.
 */
export async function refreshFarcasterOffers(
  env: Env,
  userId: string,
  t: number,
  force = false,
): Promise<number> {
  const lookup = lookupFor(env);
  if (!lookup) return 0;
  const db = env.DB;
  const fc = await db
    .prepare(
      "SELECT id, external_id, data_json FROM identities WHERE user_id = ?1 AND provider = 'farcaster' " +
        'AND verified_at IS NOT NULL',
    )
    .bind(userId)
    .first<FarcasterRow>();
  if (!fc) return 0;
  const data = parseData(fc.data_json);
  const checked = typeof data.walletsOfferedAt === 'number' ? data.walletsOfferedAt : null;
  if (!force && checked !== null && t - checked < DAY_MS) return 0;

  const dismissed = new Set(Array.isArray(data.dismissedWallets) ? data.dismissedWallets : []);
  let wallets: string[];
  try {
    wallets = (await lookup(fc.external_id)).filter((w) => !dismissed.has(w));
  } catch (err) {
    log.warn('farcaster_wallets_unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  const results = await db.batch([
    ...wallets.map((w) =>
      db
        .prepare(
          "INSERT INTO identities (id, user_id, provider, external_id, verified_at, data_json) VALUES (?1, ?2, 'wallet', ?3, NULL, ?4) " +
            'ON CONFLICT (provider, external_id) DO NOTHING',
        )
        .bind(newUlid(t), userId, w, JSON.stringify({ offeredBy: 'farcaster' })),
    ),
    db
      .prepare('UPDATE identities SET data_json = ?2 WHERE id = ?1')
      .bind(fc.id, JSON.stringify({ ...data, walletsOfferedAt: t })),
  ]);
  return results.slice(0, wallets.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

function parseData(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Remembers that the user dismissed the offered wallet `address` (DELETE /me/identities/:id), so
 * later refreshes don't offer it again: it joins `dismissedWallets` on the Farcaster identity.
 */
export function dismissOfferStatement(
  db: D1Database,
  userId: string,
  address: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE identities SET data_json = json_set(data_json, '$.dismissedWallets', json(json_insert(" +
        "COALESCE(json_extract(data_json, '$.dismissedWallets'), '[]'), '$[#]', ?2))) " +
        "WHERE user_id = ?1 AND provider = 'farcaster' AND verified_at IS NOT NULL",
    )
    .bind(userId, address.toLowerCase());
}
