import { ReactNode } from 'react'
import Sidebar from './Sidebar'
import Topbar from './Topbar'

export default function AppShell(props: { children: ReactNode }) {
  return (
    <div className="h-screen overflow-hidden bg-zinc-950 text-zinc-50">
      <div className="flex h-full">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />
          <main className="flex-1 overflow-y-auto px-6 py-6">{props.children}</main>
        </div>
      </div>
    </div>
  )
}
