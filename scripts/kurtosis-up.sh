#!/usr/bin/env bash
#
# Brings up a private QRL Zond network with Kurtosis and points .env at it.
#
# Run this from inside WSL (or any Linux/macOS shell). Kurtosis has no native
# Windows build -- its releases ship Linux and Darwin binaries only -- so on
# Windows this must run in a WSL distro with Docker Desktop's WSL integration
# enabled. See scripts/enable-virtualization.ps1.
#
# The network is 2 beacon nodes + 2 validators + 2 gqrl execution clients.
# The default is the QIP-55 / testnet v3 image set (64-byte addresses,
# IMAGE_TAG=v3, pulled from the registry); IMAGE_TAG=main is the 20-byte v2
# rollback, and on THAT set the consensus client must be built locally first
# -- the published qrledger qrysm images are a year stale and cannot run a
# genesis the v2 generator produces:
#
#   bash scripts/build-qrysm.sh
#   IMAGE_TAG=main #   CL_IMAGE=qrysm-beacon-chain:quantum-ark-local #   VC_IMAGE=qrysm-validator:quantum-ark-local #     bash scripts/kurtosis-up.sh
#
# The deployer address from .env is funded at genesis. Generate it first with
# `npm run gen:deployer` (Q+128 on v3; a 40-hex address is refused below).

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENCLAVE="${ENCLAVE:-quantum-ark}"

# `v3` is the QIP-55 / 64-byte-address image set (testnet v3), the default.
# IMAGE_TAG=main rolls back to the 20-byte v2 set (the qrledger pins below).
IMAGE_TAG="${IMAGE_TAG:-v3}"

# theQRL/qrl-package is the 20-byte v2 package; cyyber's fork carries the
# QIP-55 genesis flow (64-byte deposit contract, prefunded accounts and
# validator constants) and is selected whenever the v3 image set is. Same
# pin as infra/devnet's network-up.sh.
if [ "$IMAGE_TAG" = "main" ]; then
  QRL_PKG="${QRL_PKG:-github.com/theQRL/qrl-package@main}"
else
  QRL_PKG="${QRL_PKG:-github.com/cyyber/qrl-package@514f0835097b60f2485b8a64f62fb6ecf8bae087}"
fi
PARAMS="$ROOT/.kurtosis/network_params.yaml"
GENESIS_BALANCE="${GENESIS_BALANCE:-2000000QRL}"

# The qrl-package default is 60s per slot, which makes a deploy of ~8
# transactions take ~8 minutes because each one waits for its own block.
# 12s matches Ethereum mainnet and is what the nodes are otherwise tuned for.
# Raise it back with SECONDS_PER_SLOT=60 if a slower chain is wanted.
SECONDS_PER_SLOT="${SECONDS_PER_SLOT:-12}"

# Image set per IMAGE_TAG, the same coordinates infra/devnet's images.sh
# resolves. Registry images are multi-arch; override any of these with a tag
# `scripts/build-qrysm.sh` (or infra/devnet's build-images.sh) loaded locally.
REGISTRY="${REGISTRY:-ghcr.io/qrl-ecosystem-by-redzero}"
if [ "$IMAGE_TAG" = "main" ]; then
  # -------------------------------------------------- v2 rollback (20-byte)
  # Pinned to v0.2.1, NOT `stable`. The genesis generator writes the EL genesis
  # block hash into the CL genesis.ssz, and gqrl must compute the same hash from
  # the same genesis.json. `stable` (v0.3.1, 2026-04-08) computes a different one
  # than qrl-genesis-generator-latest (2026-03-12) expects, and the beacon then
  # never leaves optimistic mode, so the chain sits at block 0 forever. v0.2.1 was
  # published the same day as that generator and matches it.
  EL_IMAGE="${EL_IMAGE:-qrledger/go-qrl:v0.2.1}"
  # `latest` (2026-03-12) is the 20-byte generator; its `deposit` tool pairs
  # with EL v0.2.1. The newer `main-linux-amd64` is 64-byte only and rejects
  # every 20-byte address form with `Could not generate new seed: invalid
  # address` -- which is exactly why it is the v3 default below.
  GENESIS_GENERATOR_IMAGE="${GENESIS_GENERATOR_IMAGE:-qrledger/qrysm:qrl-genesis-generator-latest}"
  CL_IMAGE="${CL_IMAGE:-qrledger/qrysm:beacon-chain-latest}"
  VC_IMAGE="${VC_IMAGE:-qrledger/qrysm:validator-latest}"
