#!/usr/bin/env bash
#
# Tears down the private QRL Zond enclave, dumping its logs first.
#
# The dump is taken before removal because a Kurtosis enclave is destroyed
# outright -- once it is gone there is nothing left to debug a failed deploy
# against.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENCLAVE="${1:-${ENCLAVE:-quantum-ark}}"
LOGS="$ROOT/.kurtosis/logs/$ENCLAVE"

command -v kurtosis >/dev/null 2>&1 || { echo "kurtosis not found; nothing to do." >&2; exit 0; }

if ! kurtosis enclave inspect "$ENCLAVE" >/dev/null 2>&1; then
  echo "enclave '$ENCLAVE' is not running; nothing to do."
  exit 0
fi

rm -rf "$LOGS" && mkdir -p "$(dirname "$LOGS")"
if kurtosis enclave dump "$ENCLAVE" "$LOGS" >/dev/null 2>&1; then
  echo "logs -> $LOGS"
else
  echo "warning: log dump failed; removing the enclave anyway" >&2
fi

kurtosis enclave rm -f "$ENCLAVE"
kurtosis engine stop >/dev/null 2>&1 || true

echo "enclave '$ENCLAVE' stopped."
echo "note: .env still points at the old RPC port. Re-run 'npm run net:up' before deploying again."
