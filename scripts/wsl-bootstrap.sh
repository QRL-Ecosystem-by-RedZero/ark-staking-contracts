#!/usr/bin/env bash
#
# Installs the Linux-side prerequisites for the Kurtosis private network:
# the Kurtosis CLI and yq. Run once, inside the WSL distro.
#
#   cd <this repository, from inside WSL>
#   bash scripts/wsl-bootstrap.sh
#
# Docker itself is NOT installed here. It comes from Docker Desktop on the
# Windows side via WSL integration, which is already enabled for this distro.

set -Eeuo pipefail

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

have() { command -v "$1" >/dev/null 2>&1; }

echo "== checking docker (provided by Docker Desktop WSL integration)"
if ! have docker; then
  echo "error: docker not on PATH inside this distro." >&2
  echo "  Docker Desktop > Settings > Resources > WSL integration -> enable for this distro," >&2
  echo "  then restart the distro:  wsl --shutdown" >&2
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "error: docker daemon unreachable; start Docker Desktop." >&2; exit 1; }
echo "   docker $(docker version --format '{{.Server.Version}}')"

echo
echo "== installing yq"
if have yq; then
  echo "   already present: $(yq --version 2>&1 | head -1)"
else
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq wget
  # The apt package named `yq` is a different tool on some releases; take the
  # upstream mikefarah binary, which is what the qrysm scripts expect.
  ARCH="$(dpkg --print-architecture)"
  $SUDO wget -qO /usr/local/bin/yq \
    "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}"
  $SUDO chmod +x /usr/local/bin/yq
  echo "   installed: $(yq --version 2>&1 | head -1)"
fi

echo
echo "== installing kurtosis"
if have kurtosis; then
  echo "   already present: $(kurtosis version 2>/dev/null | head -1)"
else
  $SUDO apt-get install -y -qq ca-certificates curl gnupg
  echo "deb [trusted=yes] https://apt.fury.io/kurtosis-tech/ /" \
    | $SUDO tee /etc/apt/sources.list.d/kurtosis.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq kurtosis-cli
  echo "   installed: $(kurtosis version 2>/dev/null | head -1)"
fi

echo
echo "== ready"
echo "   next:  bash scripts/kurtosis-up.sh"
