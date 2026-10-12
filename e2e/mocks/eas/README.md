# Mock Coinbase Verifications (EAS)

A JSON-RPC stand-in for the Base reads behind Stakes eligibility: Coinbase's attestation indexer
(`getAttestationUid(recipient, schemaUid)`) and EAS (`getAttestation(uid)`), at their Base
addresses with Coinbase's attester and the Verified Account and Verified Country schema UIDs
(`ATTESTATION_NETWORKS.base` in `apps/api/src/personhood/config.ts`). It answers `eth_chainId`
(8453), `eth_blockNumber` and `eth_call`; attestations live in memory.

```bash
node e2e/mocks/eas/server.mjs   # http://127.0.0.1:8791, MOCK_EAS_PORT to change
```

Point the API at it in `.dev.vars`:

```bash
ATTESTATION_NETWORK=base
ATTESTATION_RPC_URL=http://127.0.0.1:8791
```

Attest a linked wallet (both attestations, as Coinbase Verifications issues them), then revoke one:

```bash
curl -s localhost:8791/mock/verify -d '{"recipient":"0x…","country":"US"}'
# → {"account":"0x<uid>","country":"0x<uid>"}
curl -s localhost:8791/mock/revoke -d '{"uid":"0x<uid>"}'
```

`POST /mock/attest {"recipient", "kind": "account"|"country", "country"?, "attester"?,
"expirationTime"?}` makes a single attestation (another attester or an expiry exercises the API's
checks). The indexer always returns the latest attestation per recipient and schema.

`GET /me` caches a wallet's attestations for 10 minutes (`identities.data_json`); ticket issue
re-reads them. Unit tests do not use this server: `apps/api/test/personhood/fixtures.ts` has an
in-process fake behind a viem transport.
