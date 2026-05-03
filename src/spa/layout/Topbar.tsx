import { useLocation } from 'react-router-dom'

function titleForPath(pathname: string) {
  if (pathname.startsWith('/dashboard')) return '대시보드'
  if (pathname.startsWith('/source-items')) return '원천 콘텐츠'
  if (pathname.startsWith('/short-ideas')) return '숏폼 아이디어'
  if (pathname.startsWith('/scripts')) return '대본 검수'
  if (pathname.startsWith('/render-jobs')) return '영상 검수'
  if (pathname.startsWith('/publish-jobs')) return '업로드'
  if (pathname.startsWith('/settings/ai-providers')) return 'AI 공급자'
  if (pathname.startsWith('/settings/platform-accounts')) return '계정 연결'
  return '운영 콘솔'
}

export default function Topbar() {
  const location = useLocation()
  const title = titleForPath(location.pathname)

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-zinc-900 bg-zinc-950/80 px-6 backdrop-blur">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-zinc-500">리뉴얼 구현 중</div>
    </header>
  )
}
