import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router';
import { api, setCsrf, setWorkspace, ApiError } from './lib/api';
import { setPrefs, type Prefs } from './lib/format';
import { LoadingState, ErrorState } from './components/ui';

export interface Me {
  user: { id: string; email: string; displayName: string; isInstallationOwner: boolean; totpEnabled: boolean; isAdmin: boolean };
  csrfToken: string; stepUpValidUntil: string | null;
  preferences: Prefs & { recentDocumentIds: string[] };
  workspaces: { id: string; slug: string; name: string; role: 'owner' | 'admin' | 'member' | 'viewer'; isDemo: boolean }[];
  activeWorkspaceId: string | null; profile: string; providerMode: 'anthropic' | 'mock';
}

const Ctx = createContext<Me | null>(null);
export const useMe = () => { const m = useContext(Ctx); if (!m) throw new Error('no session'); return m; };
export const useWorkspace = () => { const me = useMe(); return me.workspaces.find(w => w.id === me.activeWorkspaceId) ?? me.workspaces[0]; };
export const canEdit = (role: string) => role === 'owner' || role === 'admin' || role === 'member';

export function applyTheme(theme: Prefs['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('sb-theme', theme); } catch { /* storage may be blocked */ }
}

export function useMeQuery() {
  return useQuery<Me>({
    queryKey: ['me'], retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2, staleTime: 30_000,
    queryFn: async () => {
      const me = await api<Me>('/me');
      setCsrf(me.csrfToken);
      if (me.activeWorkspaceId) setWorkspace(me.activeWorkspaceId);
      setPrefs(me.preferences);
      return me;
    },
  });
}

export function RequireSession({ children }: { children: ReactNode }) {
  const q = useMeQuery();
  const loc = useLocation();
  const qc = useQueryClient();
  useEffect(() => { if (q.data) { applyTheme(q.data.preferences.theme); document.documentElement.lang = q.data.preferences.locale; document.documentElement.dir = q.data.preferences.locale === 'fa' ? 'rtl' : 'ltr'; } }, [q.data]);
  useEffect(() => {
    // Any 401 later (expired/revoked session) sends the user back to login.
    const h = (e: PromiseRejectionEvent) => { if (e.reason instanceof ApiError && e.reason.status === 401) qc.invalidateQueries({ queryKey: ['me'] }); };
    window.addEventListener('unhandledrejection', h);
    return () => window.removeEventListener('unhandledrejection', h);
  }, [qc]);
  if (q.isPending) return <div style={{ padding: 40 }}><LoadingState /></div>;
  if (q.error instanceof ApiError && q.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (q.error) return <div style={{ padding: 40 }}><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  return <Ctx.Provider value={q.data}>{children}</Ctx.Provider>;
}
