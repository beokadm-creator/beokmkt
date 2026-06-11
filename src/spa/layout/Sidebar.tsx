import { NavLink } from 'react-router-dom'

type NavItem = { to: string; label: string }

function Item(props: NavItem) {
  return (
    <NavLink
      to={props.to}
      end
      className={({ isActive }) =>
        [
          'flex h-10 items-center rounded-lg px-3 text-sm',
          isActive ? 'bg-zinc-800 text-white' : 'text-zinc-300 hover:bg-zinc-900',
        ].join(' ')
      }
    >
      {props.label}
    </NavLink>
  )
}

export default function Sidebar() {
  const main: NavItem[] = [
    { to: '/dashboard', label: '대시보드' },
    { to: '/source-items', label: '원천 콘텐츠' },
    { to: '/blog-posts', label: '블로그 글' },
    { to: '/short-ideas', label: '숏폼 아이디어' },
    { to: '/scripts', label: '대본 검수' },
    { to: '/render-jobs', label: '영상 검수' },
    { to: '/publish-jobs', label: '업로드' },
    { to: '/kaid-insight', label: 'KAID Insight 생성기' },
  ]

  const settings: NavItem[] = [
    { to: '/settings/ai-providers', label: 'AI 공급자' },
    { to: '/settings/platform-accounts', label: '계정 연결' },
  ]

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-900 bg-zinc-950 px-4 py-5">
      <div className="mb-5">
        <div className="text-sm font-semibold">beokmkt</div>
        <div className="text-xs text-zinc-500">운영 콘솔</div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {main.map((x) => (
          <Item key={x.to} {...x} />
        ))}

        <div className="my-3 border-t border-zinc-900" />

        {settings.map((x) => (
          <Item key={x.to} {...x} />
        ))}
      </nav>

      <div className="mt-4 text-xs text-zinc-600">API: /api/*</div>
    </aside>
  )
}
