#!/usr/bin/env bash
# Builds locally and installs onto the control-plane host over SSH.
#
# Usage: deploy/deploy.sh <ssh-host>
# The environment file and SSH key must already exist on the host; this script
# never transmits secrets and never overwrites /etc/ci-runner-console.env.

set -euo pipefail

HOST=${1:?usage: deploy/deploy.sh <ssh-host>}
APP_DIR=/opt/ci-runner-console
SERVICE_USER=ciconsole

cd "$(dirname "$0")/.."

echo "== Building"
npm run build

echo "== Staging"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/web"
cp -r dist "$STAGE/dist"
cp -r web/dist "$STAGE/web/dist"
cp package.json package-lock.json "$STAGE/"

echo "== Uploading"
ssh "$HOST" "rm -rf /tmp/crc-stage && mkdir -p /tmp/crc-stage"
tar -C "$STAGE" -czf - . | ssh "$HOST" "tar -C /tmp/crc-stage -xzf -"
scp -q deploy/ci-runner-console.service "$HOST:/tmp/crc-stage/ci-runner-console.service"

echo "== Installing"
ssh "$HOST" "sudo bash -s" <<REMOTE
set -euo pipefail

id -u $SERVICE_USER >/dev/null 2>&1 || \
  useradd --system --home-dir $APP_DIR --shell /usr/sbin/nologin $SERVICE_USER

install -d -o $SERVICE_USER -g $SERVICE_USER -m 0750 $APP_DIR
install -d -o $SERVICE_USER -g $SERVICE_USER -m 0700 /var/lib/ci-runner-console
install -d -o root -g $SERVICE_USER -m 0750 /etc/ci-runner-console

rm -rf $APP_DIR/dist $APP_DIR/web
cp -r /tmp/crc-stage/dist $APP_DIR/dist
mkdir -p $APP_DIR/web
cp -r /tmp/crc-stage/web/dist $APP_DIR/web/dist
cp /tmp/crc-stage/package.json /tmp/crc-stage/package-lock.json $APP_DIR/

cd $APP_DIR
# Only runtime dependencies land on the host; the build already happened locally.
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null

chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR

install -o root -g root -m 0644 /tmp/crc-stage/ci-runner-console.service \
  /etc/systemd/system/ci-runner-console.service
rm -rf /tmp/crc-stage

if [[ ! -f /etc/ci-runner-console.env ]]; then
  echo "!! /etc/ci-runner-console.env is missing — create it from .env.example (root, 0600)" >&2
  exit 1
fi
chown root:root /etc/ci-runner-console.env
chmod 0600 /etc/ci-runner-console.env

systemctl daemon-reload
systemctl enable ci-runner-console.service
systemctl restart ci-runner-console.service
sleep 2
systemctl is-active ci-runner-console.service
REMOTE

echo "== Deployed"
