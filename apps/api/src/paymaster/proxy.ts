// ERC-7677 provider forwarding. The request body is relayed byte-for-byte after local validation;
// provider failures become small JSON-RPC errors and never expose configuration or response text.
import { flockedEscrowAbi } from '@flocked/abi';
import { PaymasterRequestSchema, type PaymasterRequest } from '@flocked/shared';
import type { Address } from 'viem';
import { publicClient, deploymentOf } from '../chain/client.js';
import type { Env } from '../env.js';
import { now } from '../lib/clock.js';
import {
  acquireSponsorship,
  commitSponsorship,
  releaseSponsorship,
  sponsorshipKey,
} from './quota.js';
import { SponsorshipRefused, validateSponsoredOperation } from './policy.js';

export const PAYMASTER_TIMEOUT_MS = 8_000;
export const MAX_PAYMASTER_REQUEST_BYTES = 256 * 1024;

export interface JsonRpcError {
  code: number;
  message: string;
}

export type PaymasterReply =
  | {
      status: number;
      body: { jsonrpc: '2.0'; id: string | number; result: Record<string, unknown> };
    }
  | {
      status: number;
      body: { jsonrpc: '2.0'; id: string | number | null; error: JsonRpcError };
    };

interface ProviderReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface PaymasterProxyDeps {
  fetch?: typeof globalThis.fetch;
  ticketSigner?: (env: Env) => Promise<Address>;
  stakeForRound?: (env: Env, roundId: bigint) => Promise<bigint>;
}

const errorReply = (
  id: string | number | null,
  code: number,
  message: string,
  status = 200,
): PaymasterReply => ({ status, body: { jsonrpc: '2.0', id, error: { code, message } } });

/** Reads an HTTP body without ever buffering more than the endpoint limit. */
export async function readPaymasterBody(
  body: ReadableStream<Uint8Array> | null,
  contentLength?: string | null,
): Promise<string | null> {
  const declared =
    contentLength === undefined || contentLength === null ? null : Number(contentLength);
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_PAYMASTER_REQUEST_BYTES)
  ) {
    return null;
  }
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAYMASTER_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestId(value: unknown): string | number | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)) ? id : null;
}

function validProviderReply(value: unknown, request: PaymasterRequest): ProviderReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reply = value as Record<string, unknown>;
  if (reply.jsonrpc !== '2.0' || reply.id !== request.id) return null;
  if (reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result)) {
    return { result: reply.result as Record<string, unknown> };
  }
  if (reply.error && typeof reply.error === 'object' && !Array.isArray(reply.error)) {
    const e = reply.error as Record<string, unknown>;
    if (typeof e.code === 'number' && Number.isInteger(e.code) && typeof e.message === 'string') {
      return {
        error: {
          code: e.code,
          message: e.message,
          ...(e.data === undefined ? {} : { data: e.data }),
        },
      };
    }
  }
  return null;
}

async function chainTicketSigner(env: Env): Promise<Address> {
  return publicClient(env).readContract({
    address: deploymentOf(env).escrow,
    abi: flockedEscrowAbi,
    functionName: 'ticketSigner',
  });
}

async function chainStakeForRound(env: Env, roundId: bigint): Promise<bigint> {
  const round = await publicClient(env).readContract({
    address: deploymentOf(env).escrow,
    abi: flockedEscrowAbi,
    functionName: 'getRound',
    args: [roundId],
  });
  return round.cfg.stake;
}

function providerUrl(env: Env): URL | null {
  if (!env.PAYMASTER_URL) return null;
  try {
    const url = new URL(env.PAYMASTER_URL);
    if (url.protocol === 'https:' || (env.ENVIRONMENT === 'local' && url.protocol === 'http:')) {
      return url;
    }
  } catch {
    // Deployment/configuration error, returned generically below.
  }
  return null;
}