else
  # ------------------------------------------------ v3 / QIP-55 (64-byte)
  # gqrl is built from go-zond source: QIP-55 merged to main on 2026-06-08 and
  # no qrledger image contains it (qrledger/go-qrl stops at v0.3.1). The CL/VC
  # are built from theQRL/qrysm `dev`, the 64-byte-migration branch. All three
  # are published under :v3 by infra/devnet's push-images.sh.
  EL_IMAGE="${EL_IMAGE:-$REGISTRY/gqrl:$IMAGE_TAG}"
  CL_IMAGE="${CL_IMAGE:-$REGISTRY/qrysm-beacon-chain:$IMAGE_TAG}"
  VC_IMAGE="${VC_IMAGE:-$REGISTRY/qrysm-validator:$IMAGE_TAG}"
  # `main-linux-amd64` (2026-08-22) is the QIP-55 generator: its `deposit`
  # tool takes only 64-byte addresses. amd64-only, as the tag says.
  GENESIS_GENERATOR_IMAGE="${GENESIS_GENERATOR_IMAGE:-qrledger/qrysm:qrl-genesis-generator-main-linux-amd64}"
fi

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- preflight

echo "== preflight"

have docker || die "docker not found.
  In WSL, enable Docker Desktop > Settings > Resources > WSL integration for this distro."
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable.
  Start Docker Desktop and make sure WSL integration is on for this distro."
echo "   docker    $(docker version --format '{{.Server.Version}}')"

if ! have kurtosis; then
  cat >&2 <<'EOF'
error: kurtosis not found. Install it (Debian/Ubuntu):

  echo "deb [trusted=yes] https://apt.fury.io/kurtosis-tech/ /" \
    | sudo tee /etc/apt/sources.list.d/kurtosis.list
  sudo apt update && sudo apt install -y kurtosis-cli
  kurtosis version

Other platforms: https://docs.kurtosis.com/install/
EOF
  exit 1
fi
echo "   kurtosis  $(kurtosis version 2>/dev/null | head -1)"

have yq || die "yq not found. Install it:  sudo snap install yq   (or: sudo apt install -y yq)"

# ------------------------------------------------------------- deployer key

[ -f "$ROOT/.env" ] || die ".env missing. Run:  npm run gen:deployer"

DEPLOYER_ADDRESS="$(sed -nE 's/^[[:space:]]*DEPLOYER_ADDRESS[[:space:]]*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/p' "$ROOT/.env" | head -1)"
[ -n "$DEPLOYER_ADDRESS" ] || die "DEPLOYER_ADDRESS missing from .env. Run:  npm run gen:deployer"
case "$DEPLOYER_ADDRESS" in
  Q*) ;;
  *) die "DEPLOYER_ADDRESS '$DEPLOYER_ADDRESS' is not a Q-prefixed QRL address" ;;
esac
# The v3 image set (QIP-55) funds 64-byte addresses only; a 40-hex address
# here means .env predates the format change. Re-run gen:deployer with the
# v3 library line (@theqrl/web3 1.x) - same mnemonic, extended address.
if [ "$IMAGE_TAG" != "main" ] && [ "${#DEPLOYER_ADDRESS}" -ne 129 ]; then
  die "DEPLOYER_ADDRESS is ${#DEPLOYER_ADDRESS} chars; testnet v3 needs Q+128 hex (64 bytes).
  Run:  npm install && npm run gen:deployer   (the mnemonic is kept)"
fi
echo "   deployer  $DEPLOYER_ADDRESS"

# ------------------------------------------------------------ network params

mkdir -p "$ROOT/.kurtosis"

# The two packages disagree on the type of prefunded_accounts: theQRL's (v2)
# wants a JSON string it parses itself, cyyber's (v3) wants a YAML mapping it
# merges with dict.update - handing it a string dies with
# `Evaluation error: update: got string, want iterable`.
if [ "$IMAGE_TAG" = "main" ]; then
  PREFUNDED_ACCOUNTS="'{\"$DEPLOYER_ADDRESS\": {\"balance\": \"$GENESIS_BALANCE\"}}'"
else
  PREFUNDED_ACCOUNTS="{\"$DEPLOYER_ADDRESS\": {\"balance\": \"$GENESIS_BALANCE\"}}"
fi

cat > "$PARAMS" <<EOF
# Generated by scripts/kurtosis-up.sh -- edits here are overwritten.
#
# Mirrors qrysm/scripts/local_testnet/network_params.yaml, with the deployer
# from .env funded at genesis. Upstream funds accounts whose seeds are 32-byte
# secp256k1 values inherited from the ethereum-package; those cannot be signed
# with on Zond, where accounts are ML-DSA-87 from a 51-byte extended seed.
participants:
  - el_type: gqrl
    el_image: $EL_IMAGE
    cl_type: qrysm
    cl_image: $CL_IMAGE
    # qrysm/scripts/local_testnet/network_params.yaml also passes
    # "--sync-from=head", but the published qrledger/qrysm:beacon-chain-latest
    # image does not define that flag: the beacon node exits immediately with
    # "flag provided but not defined: -sync-from", and Kurtosis then fails the
    # run waiting for port 3500 to open. Upstream's params file is written for a
    # newer qrysm build than the image tag it pins.
    cl_extra_params:
      - "--min-sync-peers=0"
      - "--minimum-peers-per-subnet=0"
    vc_type: qrysm
    vc_image: $VC_IMAGE
    count: 2
