import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './layout/AppShell'
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
import AiProvidersPage from './pages/settings/AiProvidersPage'
import PlatformAccountsPage from './pages/settings/PlatformAccountsPage'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />

        <Route path="/source-items" element={<SourceItemsPage />} />
        <Route path="/source-items/:id" element={<SourceItemDetailPage />} />

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
      </Routes>
    </AppShell>
  )
}
