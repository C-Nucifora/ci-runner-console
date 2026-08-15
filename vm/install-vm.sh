#!/bin/bash
# Installs the control-plane allowlist onto a runner VM. Idempotent.
# Run as a user with sudo on the VM; reads the control-plane public key on stdin.

set -euo pipefail

RUNNER_VERSION=${RUNNER_VERSION:-2.336.0}
RUNNER_SHA256=${RUNNER_SHA256:-04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d}
MAX_RUNNERS=${MAX_RUNNERS:-3}
RUNNER_USER=${RUNNER_USER:-runner}

pubkey=$(cat)
[[ $pubkey == ssh-* || $pubkey == ecdsa-* ]] || { echo "stdin must be an SSH public key" >&2; exit 1; }

say() { printf '\n== %s\n' "$1"; }

say "Installing control scripts"
sudo install -o root -g root -m 0755 /tmp/ci-runner-ctl     /usr/local/sbin/ci-runner-ctl
sudo install -o root -g root -m 0755 /tmp/ci-runner-ctl-ssh /usr/local/sbin/ci-runner-ctl-ssh
rm -f /tmp/ci-runner-ctl /tmp/ci-runner-ctl-ssh

say "Writing $MAX_RUNNERS-runner cap to /etc/ci-runner-ctl.conf"
printf 'MAX_RUNNERS=%s\n' "$MAX_RUNNERS" | sudo tee /etc/ci-runner-ctl.conf >/dev/null
sudo chmod 0644 /etc/ci-runner-ctl.conf

say "Creating instance and distribution directories"
sudo install -d -o root -g root -m 0755 /opt/runners /opt/runner-dist

say "Staging pinned runner distribution v$RUNNER_VERSION"
dist=/opt/runner-dist/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz
if [[ -r $dist ]] && echo "$RUNNER_SHA256  $dist" | sha256sum -c - >/dev/null 2>&1; then
  echo "already staged and verified"
else
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/runner.tar.gz" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  echo "$RUNNER_SHA256  $tmp/runner.tar.gz" | sha256sum -c -
  sudo install -o root -g root -m 0644 "$tmp/runner.tar.gz" "$dist"
  rm -rf "$tmp"
  echo "downloaded and SHA-256 verified"
fi

say "Granting $RUNNER_USER password-less access to ci-runner-ctl only"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/ci-runner-ctl\n' "$RUNNER_USER" \
  | sudo tee /etc/sudoers.d/ci-runner-ctl >/dev/null
sudo chmod 0440 /etc/sudoers.d/ci-runner-ctl
sudo visudo -cf /etc/sudoers.d/ci-runner-ctl

say "Pinning the control-plane key to the forced command"
ak=/home/$RUNNER_USER/.ssh/authorized_keys
keybody=$(awk '{print $2}' <<<"$pubkey")
sudo touch "$ak"
# Drop any previous entry for this key before re-adding, so re-running cannot
# accumulate duplicates or leave an unrestricted copy behind.
sudo grep -vF -- "$keybody" "$ak" | sudo tee "$ak.new" >/dev/null || true
printf 'command="/usr/local/sbin/ci-runner-ctl-ssh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding %s\n' \
  "$pubkey" | sudo tee -a "$ak.new" >/dev/null
sudo install -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0600 "$ak.new" "$ak"
sudo rm -f "$ak.new"

say "Verifying"
sudo /usr/local/sbin/ci-runner-ctl headroom
echo
echo "VM install complete."
