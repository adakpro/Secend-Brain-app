import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/vazirmatn/400.css';
import '@fontsource/vazirmatn/500.css';
import '@fontsource/vazirmatn/600.css';
import '@fontsource/vazirmatn/700.css';
import '@fontsource/vazirmatn/800.css';
import './styles/reference.css';
import './styles/app.css';
import { RequireSession } from './session';
import { AppShell } from './components/shell';
import { LoadingState } from './components/ui';
import { ApiError } from './lib/api';
import LoginPage from './pages/login';
import HomePage from './pages/home';

const InboxPage = lazy(() => import('./pages/inbox'));
const SourcePage = lazy(() => import('./pages/source'));
const LibraryPage = lazy(() => import('./pages/library'));
const DocumentPage = lazy(() => import('./pages/document'));
const AskPage = lazy(() => import('./pages/ask'));
const ProjectsPage = lazy(() => import('./pages/projects'));
const ProjectPage = lazy(() => import('./pages/project'));
const ReviewPage = lazy(() => import('./pages/review'));
const ChangeSetPage = lazy(() => import('./pages/changeset'));
const GraphPage = lazy(() => import('./pages/graph'));
const StudioPage = lazy(() => import('./pages/studio'));
const LearnPage = lazy(() => import('./pages/learn'));
const ActivityPage = lazy(() => import('./pages/activity'));
const SettingsPage = lazy(() => import('./pages/settings'));
const ClaudeIntegrationPage = lazy(() => import('./pages/integrations-claude'));
const UsersPage = lazy(() => import('./pages/admin-users'));
const BackupsPage = lazy(() => import('./pages/admin-backups'));
const AuditPage = lazy(() => import('./pages/admin-audit'));
const TransferPage = lazy(() => import('./pages/transfer'));

const qc = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true, staleTime: 5_000 } } });
const L = (el: React.ReactNode) => <Suspense fallback={<LoadingState />}>{el}</Suspense>;

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/', element: <RequireSession><AppShell /></RequireSession>,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'home', element: <HomePage /> },
      { path: 'inbox', element: L(<InboxPage />) },
      { path: 'inbox/:id', element: L(<SourcePage />) },
      { path: 'library', element: L(<LibraryPage />) },
      { path: 'library/:id', element: L(<DocumentPage />) },
      { path: 'ask', element: L(<AskPage />) },
      { path: 'ask/:id', element: L(<AskPage />) },
      { path: 'projects', element: L(<ProjectsPage />) },
      { path: 'projects/:id', element: L(<ProjectPage />) },
      { path: 'review', element: L(<ReviewPage />) },
      { path: 'review/:id', element: L(<ChangeSetPage />) },
      { path: 'graph', element: L(<GraphPage />) },
      { path: 'studio', element: L(<StudioPage />) },
      { path: 'studio/:id', element: L(<StudioPage />) },
      { path: 'learn', element: L(<LearnPage />) },
      { path: 'activity', element: L(<ActivityPage />) },
      { path: 'settings', element: L(<SettingsPage />) },
      { path: 'settings/:section', element: L(<SettingsPage />) },
      { path: 'settings/integrations/claude', element: L(<ClaudeIntegrationPage />) },
      { path: 'admin/users', element: L(<UsersPage />) },
      { path: 'admin/integrations/claude', element: <Navigate to="/settings/integrations/claude" replace /> },
      { path: 'admin/backups', element: L(<BackupsPage />) },
      { path: 'admin/audit', element: L(<AuditPage />) },
      { path: 'transfer', element: L(<TransferPage />) },
      { path: '*', element: <Navigate to="/home" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