network_params:
  preset: "mainnet"
  prefunded_accounts: $PREFUNDED_ACCOUNTS
  light_kdf_enabled: True
  seconds_per_slot: $SECONDS_PER_SLOT
additional_services: []
qrl_genesis_generator_params:
  image: $GENESIS_GENERATOR_IMAGE
EOF
echo "   params    $PARAMS"
echo "   slot      ${SECONDS_PER_SLOT}s"
echo "   images    el=$EL_IMAGE"
echo "             cl=$CL_IMAGE"
echo "             vc=$VC_IMAGE"
echo "             genesis=$GENESIS_GENERATOR_IMAGE"

# ------------------------------------------------------------------- launch

echo
echo "== starting enclave '$ENCLAVE' (first run pulls images, this takes a while)"
kurtosis enclave rm -f "$ENCLAVE" >/dev/null 2>&1 || true
kurtosis run --enclave "$ENCLAVE" "$QRL_PKG" --args-file "$PARAMS"

# --------------------------------------------------------------- rpc lookup

echo
echo "== resolving the execution-layer RPC endpoint"

# Service names follow el-<index>-<el>-<cl>; take the first execution client.
EL_SERVICE="$(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null \
  | grep -oE '\bel-[0-9]+-[a-z]+-[a-z]+\b' | head -1 || true)"
[ -n "$EL_SERVICE" ] || die "could not find an el-* service in enclave '$ENCLAVE'.
  Inspect it manually:  kurtosis enclave inspect $ENCLAVE"

RPC_URL="$(kurtosis port print "$ENCLAVE" "$EL_SERVICE" rpc 2>/dev/null || true)"
[ -n "$RPC_URL" ] || die "could not read the 'rpc' port of $EL_SERVICE.
  Inspect it manually:  kurtosis enclave inspect $ENCLAVE"
case "$RPC_URL" in
  http*) ;;
  *) RPC_URL="http://$RPC_URL" ;;
esac

echo "   service   $EL_SERVICE"
echo "   rpc       $RPC_URL"

CHAIN_ID_HEX="$(curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"qrl_chainId","params":[],"id":1}' \
  "$RPC_URL" | sed -nE 's/.*"result":"(0x[0-9a-fA-F]+)".*/\1/p' || true)"
if [ -n "$CHAIN_ID_HEX" ]; then
  CHAIN_ID=$((CHAIN_ID_HEX))
  echo "   chainId   $CHAIN_ID"
else
  CHAIN_ID=""
  echo "   chainId   (not answering yet; the chain may still be finalising genesis)"
fi

# ---------------------------------------------------------------- write .env

# Replaces the key in place when present, appends it when not. Kept to sed and
# grep so this works in a bare distro with no python or node on PATH.
upsert_env() {
  local key="$1" line="$2" file="$ROOT/.env"
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${line}|" "$file"
  else
    printf '%s\n' "$line" >> "$file"
  fi
}

upsert_env QRL_RPC_URL "QRL_RPC_URL=\"$RPC_URL\""

# The beacon API, for the delegation checks: a deposit reaches the beacon state
# only after the execution follow distance and a voting period, so
# scripts/delegation-status.js reads it long after `npm run deploy` has exited.
# qrysm serves it under /qrl/v1, not /eth/v1.
CL_SERVICE="$(kurtosis enclave inspect "$ENCLAVE" 2>/dev/null \
  | grep -oE '\bcl-[0-9]+-[a-z]+-[a-z]+\b' | head -1 || true)"
if [ -n "$CL_SERVICE" ]; then
  BEACON_URL="$(kurtosis port print "$ENCLAVE" "$CL_SERVICE" http 2>/dev/null || true)"
  case "$BEACON_URL" in
    http*) ;;
    "") ;;
    *) BEACON_URL="http://$BEACON_URL" ;;
  esac
  [ -n "$BEACON_URL" ] && upsert_env QRL_BEACON_URL "QRL_BEACON_URL=\"$BEACON_URL\"" && echo "   beacon    $BEACON_URL"
fi
[ -n "$CHAIN_ID" ] && upsert_env QRL_CHAIN_ID "QRL_CHAIN_ID=$CHAIN_ID"

echo
echo "== ready"
echo "   .env now points at the private enclave."
echo
echo "   npm run build     # compile with hypc"
echo "   npm run deploy    # deploy + wire roles on this network"
echo
echo "   kurtosis enclave inspect $ENCLAVE     # all services and ports"
echo "   kurtosis service logs $ENCLAVE $EL_SERVICE -f"
echo "   npm run net:down                      # tear it all down"
