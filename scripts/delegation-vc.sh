#!/usr/bin/env bash
#
# Runs a validator client for the validators ArkBondDelegation funded.
#
#   bash scripts/delegation-vc.sh          # import the keystores and start the client
#   bash scripts/delegation-vc.sh --status # show the container and its last log lines
#   bash scripts/delegation-vc.sh --down   # stop and remove the container
#
# Run from WSL, against a running enclave (npm run net:up). `npm run deploy`
# funds two validators through the delegation contract and writes their
# keystores under .kurtosis/deposits/<label>/keys, but nothing loads those keys:
# the enclave's own vc-1/vc-2 carry only the genesis ranges. Without a client,
# the validators activate hours after the deposit and then attest nothing,
# losing balance every epoch -- bond principal, under whitepaper section 3.4.
#
# THE ONE RULE: A KEY IS LOADED IN EXACTLY ONE CLIENT
# ---------------------------------------------------
# Two clients signing with one key is a slashable double vote. The script
# therefore refuses to start while its container exists, imports only the batch
# deployments/private.json names (the earlier batch under .kurtosis/deposits was
# generated but never funded), and keeps its wallet and slashing-protection
# database in .kurtosis/vc-delegation, which survives a restart of the container
# but not `npm run net:down`. After a new deploy, run --down first: a new deploy
# funds new keys, and the old wallet must not be pointed at a new chain.
#
# The container runs on the enclave's Docker network, outside Kurtosis's service
# registry, so `kurtosis enclave inspect` does not list it and `net:down` does
# not remove it. Run --down before destroying the enclave.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENCLAVE="${ENCLAVE:-quantum-ark}"
NETWORK="kt-${ENCLAVE}"
NAME="${VC_NAME:-vc-ark-delegation}"
VC_IMAGE="${VC_IMAGE:-qrysm-validator:quantum-ark-local}"
BEACON="${BEACON_HOST:-cl-1-qrysm-gqrl}"
STATE="$ROOT/.kurtosis/vc-delegation"
DEPLOYMENT="$ROOT/deployments/private.json"

die() { echo "error: $*" >&2; exit 1; }

case "${1:-}" in
  --down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME" || echo "$NAME is not running"
    exit 0
    ;;
  --status)
    docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}  {{.Status}}'
    docker logs --tail 20 "$NAME" 2>&1 || true
    exit 0
    ;;
  "") ;;
  *) die "unknown option $1" ;;
esac

# ---------------------------------------------------------------- preflight

command -v docker >/dev/null || die "docker not found in this shell"
command -v kurtosis >/dev/null || die "kurtosis not found; run npm run net:bootstrap"
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network $NETWORK not found; is the enclave up?"
docker image inspect "$VC_IMAGE" >/dev/null 2>&1 || die "$VC_IMAGE not found; run scripts/build-qrysm.sh"
[ -f "$DEPLOYMENT" ] || die "no deployments/private.json; run npm run deploy first"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  die "$NAME already exists. A key loaded in two clients is slashable; run --down first if you mean to replace it"
fi

# The deployment records the keystore directory with the separator of the
# machine that wrote it; normalise Windows backslashes.
KEYS_REL="$(sed -nE 's/.*"keystores"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$DEPLOYMENT" | head -1 | tr '\\' '/' | sed 's#//#/#g')"
[ -n "$KEYS_REL" ] || die "deployments/private.json names no keystores; the last deploy funded no validator"
BATCH="$ROOT/$KEYS_REL"
[ -d "$BATCH/keys" ] || die "$BATCH/keys not found"
[ -f "$BATCH/pw.txt" ] || die "$BATCH/pw.txt not found"

DELEGATION="$(sed -nE '/"delegation"/,/}/ s/.*"address"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$DEPLOYMENT" | head -1)"
[ -n "$DELEGATION" ] || die "deployments/private.json names no delegation address"

COUNT="$(find "$BATCH/keys" -name 'keystore-*.json' | wc -l)"
echo "== batch      $KEYS_REL ($COUNT keystores)"
echo "   fee recipient $DELEGATION (the delegation contract, as the withdrawal credentials are)"
echo "   beacon     $BEACON:4000 on $NETWORK"

# ------------------------------------------------------------ chain config

mkdir -p "$STATE"
if [ -d "$STATE/network-configs" ]; then rm -rf "$STATE/network-configs"; fi
kurtosis files download "$ENCLAVE" el_cl_genesis_data "$STATE/network-configs" >/dev/null
[ -f "$STATE/network-configs/config.yaml" ] || die "el_cl_genesis_data carries no config.yaml"

# --------------------------------------------------------------- import

if [ ! -f "$STATE/wallet-password.txt" ]; then
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE/wallet-password.txt"
fi

if [ -d "$STATE/wallet" ]; then
  echo "== wallet     reusing $STATE/wallet"
else
  echo "== importing  $COUNT keystores"
  docker run --rm \
    -v "$BATCH/keys:/keys:ro" \
    -v "$BATCH/pw.txt:/secrets/keystore-password.txt:ro" \
    -v "$STATE/wallet-password.txt:/secrets/wallet-password.txt:ro" \
    -v "$STATE:/state" \
    "$VC_IMAGE" \
    accounts import \
      --accept-terms-of-use \
      --keys-dir=/keys \
      --wallet-dir=/state/wallet \
      --wallet-password-file=/secrets/wallet-password.txt \
      --account-password-file=/secrets/keystore-password.txt
fi

# ---------------------------------------------------------------- start

echo "== starting   $NAME"
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  -v "$STATE:/state" \
  -v "$STATE/network-configs:/network-configs:ro" \
  -v "$STATE/wallet-password.txt:/secrets/wallet-password.txt:ro" \
  "$VC_IMAGE" \
  --accept-terms-of-use=true \
  --chain-config-file=/network-configs/config.yaml \
  --suggested-fee-recipient="$DELEGATION" \
  --beacon-rpc-provider="$BEACON:4000" \
  --beacon-rest-api-provider="http://$BEACON:3500" \
  --graffiti=ark-delegation \
  --wallet-dir=/state/wallet \
  --wallet-password-file=/secrets/wallet-password.txt \
  --datadir=/state/db >/dev/null

sleep 5
docker logs --tail 15 "$NAME" 2>&1
echo
echo "The validators activate only after the follow distance and the voting period;"
echo "until then the client reports them as unknown or pending. Check with:"
echo "   npm run delegation:status"
