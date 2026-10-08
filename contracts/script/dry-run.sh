#!/usr/bin/env bash
# Deploy dry run: starts a fresh anvil, broadcasts script/Deploy.s.sol to it, and checks deployments/31337.json
# against the chain (code at every address, wiring, deployBlock). Uses anvil's unlocked dev accounts (no keys).
#
#   bash contracts/script/dry-run.sh            # PORT=8545 by default
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
OUT="deployments/31337.json"

anvil --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "anvil did not start on $RPC" >&2; exit 1; }

# anvil's dev accounts, in order: deployer, then one per role.
read -r -a ACCOUNTS <<<"$(cast rpc eth_accounts --rpc-url "$RPC" | tr -d '[]"' | tr ',' ' ')"
export ADMIN="${ACCOUNTS[1]}" GUARDIAN="${ACCOUNTS[2]}" OPERATOR="${ACCOUNTS[3]}" PAUSER="${ACCOUNTS[4]}"
export TICKET_SIGNER="${ACCOUNTS[5]}" TREASURY="${ACCOUNTS[6]}" ANCHORER="${ACCOUNTS[7]}"
export RECEIPT_SIGNER="${ACCOUNTS[8]}" DRAND_GENESIS=1692803367 DRAND_PERIOD=3
unset USDC DEPLOYMENTS_FILE

rm -f "$OUT"
forge script script/Deploy.s.sol --fork-url "$RPC" --broadcast --unlocked --sender "${ACCOUNTS[0]}" -q

fail() { echo "dry run: $*" >&2; exit 1; }
[ -f "$OUT" ] || fail "$OUT was not written"
field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([0-9a-fA-Fx]*\)\"\{0,1\}.*/\1/p" "$OUT"; }
ESCROW="$(field escrow)" ANCHOR="$(field anchor)" USDC_ADDR="$(field usdc)" BLOCK="$(field deployBlock)"
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
same() { [ "$(lower "$1")" = "$(lower "$2")" ]; }

for name in ESCROW ANCHOR USDC_ADDR; do
  addr="${!name}"
  [ -n "$addr" ] || fail "$name missing from $OUT"
  [ "$(cast code "$addr" --rpc-url "$RPC")" != "0x" ] || fail "no code at $name $addr"
done
[ "$BLOCK" -le "$(cast block-number --rpc-url "$RPC")" ] || fail "deployBlock $BLOCK is in the future"
same "$(cast call "$ESCROW" 'usdc()(address)' --rpc-url "$RPC")" "$USDC_ADDR" || fail "escrow usdc"
same "$(cast call "$ESCROW" 'guardian()(address)' --rpc-url "$RPC")" "$GUARDIAN" || fail "escrow guardian"
same "$(cast call "$ESCROW" 'ticketSigner()(address)' --rpc-url "$RPC")" "$TICKET_SIGNER" || fail "ticket signer"
same "$(cast call "$ANCHOR" 'receiptSigner()(address)' --rpc-url "$RPC")" "$RECEIPT_SIGNER" || fail "receipt signer"
ROLE="$(cast keccak ANCHOR_ROLE)"
[ "$(cast call "$ANCHOR" 'hasRole(bytes32,address)(bool)' "$ROLE" "$ANCHORER" --rpc-url "$RPC")" = "true" ] ||
  fail "anchorer role"
[ "$(cast call "$USDC_ADDR" 'decimals()(uint8)' --rpc-url "$RPC")" = "6" ] || fail "MockUSDC decimals"

echo "dry run ok: escrow $ESCROW, anchor $ANCHOR, usdc $USDC_ADDR, deployBlock $BLOCK"
