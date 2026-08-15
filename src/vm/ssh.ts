import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Client } from 'ssh2';
import type { Config } from '../config.js';

export interface CtlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class VmError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'VmError';
  }
}

/**
 * Speaks the one protocol the runner VM's forced command understands.
 *
 * The key used here is pinned in the VM's authorized_keys to
 * `/usr/local/sbin/ci-runner-ctl-ssh`, so it cannot open a shell or run anything
 * outside the allowlist even if this process is fully compromised. This class is
 * therefore not the security boundary — it is the client of one.
 */
export class RunnerVm {
  readonly #privateKey: Buffer;
  readonly #expectedHostKey: Buffer;

  constructor(private readonly cfg: Config['vm']) {
    this.#privateKey = readFileSync(cfg.privateKeyPath);
    const parts = cfg.hostKey.trim().split(/\s+/);
    const base64 = parts.length > 1 ? parts[1]! : parts[0]!;
    this.#expectedHostKey = Buffer.from(base64, 'base64');
    if (this.#expectedHostKey.length === 0) {
      throw new Error('RUNNER_VM_HOST_KEY did not parse as a base64 SSH host key');
    }
  }

  /**
   * Runs one allowlisted operation.
   *
   * `argv` is sent as a base64 JSON array rather than a shell string, so there is
   * no quoting or word-splitting for a caller to abuse. `stdinSecret` (a short-lived
   * GitHub token) is written to the remote stdin so it never appears in the command
   * line, in this host's process table, or in the VM's.
   */
  async run(argv: string[], stdinSecret?: string): Promise<CtlResult> {
    if (argv.length === 0) throw new VmError('no operation given');
    const payload = Buffer.from(JSON.stringify(argv), 'utf8').toString('base64');

    return new Promise<CtlResult>((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(commandTimer);
        try {
          conn.end();
        } catch {
          /* already closing */
        }
        fn();
      };

      const commandTimer = setTimeout(() => {
        finish(() => reject(new VmError('runner VM operation timed out')));
      }, this.cfg.commandTimeoutMs);

      conn.on('ready', () => {
        conn.exec(payload, (err, stream) => {
          if (err) return finish(() => reject(new VmError(`exec failed: ${err.message}`)));

          let stdout = '';
          let stderr = '';
          let code = 0;

          stream.on('close', (exitCode: number | null) => {
            code = exitCode ?? 0;
            finish(() => resolve({ code, stdout, stderr }));
          });
          stream.on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          });
          stream.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });

          if (stdinSecret !== undefined) {
            stream.write(`${stdinSecret}\n`);
          }
          stream.end();
        });
      });

      conn.on('error', (err) => {
        finish(() => reject(new VmError(`runner VM connection failed: ${err.message}`)));
      });

      conn.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.user,
        privateKey: this.#privateKey,
        readyTimeout: this.cfg.connectTimeoutMs,
        // The runner VM shares a flat LAN with everything else and the control plane
        // does not own that network, so the host key is pinned rather than trusted
        // on first use.
        hostVerifier: (key: Buffer) =>
          key.length === this.#expectedHostKey.length &&
          timingSafeEqual(key, this.#expectedHostKey),
        // Nothing here should ever need an interactive prompt.
        tryKeyboard: false,
      });
    });
  }

  /** Runs an operation and parses its JSON reply, turning `{ok:false}` into an error. */
  async json<T>(argv: string[], stdinSecret?: string): Promise<T> {
    const { code, stdout, stderr } = await this.run(argv, stdinSecret);
    const trimmed = stdout.trim();

    let parsed: unknown;
    if (trimmed) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
    }

    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      const body = parsed as { ok: boolean; error?: string };
      if (body.ok) return parsed as T;
      throw new VmError(body.error ?? 'runner VM rejected the operation', stderr);
    }

    // The forced command exits 42 when it refuses a request outright.
    if (code === 42) {
      throw new VmError(
        firstJsonError(stderr) ?? 'the runner VM refused this operation',
        stderr,
      );
    }
    throw new VmError(
      `unexpected reply from runner VM (exit ${code})`,
      stderr || trimmed,
    );
  }
}

function firstJsonError(stderr: string): string | undefined {
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(t) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* not the line we want */
    }
  }
  return undefined;
}
