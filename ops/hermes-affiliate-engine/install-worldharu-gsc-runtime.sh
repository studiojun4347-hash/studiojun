#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HERMES_AFFILIATE_INSTALL_DIR:-/opt/hermes-affiliate-engine}"
UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
STATE_DIR="${HERMES_AFFILIATE_STATE_DIR:-/var/lib/hermes-affiliate-engine}"

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 "$STATE_DIR"
install -m 0755 "$SOURCE_DIR/gsc_sync.py" "$INSTALL_DIR/gsc_sync.py"
install -m 0644 \
  "$SOURCE_DIR/systemd/hermes-worldharu-gsc-sync.service" \
  "$UNIT_DIR/hermes-worldharu-gsc-sync.service"
install -m 0644 \
  "$SOURCE_DIR/systemd/hermes-worldharu-gsc-sync.timer" \
  "$UNIT_DIR/hermes-worldharu-gsc-sync.timer"

systemctl daemon-reload
systemctl enable --now hermes-worldharu-gsc-sync.timer

echo "WORLDHARU_GSC_RUNTIME_OK"
