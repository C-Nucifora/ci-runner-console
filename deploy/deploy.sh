#!/usr/bin/env bash
# Builds locally and installs onto the control-plane host over SSH.
# Secrets and the environment file must already exist on the target.
set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <ssh-host>}
[[ $# == 1 && "$HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]] || {
  echo 'invalid ssh host' >&2
  exit 1
}
cd "$(dirname "$0")/.."

# Refuse before building, uploading, or changing the installed application.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" 'sudo test -f /etc/ci-runner-console.env'
npm run build
STAGE=$(mktemp -d)
REMOTE_STAGE=''
cleanup() {
  rm -rf -- "$STAGE"
  if [[ -n "$REMOTE_STAGE" ]]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" "rm -rf -- '$REMOTE_STAGE'" || true
  fi
}
trap cleanup EXIT
mkdir -p "$STAGE/web"
cp -r dist "$STAGE/dist"
cp -r web/dist "$STAGE/web/dist"
cp package.json package-lock.json deploy/ci-runner-console.service "$STAGE/"
REMOTE_STAGE=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" 'mktemp -d /tmp/crc-stage.XXXXXXXXXX')
[[ "$REMOTE_STAGE" =~ ^/tmp/crc-stage\.[a-zA-Z0-9]{10}$ ]] || {
  REMOTE_STAGE=''
  echo 'unexpected remote staging path' >&2
  exit 1
}
tar -C "$STAGE" -czf - . | ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" "tar -C '$REMOTE_STAGE' -xzf -"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "$HOST" "sudo bash -s -- '$REMOTE_STAGE'" <<'REMOTE'
set -euo pipefail
STAGE=$1
APP_DIR=/opt/ci-runner-console
SERVICE_USER=ciconsole
test -f /etc/ci-runner-console.env
id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
# Code is root-owned. Only the audit directory is writable by the service.
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 /var/lib/ci-runner-console
install -d -o root -g "$SERVICE_USER" -m 0750 /etc/ci-runner-console
systemctl stop ci-runner-console.service || { ! systemctl cat ci-runner-console.service >/dev/null 2>&1; }
rm -rf -- "$APP_DIR/dist" "$APP_DIR/web"
cp -r "$STAGE/dist" "$APP_DIR/dist"
mkdir -p "$APP_DIR/web"
cp -r "$STAGE/web/dist" "$APP_DIR/web/dist"
cp "$STAGE/package.json" "$STAGE/package-lock.json" "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
install -o root -g root -m 0644 "$STAGE/ci-runner-console.service" \
  /etc/systemd/system/ci-runner-console.service
chown root:root /etc/ci-runner-console.env
chmod 0600 /etc/ci-runner-console.env
systemctl daemon-reload
systemctl enable ci-runner-console.service
systemctl restart ci-runner-console.service
sleep 2
systemctl is-active ci-runner-console.service
REMOTE
