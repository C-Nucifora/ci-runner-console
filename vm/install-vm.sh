#!/bin/bash
# Installs the control-plane allowlist onto a runner VM. Idempotent.
# Run as a user with sudo on the VM; reads the control-plane public key on stdin.

set -euo pipefail

RUNNER_VERSION=${RUNNER_VERSION:-2.336.0}
RUNNER_SHA256=${RUNNER_SHA256:-04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d}
MAX_RUNNERS=${MAX_RUNNERS:-3}
RUNNER_USER=${RUNNER_USER:-runner}

[[ $RUNNER_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
[[ $RUNNER_SHA256 =~ ^[a-fA-F0-9]{64}$ ]] || exit 1
[[ $MAX_RUNNERS =~ ^[1-9][0-9]{0,3}$ ]] || exit 1
[[ $RUNNER_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || exit 1
runner_uid=$(id -u -- "$RUNNER_USER") || exit 1
[[ $runner_uid =~ ^[0-9]+$ && $runner_uid -ne 0 ]] || exit 1
pubkey=$(head -c 16385)
(( ${#pubkey} <= 16384 )) || exit 1
[[ $pubkey != *$'\n'* && $pubkey != *$'\r'* ]] || exit 1
[[ $pubkey =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))\ [A-Za-z0-9+/]+={0,2}(\ [^[:cntrl:]]*)?$ ]] || { echo "stdin must be one SSH public key" >&2; exit 1; }

say() { printf '\n== %s\n' "$1"; }

say "Installing control scripts"
sudo install -o root -g root -m 0755 /tmp/ci-runner-ctl     /usr/local/sbin/ci-runner-ctl
sudo install -o root -g root -m 0755 /tmp/ci-runner-ctl-ssh /usr/local/sbin/ci-runner-ctl-ssh
rm -f /tmp/ci-runner-ctl /tmp/ci-runner-ctl-ssh

say "Writing $MAX_RUNNERS-runner cap to /etc/ci-runner-ctl.conf"
printf 'MAX_RUNNERS=%s\nRUNNER_VERSION=%s\nRUNNER_SHA256=%s\nRUNNER_USER=%s\n' "$MAX_RUNNERS" "$RUNNER_VERSION" "$RUNNER_SHA256" "$RUNNER_USER" | sudo tee /etc/ci-runner-ctl.conf >/dev/null
sudo chmod 0644 /etc/ci-runner-ctl.conf

say "Creating instance and distribution directories"
sudo install -d -o root -g root -m 0755 /opt/runners /opt/runner-dist

say "Staging pinned runner distribution v$RUNNER_VERSION"
dist=/opt/runner-dist/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz
if [[ -r $dist ]] && echo "$RUNNER_SHA256  $dist" | sha256sum -c - >/dev/null 2>&1; then
  echo "already staged and verified"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 -fsSL -o "$tmp/runner.tar.gz" \
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
# Write account-owned SSH files as that account, never as root through a path
# the account can replace with a symlink.
printf '%s\n' "$pubkey" | sudo -u "$RUNNER_USER" -H python3 -c '
import os, pathlib, sys, tempfile
key = sys.stdin.read().strip()
body = key.split()[1]
folder = pathlib.Path.home() / ".ssh"
folder.mkdir(mode=0o700, exist_ok=True)
path = folder / "authorized_keys"
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as f:
        old = f.read()
except FileNotFoundError:
    old = ""
lines = [line for line in old.splitlines() if body not in line.split()]
lines.append("command=\"/usr/local/sbin/ci-runner-ctl-ssh\",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding " + key)
fd, tmp = tempfile.mkstemp(dir=folder)
try:
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
'

say "Verifying"
sudo /usr/local/sbin/ci-runner-ctl headroom
echo
echo "VM install complete."
