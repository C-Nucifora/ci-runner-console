import { z } from 'zod';
import { RunnerVm, VmError } from './ssh.js';

const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/).refine(name => !name.includes('..'));
const unitSchema = z.string().max(255).regex(/^actions\.runner\.[A-Za-z0-9._-]+\.service$/);
const pathSchema = z.string().max(4096).startsWith('/').refine(path => !/[\x00-\x1f\x7f]/.test(path));
const stateSchema = z.string().min(1).max(128);
const countSchema = z.number().int().nonnegative().safe();
const localSchema = z.object({
  dir: pathSchema, name: nameSchema, unit: unitSchema.nullable(), registered: z.boolean(),
  serviceInstalled: z.boolean(), active: stateSchema.nullable(), enabled: stateSchema.nullable(),
  subState: stateSchema.nullable(), activeSince: z.string().max(256).nullable(), legacy: z.boolean(),
}).refine(instance => !instance.serviceInstalled || instance.unit !== null);
const headroomSchema = z.object({
  cpus: countSchema.positive(),
  load: z.object({ one: z.number().finite().nonnegative(), five: z.number().finite().nonnegative(), fifteen: z.number().finite().nonnegative() }),
  memory: z.object({ totalBytes: countSchema, availableBytes: countSchema }),
  disk: z.object({ totalBytes: countSchema, freeBytes: countSchema }),
  instances: countSchema, cap: countSchema.positive().max(9999), remaining: countSchema,
}).refine(h => h.remaining === Math.max(0, h.cap - h.instances) &&
  h.memory.availableBytes <= h.memory.totalBytes && h.disk.freeBytes <= h.disk.totalBytes);

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

  private async reply<S extends z.ZodTypeAny>(argv: string[], schema: S, secret?: string): Promise<z.infer<S>> {
    const result = schema.safeParse(await this.vm.json<unknown>(argv, secret));
    if (!result.success) throw new VmError('runner VM returned invalid operation data');
    return result.data;
  }

  async list(): Promise<LocalInstance[]> {
    const res = await this.reply(['list'], z.object({ instances: z.array(localSchema).max(10_000) }));
    return res.instances;
  }

  async headroom(): Promise<Headroom> {
    return this.reply(['headroom'], headroomSchema);
  }

  async logs(name: string, lines = 200): Promise<string[]> {
    const res = await this.reply(['logs', name, String(lines)], z.object({ lines: z.array(z.string()).max(lines) }));
    return res.lines;
  }

  async start(name: string) {
    return this.action('start', name);
  }

  async stop(name: string) {
    return this.action('stop', name);
  }

  async restart(name: string) {
    return this.action('restart', name);
  }

  private action(action: string, name: string) {
    return this.reply([action, name], z.object({ name: z.literal(name), unit: unitSchema, active: stateSchema }));
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
    return this.reply(
      argv, z.object({ name: z.literal(args.name), dir: pathSchema, unit: unitSchema, active: stateSchema }),
      args.registrationToken,
    );
  }

  /** `removeToken` is passed over stdin and is never logged or persisted. */
  async remove(name: string, removeToken: string) {
    return this.reply(
      ['remove', name], z.object({ name: z.literal(name), deregisteredLocally: z.boolean() }),
      removeToken,
    );
  }
}
