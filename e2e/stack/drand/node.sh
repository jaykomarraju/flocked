#!/bin/sh
# One local drand node (e2e/stack/docker-compose.yml): a long-term key pair for the unchained G1
# scheme on first start, then the daemon. Private gRPC on :4444, public HTTP on :8080, control on
# 127.0.0.1:8888 inside the container (dkg.sh drives it through `docker compose exec`).
set -eu

FOLDER=/data/drand/.drand
mkdir -p "$FOLDER"
chown -R drand /data/drand

if [ ! -d "$FOLDER/multibeacon/default/key" ]; then
  su-exec drand drand generate-keypair --folder "$FOLDER" --id default \
    --scheme bls-unchained-g1-rfc9380 "$NODE_ADDRESS"
fi

exec su-exec drand drand start --folder "$FOLDER" \
  --private-listen 0.0.0.0:4444 --public-listen 0.0.0.0:8080 --control 8888
