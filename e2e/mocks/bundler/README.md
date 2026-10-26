# Bundler/paymaster mock

The local stack's combined ERC-4337 bundler and ERC-7677 paymaster provider. `stack:up` points both
`BUNDLER_URL` and `PAYMASTER_URL` at it. The paymaster proxy forwards an accepted JSON-RPC request
to `POST /` unchanged.

It answers `pm_getPaymasterStubData` with placeholder paymaster fields and `isFinal: false`, and
`pm_getPaymasterData` with the same fields and `isFinal: true`. Minimal bundler methods are present
for smart-wallet stand-ins; no operation is broadcast.

```bash
node e2e/mocks/bundler/server.mjs
curl http://127.0.0.1:8798/health
curl http://127.0.0.1:8798/calls
curl -X DELETE http://127.0.0.1:8798/calls
```

Set `MOCK_BUNDLER_PORT` to move its default `8798` port. `GET /calls` returns every JSON-RPC body
received at `POST /`, allowing E2E-11 to prove rejected operations never reached the provider.
