#!/usr/bin/env node
// Mock Coinbase Verifications chain for the local stack and e2e (W5-B): a JSON-RPC endpoint that
// answers `eth_call` for Coinbase's attestation indexer (`getAttestationUid(recipient, schemaUid)`)
// and EAS (`getAttestation(uid)`) at their Base addresses, the reads in
// apps/api/src/personhood/attestations.ts. Attestations live in memory and are created through the
// mock's own control routes. Addresses and schema UIDs must match ATTESTATION_NETWORKS.base in
// apps/api/src/personhood/config.ts (github.com/coinbase/verifications).
//
//   node e2e/mocks/eas/server.mjs                 # listens on 127.0.0.1:8791
//   MOCK_EAS_PORT=9002 node e2e/mocks/eas/server.mjs
//
// Point the API at it in `.dev.vars`:
//   ATTESTATION_NETWORK=base
//   ATTESTATION_RPC_URL=http://127.0.0.1:8791
//
// Control routes:
//   GET  /health        {"ok": true}
//   POST /mock/verify   {"recipient": "0x…", "country": "US"} → both attestations {"account", "country"}
//   POST /mock/attest   {"recipient": "0x…", "kind": "account"|"country", "country"?: "US",
//                        "attester"?: "0x…", "expirationTime"?: 0} → {"uid"}
//   POST /mock/revoke   {"uid": "0x…"} → {"ok": true}
import { createServer } from 'node:http';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  isAddress,
  isAddressEqual,
  keccak256,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem';

const port = Number(process.env.MOCK_EAS_PORT ?? 8791);
const host = process.env.MOCK_EAS_HOST ?? '127.0.0.1';
const origin = `http://${host}:${port}`;

const BASE = {
  chainId: 8453,
  eas: '0x4200000000000000000000000000000000000021',
  indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',
  attester: '0x357458739F90461b99789350868CD7CF330Dd7EE',
  verifiedAccountSchema: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
  verifiedCountrySchema: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
};

const INDEXER_ABI = [
  {
    type: 'function',
    name: 'getAttestationUid',
    stateMutability: 'view',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'schemaUid', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
];

const EAS_ABI = [
  {
    type: 'function',
    name: 'getAttestation',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
];

const EMPTY = {
  uid: zeroHash,
  schema: zeroHash,
  time: 0n,
  expirationTime: 0n,
  revocationTime: 0n,
  refUID: zeroHash,
  recipient: zeroAddress,
  attester: zeroAddress,
  revocable: false,
  data: '0x',
};

const latest = new Map(); // `${recipient}:${schema}` → uid (the indexer's view)
const attestations = new Map(); // uid → attestation
let counter = 0;

function attest({ recipient, kind, country = 'US', attester = BASE.attester, expirationTime = 0 }) {
  if (!isAddress(recipient)) throw new Error('recipient must be an address');
  if (kind !== 'account' && kind !== 'country') throw new Error('kind must be account or country');
  const schema = kind === 'account' ? BASE.verifiedAccountSchema : BASE.verifiedCountrySchema;
  const uid = keccak256(toHex(`mock-attestation-${++counter}-${Date.now()}`));
  const data =
    kind === 'account'
      ? encodeAbiParameters([{ type: 'bool' }], [true])
      : encodeAbiParameters([{ type: 'string' }], [String(country)]);
  attestations.set(uid, {
    uid,
    schema,
    time: BigInt(Math.floor(Date.now() / 1000)),
    expirationTime: BigInt(expirationTime),
    revocationTime: 0n,
    refUID: zeroHash,
    recipient,
    attester,
    revocable: true,
    data,
  });
  latest.set(`${recipient.toLowerCase()}:${schema}`, uid);
  return uid;
}

function ethCall({ to, data }) {
  if (to && isAddressEqual(to, BASE.indexer)) {
    const { args } = decodeFunctionData({ abi: INDEXER_ABI, data });
    const uid = latest.get(`${args[0].toLowerCase()}:${args[1]}`) ?? zeroHash;
    return encodeFunctionResult({
      abi: INDEXER_ABI,
      functionName: 'getAttestationUid',
      result: uid,
    });
  }
  if (to && isAddressEqual(to, BASE.eas)) {
    const { args } = decodeFunctionData({ abi: EAS_ABI, data });
    const result = attestations.get(args[0]) ?? EMPTY;
    return encodeFunctionResult({ abi: EAS_ABI, functionName: 'getAttestation', result });
  }
  return '0x'; // no code at that address
}

function rpc(request) {
  const { id = null, method, params = [] } = request ?? {};
  try {
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id, result: toHex(BASE.chainId) };
    if (method === 'eth_blockNumber') return { jsonrpc: '2.0', id, result: '0x1' };
    if (method === 'eth_call') return { jsonrpc: '2.0', id, result: ethCall(params[0] ?? {}) };
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: 3, message: `execution reverted: ${err.message}` },
    };
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const routes = {
  'POST /': (body) => (Array.isArray(body) ? body.map(rpc) : rpc(body)),
  'POST /mock/verify': ({ recipient, country }) => ({
    account: attest({ recipient, kind: 'account' }),
    country: attest({ recipient, kind: 'country', country }),
  }),
  'POST /mock/attest': (body) => ({ uid: attest(body) }),
  'POST /mock/revoke': ({ uid }) => {
    const a = attestations.get(uid);
    if (!a) throw new Error('unknown uid');
    a.revocationTime = BigInt(Math.floor(Date.now() / 1000));
    return { ok: true };
  },
};

const server = createServer((req, res) => {
  const route = `${req.method} ${new URL(req.url ?? '/', origin).pathname}`;
  if (route === 'GET /health') return json(res, 200, { ok: true });
  const handler = routes[route];
  if (!handler) return json(res, 404, { error: 'not found' });
  readJson(req)
    .then((body) => json(res, 200, handler(body)))
    .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : String(err) }));
});

server.listen(port, host, () => {
  console.log(`mock eas listening on ${origin}`);
});
