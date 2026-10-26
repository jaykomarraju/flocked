#!/usr/bin/env node
// Combined local ERC-4337 bundler and ERC-7677 paymaster service (W10-D). The API forwards
// accepted paymaster requests here unchanged; the stack also names this origin as BUNDLER_URL so
// a Coinbase Smart Wallet stand-in can use one deterministic service for the whole user operation.
//
//   node e2e/mocks/bundler/server.mjs
//   MOCK_BUNDLER_PORT=9008 node e2e/mocks/bundler/server.mjs
//
// Control routes:
//   GET    /health   {"ok":true}
//   GET    /calls    {"calls":[the JSON-RPC requests received at POST /]}
//   DELETE /calls    forget the recorded requests
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_BUNDLER_PORT ?? 8797);
const host = process.env.MOCK_BUNDLER_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;

const PAYMASTER = '0x0000000000000000000000000000000000004337';
const ENTRY_POINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
let calls = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function paymasterResult(isFinal) {
  return {
    // EntryPoint v0.6 takes the packed paymaster address and data in one field.
    paymasterAndData: PAYMASTER,
    sponsor: { name: 'Flocked local paymaster' },
    isFinal,
  };
}

function userOperationHash(request) {
  return `0x${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;
}

function rpc(request) {
  const { id = null, method } = request ?? {};
  if (method === 'pm_getPaymasterStubData') {
    return { jsonrpc: '2.0', id, result: paymasterResult(false) };
  }
  if (method === 'pm_getPaymasterData') {
    return { jsonrpc: '2.0', id, result: paymasterResult(true) };
  }
  if (method === 'eth_estimateUserOperationGas') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        preVerificationGas: '0xc350',
        verificationGasLimit: '0x186a0',
        callGasLimit: '0x30d40',
        paymasterVerificationGasLimit: '0x186a0',
        paymasterPostOpGasLimit: '0x0',
      },
    };
  }
  if (method === 'eth_sendUserOperation') {
    return { jsonrpc: '2.0', id, result: userOperationHash(request) };
  }
  if (method === 'eth_getUserOperationReceipt') {
    return { jsonrpc: '2.0', id, result: null };
  }
  if (method === 'eth_supportedEntryPoints') {
    return { jsonrpc: '2.0', id, result: [ENTRY_POINT_V06] };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${String(method)}` },
  };
}

const server = createServer(async (req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', origin).pathname}`;
  try {
    if (route === 'GET /health') return json(res, 200, { ok: true });
    if (route === 'GET /calls') return json(res, 200, { calls });
    if (route === 'DELETE /calls') {
      calls = [];
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /') {
      const body = await readJson(req);
      if (Array.isArray(body)) {
        calls.push(...body);
        return json(res, 200, body.map(rpc));
      }
      calls.push(body);
      return json(res, 200, rpc(body));
    }
    return json(res, 404, { error: 'not_found' });
  } catch (err) {
    return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, host, () => {
  console.log(`mock bundler/paymaster on ${origin}`);
});
