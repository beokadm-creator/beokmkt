import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import AppShell from './layout/AppShell'
import BlogPostDetailPage from './pages/BlogPostDetailPage'
import BlogPostsPage from './pages/BlogPostsPage'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import PublicBlogPage from './pages/PublicBlogPage'
import PublicBlogPostPage from './pages/PublicBlogPostPage'
import KaidInsightPage from './pages/KaidInsightPage'
import AiProvidersPage from './pages/settings/AiProvidersPage'
import PlatformAccountsPage from './pages/settings/PlatformAccountsPage'
import { useAuth } from './lib/auth'

function RequireAuth() {
  const auth = useAuth()
  const location = useLocation()
  if (!auth.isReady) return <div className="px-6 py-6 text-sm text-zinc-500">로딩 중…</div>
  if (!auth.user) return <Navigate to={`/login?from=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (!auth.isAdmin) return <Navigate to="/login" replace />
  return <Outlet />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/blog/" replace />} />
      <Route path="/blog" element={<PublicBlogPage />} />
      <Route path="/blog/:slug" element={<PublicBlogPostPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route
          element={
            <AppShell>
              <Outlet />
            </AppShell>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/blog-posts" element={<BlogPostsPage />} />
          <Route path="/blog-posts/:id" element={<BlogPostDetailPage />} />
          <Route path="/kaid-insight" element={<KaidInsightPage />} />
          <Route path="/settings/ai-providers" element={<AiProvidersPage />} />
          <Route path="/settings/platform-accounts" element={<PlatformAccountsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
