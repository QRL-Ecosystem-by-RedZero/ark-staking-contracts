#!/usr/bin/env bash
#
# Builds the qrysm consensus-client images from source, inside WSL.
#
# WHY THIS IS NEEDED
# ------------------
# theQRL's published qrysm images are a year older than their Kurtosis package.
# `qrledger/qrysm:beacon-chain-latest` (2025-08-08) still uses the `Z` address
# prefix, while `qrl-package@main` and `qrl-genesis-generator-latest` (2026) use
# `Q`. The two cannot be reconciled from config -- see CLAUDE.md section 4.2.
# Building the consensus client from `main` puts it back in step with the
# package.
#
# WHY NOT `bazel build //cmd/beacon-chain:oci_image_tarball`
# ---------------------------------------------------------
# That is what qrysm's own start_local_testnet.sh -b true does, and it cannot
# fetch its toolchain any more: aspect_bazel_lib pins a bsdtar deb URL,
# `libarchive-tools_3.4.0-2ubuntu1.2_amd64.deb`, that Ubuntu has since dropped
# from the archive pool, so the whole loading phase dies on a 404 before a
# single Go file is compiled. Only the OCI packaging path needs it.
#
# So we build the plain `go_binary` targets, which need none of rules_oci,
# rules_distroless or bsdtar, and wrap them in a two-line Dockerfile ourselves.
# The resulting images match the official ones where it matters: the binary sits
# at / and is the entrypoint (`ENTRYPOINT ["/beacon-chain"]`, user 0, workdir /),
# which is the contract qrl-package relies on when it passes flags as the
# container command.
#
#   bash scripts/build-qrysm.sh          # build (first run also installs bazel)
#   bash scripts/build-qrysm.sh --clean  # wipe the checkout and start over
#
# The checkout and bazel cache live in $HOME, NOT under /mnt/f: the Windows
# drive is a 9p mount and a bazel build across it is intolerably slow.

set -Eeuo pipefail

WORK="${QRYSM_DIR:-$HOME/qrysm}"
JOBS="${JOBS:-8}"
TAG="${QRYSM_TAG:-quantum-ark-local}"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

have() { command -v "$1" >/dev/null 2>&1; }

if [ "${1:-}" = "--clean" ]; then
  echo "removing $WORK"
  rm -rf "$WORK"
fi

# --------------------------------------------------------------- toolchain

echo "== toolchain"

if ! have gcc; then
  echo "   installing build-essential..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq build-essential git curl
fi
echo "   gcc      $(gcc -dumpversion)"

# Bazelisk rather than a pinned apt bazel: qrysm carries a .bazelversion
# (8.5.0) and bazelisk fetches exactly that, so the build cannot drift.
if ! have bazel; then
  echo "   installing bazelisk..."
  ARCH="$(dpkg --print-architecture)"
  $SUDO curl -fsSL -o /usr/local/bin/bazel \
    "https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-${ARCH}"
  $SUDO chmod +x /usr/local/bin/bazel
fi
echo "   bazelisk $(command -v bazel)"

have docker || { echo "error: docker not on PATH in this distro" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "error: docker daemon unreachable" >&2; exit 1; }

# ---------------------------------------------------------------- checkout

echo
echo "== source"
if [ -d "$WORK/.git" ]; then
  git -C "$WORK" fetch --depth 1 origin main -q
  git -C "$WORK" reset --hard origin/main -q
  echo "   updated $WORK"
else
  git clone --depth 1 https://github.com/theQRL/qrysm "$WORK" -q
  echo "   cloned  $WORK"
fi
echo "   commit  $(git -C "$WORK" rev-parse --short HEAD)"
echo "   bazel   $(cat "$WORK/.bazelversion" 2>/dev/null || echo '(no .bazelversion)')"

# ------------------------------------------------------------------- build

cd "$WORK"

# WSL routes DNS through a NAT resolver (10.255.255.254) that intermittently
# drops queries when bazel fires its dependency downloads in parallel, which
# surfaces as `Unknown host: github.com` even though curl and git resolve fine.
# Retries and a longer timeout absorb that. --jobs is capped well below nproc
# because this box has 20 cores but only 15GB of RAM and a fully parallel
# Go/bazel link step will OOM before it finishes.
BAZEL_FLAGS=(
  --config=release
  --jobs="$JOBS"
  --experimental_repository_downloader_retries=5
  --http_timeout_scaling=3.0
)

build_binary() {
  local target="$1" label="$2" attempt
  echo
  echo "== building $label (first run has no cache and takes a while)"
  for attempt in 1 2 3; do
    if bazel build "$target" "${BAZEL_FLAGS[@]}"; then
      return 0
    fi
    [ "$attempt" -eq 3 ] && { echo "error: $label failed after 3 attempts" >&2; exit 1; }
    echo "   attempt $attempt failed, retrying..." >&2
    sleep 10
  done
}

build_binary //cmd/beacon-chain:beacon-chain beacon-chain
build_binary //cmd/validator:validator validator

BEACON_BIN="$(bazel cquery --config=release --output=files //cmd/beacon-chain:beacon-chain 2>/dev/null | tail -1)"
VALIDATOR_BIN="$(bazel cquery --config=release --output=files //cmd/validator:validator 2>/dev/null | tail -1)"
[ -f "$BEACON_BIN" ] || { echo "error: beacon-chain binary not found at '$BEACON_BIN'" >&2; exit 1; }
[ -f "$VALIDATOR_BIN" ] || { echo "error: validator binary not found at '$VALIDATOR_BIN'" >&2; exit 1; }

# ----------------------------------------------------------------- package

echo
echo "== packaging images"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

package() {
  local bin="$1" name="$2"
  install -m 0755 "$bin" "$STAGE/$name"
  # Debian slim rather than a distroless base: the binaries are built with cgo
  # (the validator sets pure = "off") and need a libc at runtime.
  cat > "$STAGE/Dockerfile" <<EOF
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
COPY $name /$name
ENTRYPOINT ["/$name"]
EOF
  docker build -q -t "qrysm-$name:$TAG" "$STAGE" >/dev/null
  echo "   built qrysm-$name:$TAG"
}

package "$BEACON_BIN" beacon-chain
package "$VALIDATOR_BIN" validator

# ------------------------------------------------------------------ report

echo
echo "== loaded images"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E "^qrysm-(beacon-chain|validator):$TAG"

echo
echo "== next"
echo "   CL_IMAGE=qrysm-beacon-chain:$TAG VC_IMAGE=qrysm-validator:$TAG bash scripts/kurtosis-up.sh"
