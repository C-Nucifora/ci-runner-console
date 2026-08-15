import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { ATTENTION_STATES } from './components';
import { RunnersView, type Action } from './RunnersView';
import { SettingsView } from './SettingsView';
import type { Inventory, Me } from './types';

const POLL_MS = 15_000;

type Route = 'runners' | 'settings';

interface Toast {
  id: number;
  tone: 'good' | 'critical' | 'busy';
  message: string;
  hint?: string;
}

function routeFromPath(path: string): Route {
  return path.replace(/\/+$/, '') === '/settings' ? 'settings' : 'runners';
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  const [me, setMe] = useState<Me | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    // Failures stay until dismissed; successes are transient.
    if (t.tone !== 'critical') {
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000);
    }
  }, []);

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    window.history.pushState({}, '', next === 'settings' ? '/settings' : '/');
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setInventory(await api.inventory());
      setFatal(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setFatal(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch(() => undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Runs a mutation, reports it as a toast, and re-reads state either way. */
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, success: string) => {
      setBusy(key);
      try {
        await fn();
        pushToast({ tone: 'good', message: success });
      } catch (err) {
        pushToast({
          tone: 'critical',
          message: err instanceof Error ? err.message : String(err),
          hint: err instanceof ApiError ? err.hint : undefined,
        });
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [pushToast, refresh],
  );

  const attentionCount =
    inventory?.runners.filter((r) => !r.protectedRunner && ATTENTION_STATES.includes(r.state)).length ?? 0;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="mark" data-degraded={attentionCount > 0 || Boolean(fatal)} />
            CI Runners
          </span>
          {inventory ? <span className="target-chip">{inventory.target}</span> : null}

          <nav className="nav" aria-label="Sections">
            <button onClick={() => navigate('runners')} aria-current={route === 'runners' ? 'page' : undefined}>
              Runners
            </button>
            <button onClick={() => navigate('settings')} aria-current={route === 'settings' ? 'page' : undefined}>
              Settings
            </button>
          </nav>

          <div className="whoami">
            <span>{me?.user.name || me?.user.username || '…'}</span>
            <button
              className="link"
              onClick={async () => {
                const { endSessionUrl } = await api.logout();
                window.location.href = endSessionUrl ?? '/';
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main>
        {fatal ? (
          <div className="banner" data-tone="critical" role="alert">
            <span className="glyph" aria-hidden="true">
              ✕
            </span>
            <div className="body">
              <div>
                <strong>Cannot load runner state</strong>
              </div>
              <div className="hint">{fatal}</div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {route === 'runners' ? (
          <RunnersView
            inventory={inventory}
            me={me}
            busy={busy}
            onAction={(name, action: Action) =>
              run(`${action}:${name}`, () => api[action](name), `${name} ${pastTense(action)}.`)
            }
            onDelete={(name) =>
              run(
                `delete:${name}`,
                () => api.remove(name),
                `${name} removed from the VM and deregistered from GitHub.`,
              )
            }
            onCreate={async (name, labels) => {
              await run(
                'create',
                async () => {
                  const res = await api.create(name, labels);
                  if (!res.confirmedInGitHub) {
                    throw new Error(
                      `${name} was created on the VM but has not appeared online in GitHub yet ` +
                        `(status: ${res.githubStatus}). Check its logs before relying on it.`,
                    );
                  }
                },
                `${name} is registered and online in GitHub.`,
              );
            }}
          />
        ) : (
          <SettingsView me={me} />
        )}
      </main>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" data-tone={t.tone} key={t.id}>
            <span aria-hidden="true">{t.tone === 'good' ? '✓' : '✕'}</span>
            <div>
              <div>{t.message}</div>
              {t.hint ? <div className="hint">{t.hint}</div> : null}
            </div>
            <button
              className="close"
              aria-label="Dismiss"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function pastTense(action: Action): string {
  return action === 'stop' ? 'stopped' : `${action}ed`;
}
