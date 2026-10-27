// The public ERC-7677 paymaster service. Wallets call it without an app session; policy is derived
// only from the signed user operation's sender and Coinbase Smart Wallet calldata.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth-context.js';
import { proxyPaymaster, readPaymasterBody } from '../paymaster/proxy.js';

const app = new Hono<AppEnv>();

app.post('/paymaster', async (c) => {
  const raw = await readPaymasterBody(c.req.raw.body, c.req.header('content-length'));
  const reply =
    raw === null
      ? {
          status: 413,
          body: {
            jsonrpc: '2.0' as const,
            id: null,
            error: { code: -32600, message: 'invalid request' },
          },
        }
      : await proxyPaymaster(c.env, raw);
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
});

export const paymaster = app;
