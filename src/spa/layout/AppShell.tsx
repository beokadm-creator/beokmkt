import { ReactNode } from 'react'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

export default function AppShell(props: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-zinc-950 text-zinc-50">
      <div className="flex min-h-full">
        <Sidebar />
        <div className="flex min-h-full flex-1 flex-col">
          <Topbar />
          <main className="flex-1 px-6 py-6">{props.children}</main>
        </div>
      </div>
    </div>
  )
}

