#!/usr/bin/env bash
# DKG bootstrap for the local drand network (e2e/stack/README.md). drand0 leads: it proposes all
# three nodes as joiners, the other two join, and drand0 executes. The group key and chain hash are
# new on every run; genesis is GENESIS_DELAY after `init`, and rounds then come every PERIOD.
#
#   bash e2e/stack/drand/dkg.sh            # after `docker compose up -d`; up.mjs runs it
set -euo pipefail

cd "$(dirname "$0")/.."
PERIOD="${DRAND_PERIOD:-3}s"
GENESIS_DELAY="${DRAND_GENESIS_DELAY:-15}s"
NODES=(drand0 drand1 drand2)
THRESHOLD=2

x() { docker compose -f docker-compose.yml exec -T -u drand "$@"; }

# The daemons take a moment to open their control ports.
for node in "${NODES[@]}"; do
  for attempt in $(seq 1 60); do
    x "$node" drand util ping --control 8888 >/dev/null 2>&1 && break
    [ "$attempt" -eq 60 ] && { echo "dkg: $node did not come up" >&2; exit 1; }
    sleep 0.5
  done
done

joiners=()
for node in "${NODES[@]}"; do joiners+=(--joiner "$node:4444"); done
x drand0 drand dkg generate-proposal --id default "${joiners[@]}" --out /tmp/proposal.toml
x drand0 drand dkg init --id default --proposal /tmp/proposal.toml --threshold "$THRESHOLD" \
  --period "$PERIOD" --scheme bls-unchained-g1-rfc9380 --catchup-period 0s \
  --genesis-delay "$GENESIS_DELAY"
for node in "${NODES[@]:1}"; do x "$node" drand dkg join --id default; done
x drand0 drand dkg execute --id default
