import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const dataDir = path.resolve(process.cwd(), 'data')
const dbFilePath = path.join(dataDir, 'dev-db.json')

export function nowIso() {
  return new Date().toISOString()
}

export function newId() {
  return randomUUID()
}

function withDefaults(store) {
  return {
    source_items: store.source_items ?? [],
    short_ideas: store.short_ideas ?? [],
    scripts: store.scripts ?? [],
    render_jobs: store.render_jobs ?? [],
    publish_jobs: store.publish_jobs ?? [],
    platform_accounts: store.platform_accounts ?? [],
    approvals: store.approvals ?? [],
    workflow_events: store.workflow_events ?? [],
    audit_logs: store.audit_logs ?? [],
    idempotency: store.idempotency ?? {},
  }
}

export async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true })
  try {
    const raw = await fs.readFile(dbFilePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return withDefaults(parsed)
  } catch {
    const initial = withDefaults({})
    await fs.writeFile(dbFilePath, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }
}

export async function saveStore(store) {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(dbFilePath, JSON.stringify(store, null, 2), 'utf-8')
}

export function getIdempotency(store, key) {
  if (!key) return null
  return store.idempotency[key] ?? null
}

export function setIdempotency(store, key, value) {
  if (!key) return
  store.idempotency[key] = value
}
