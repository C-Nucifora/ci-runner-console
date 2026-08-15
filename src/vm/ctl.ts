import { RunnerVm } from './ssh.js';

export interface LocalInstance {
  dir: string;
  name: string;
  unit: string | null;
  registered: boolean;
  serviceInstalled: boolean;
  active: string | null;
  enabled: string | null;
  subState: string | null;
  activeSince: string | null;
  legacy: boolean;
}

export interface Headroom {
  cpus: number;
  load: { one: number; five: number; fifteen: number };
  memory: { totalBytes: number; availableBytes: number };
  disk: { totalBytes: number; freeBytes: number };
  instances: number;
  cap: number;
  remaining: number;
}

/**
 * The complete set of privileged operations this application can perform on the
 * runner VM. There is intentionally no general-purpose "run a command" method:
 * anything not expressible here is not something the control plane can do.
 */
export class RunnerVmControl {
  constructor(private readonly vm: RunnerVm) {}

  async list(): Promise<LocalInstance[]> {
    const res = await this.vm.json<{ instances: LocalInstance[] }>(['list']);
    return res.instances;
  }

  async headroom(): Promise<Headroom> {
    return this.vm.json<Headroom>(['headroom']);
  }

  async logs(name: string, lines = 200): Promise<string[]> {
    const res = await this.vm.json<{ lines: string[] }>(['logs', name, String(lines)]);
    return res.lines;
  }

  async start(name: string) {
    return this.vm.json<{ name: string; unit: string; active: string }>(['start', name]);
  }

  async stop(name: string) {
    return this.vm.json<{ name: string; unit: string; active: string }>(['stop', name]);
  }

  async restart(name: string) {
    return this.vm.json<{ name: string; unit: string; active: string }>(['restart', name]);
  }

  /** `registrationToken` is passed over stdin and is never logged or persisted. */
  async create(args: {
    name: string;
    labels: string[];
    url: string;
    runnerGroup?: string;
    registrationToken: string;
  }) {
    const argv = ['create', args.name, args.labels.join(','), args.url];
    if (args.runnerGroup) argv.push(args.runnerGroup);
    return this.vm.json<{ name: string; dir: string; unit: string; active: string }>(
      argv,
      args.registrationToken,
    );
  }

  /** `removeToken` is passed over stdin and is never logged or persisted. */
  async remove(name: string, removeToken: string) {
    return this.vm.json<{ name: string; deregisteredLocally: boolean }>(
      ['remove', name],
      removeToken,
    );
  }
}
