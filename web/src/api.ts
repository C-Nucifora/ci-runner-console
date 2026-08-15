import type { AuditEntry, HealthCheck, Inventory, Me, SettingsGroup } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    // The session expired behind the user's back; bounce through Authentik again.
    window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError('Signed out', 401);
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    throw new ApiError(
      typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
      res.status,
      typeof body.hint === 'string' ? body.hint : undefined,
    );
  }
  return body as T;
}

export const api = {
  me: () => request<Me>('/api/me'),
  inventory: () => request<Inventory>('/api/inventory'),
  audit: (limit = 100) => request<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),
  health: () => request<{ checks: HealthCheck[] }>('/api/health'),
  settings: () => request<{ groups: SettingsGroup[] }>('/api/settings'),
  logs: (name: string) => request<{ lines: string[] }>(`/api/runners/${encodeURIComponent(name)}/logs`),

  start: (name: string) => request(`/api/runners/${encodeURIComponent(name)}/start`, { method: 'POST' }),
  stop: (name: string) => request(`/api/runners/${encodeURIComponent(name)}/stop`, { method: 'POST' }),
  restart: (name: string) => request(`/api/runners/${encodeURIComponent(name)}/restart`, { method: 'POST' }),

  create: (name: string, labels: string[]) =>
    request<{ confirmedInGitHub: boolean; githubStatus: string }>('/api/runners', {
      method: 'POST',
      body: JSON.stringify({ name, labels }),
    }),

  remove: (name: string) =>
    request<{ steps: string[] }>(`/api/runners/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  logout: () => request<{ endSessionUrl: string | null }>('/auth/logout', { method: 'POST' }),
};
