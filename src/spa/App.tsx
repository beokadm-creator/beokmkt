import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import AppShell from './layout/AppShell'
import BlogPostDetailPage from './pages/BlogPostDetailPage'
import BlogPostsPage from './pages/BlogPostsPage'
import DashboardPage from './pages/DashboardPage'
import SourceItemsPage from './pages/SourceItemsPage'
import SourceItemDetailPage from './pages/SourceItemDetailPage'
import ShortIdeasPage from './pages/ShortIdeasPage'
import ShortIdeaDetailPage from './pages/ShortIdeaDetailPage'
import ScriptsPage from './pages/ScriptsPage'
import ScriptDetailPage from './pages/ScriptDetailPage'
import RenderJobsPage from './pages/RenderJobsPage'
import RenderJobDetailPage from './pages/RenderJobDetailPage'
import PublishJobsPage from './pages/PublishJobsPage'
import PublishJobDetailPage from './pages/PublishJobDetailPage'
import LoginPage from './pages/LoginPage'
import AiProvidersPage from './pages/settings/AiProvidersPage'
import PlatformAccountsPage from './pages/settings/PlatformAccountsPage'
import { useAuth } from './lib/auth'

export default function App() {
  const auth = useAuth()
  const location = useLocation()

  function RequireAuth() {
    if (!auth.isReady) return <div className="px-6 py-6 text-sm text-zinc-500">로딩 중…</div>
    if (!auth.user) return <Navigate to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`} replace />
    if (!auth.isAdmin) return <Navigate to="/login" replace />
    return <Outlet />
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route
          element={
            <AppShell>
              <Outlet />
            </AppShell>
          }
        >
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />

          <Route path="/source-items" element={<SourceItemsPage />} />
          <Route path="/source-items/:id" element={<SourceItemDetailPage />} />

          <Route path="/blog-posts" element={<BlogPostsPage />} />
          <Route path="/blog-posts/:id" element={<BlogPostDetailPage />} />

          <Route path="/short-ideas" element={<ShortIdeasPage />} />
          <Route path="/short-ideas/:id" element={<ShortIdeaDetailPage />} />

          <Route path="/scripts" element={<ScriptsPage />} />
          <Route path="/scripts/:id" element={<ScriptDetailPage />} />

          <Route path="/render-jobs" element={<RenderJobsPage />} />
          <Route path="/render-jobs/:id" element={<RenderJobDetailPage />} />

          <Route path="/publish-jobs" element={<PublishJobsPage />} />
          <Route path="/publish-jobs/:id" element={<PublishJobDetailPage />} />

          <Route path="/settings/ai-providers" element={<AiProvidersPage />} />
          <Route path="/settings/platform-accounts" element={<PlatformAccountsPage />} />

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