async function callProvider(
  fetcher: typeof globalThis.fetch,
  url: URL,
  raw: string,
  request: PaymasterRequest,
): Promise<ProviderReply | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYMASTER_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
      signal: controller.signal,
    });
    // A provider may use an HTTP error for a valid JSON-RPC error. Only the JSON-RPC envelope is
    // trusted; HTML/text bodies never cross this proxy.
    const text = await readPaymasterBody(response.body, response.headers.get('content-length'));
    if (text === null) return null;
    try {
      return validProviderReply(JSON.parse(text) as unknown, request);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Validates, applies the final-only quota and calls the configured provider. */
export async function proxyPaymaster(
  env: Env,
  raw: string,
  deps: PaymasterProxyDeps = {},
): Promise<PaymasterReply> {
  if (new TextEncoder().encode(raw).byteLength > MAX_PAYMASTER_REQUEST_BYTES) {
    return errorReply(null, -32600, 'invalid request', 413);
  }
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return errorReply(null, -32700, 'parse error');
  }
  const id = requestId(input);
  if (input && typeof input === 'object') {
    const method = (input as { method?: unknown }).method;
    if (
      typeof method === 'string' &&
      method !== 'pm_getPaymasterStubData' &&
      method !== 'pm_getPaymasterData'
    ) {
      return errorReply(id, -32601, 'method not found');
    }
  }
  const parsed = PaymasterRequestSchema.safeParse(input);
  if (!parsed.success) return errorReply(id, -32600, 'invalid request');
  const request = parsed.data;
  const url = providerUrl(env);
  if (!url) return errorReply(request.id, -32000, 'paymaster unavailable');

  let userOp;
  try {
    const signer = await (deps.ticketSigner ?? chainTicketSigner)(env);
    userOp = await validateSponsoredOperation(env, request, signer, (roundId) =>
      (deps.stakeForRound ?? chainStakeForRound)(env, roundId),
    );
  } catch (err) {
    if (err instanceof SponsorshipRefused) {
      return errorReply(request.id, -32602, 'call not sponsored');
    }
    return errorReply(request.id, -32000, 'paymaster unavailable');
  }

  const fetcher = deps.fetch ?? globalThis.fetch;
  if (request.method === 'pm_getPaymasterStubData') {
    const provider = await callProvider(fetcher, url, raw, request);
    if (!provider) return errorReply(request.id, -32000, 'paymaster unavailable');
    if (provider.error) {
      return { status: 200, body: { jsonrpc: '2.0', id: request.id, error: provider.error } };
    }
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: request.id, result: { ...provider.result!, isFinal: false } },
    };
  }

  const t = now(env);
  const key = sponsorshipKey({
    chainId: BigInt(env.CHAIN_ID),
    userOp,
  });
  let lease;
  try {
    lease = await acquireSponsorship(env.DB, { key, sender: userOp.sender, now: t });
  } catch {
    return errorReply(request.id, -32000, 'paymaster unavailable');
  }
  if (lease.kind === 'cap') {
    return errorReply(request.id, -32010, 'daily sponsorship cap reached');
  }
  if (lease.kind === 'pending') {
    return errorReply(request.id, -32011, 'operation sponsorship is pending');
  }
  if (lease.kind === 'replay') {
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: lease.result } };
  }

  const provider = await callProvider(fetcher, url, raw, request);
  if (!provider) {
    await releaseSponsorship(env.DB, lease).catch(() => undefined);
    return errorReply(request.id, -32000, 'paymaster unavailable');
  }
  if (provider.error) {
    await releaseSponsorship(env.DB, lease).catch(() => undefined);
    return { status: 200, body: { jsonrpc: '2.0', id: request.id, error: provider.error } };
  }
  try {
    if (!(await commitSponsorship(env.DB, lease, provider.result!, now(env)))) {
      return errorReply(request.id, -32000, 'paymaster unavailable');
    }
  } catch {
    return errorReply(request.id, -32000, 'paymaster unavailable');
  }
  return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: provider.result! } };
}
