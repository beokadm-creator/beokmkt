import { promises as fs } from 'fs'
import path from 'path'

async function pathExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

async function persistSession(context, storagePath) {
  if (!storagePath) return false
  try {
    await ensureDir(storagePath)
    await context.storageState({ path: storagePath })
    return true
  } catch {
    return false
  }
}

async function readJsonIfExists(p) {
  if (!(await pathExists(p))) return null
  try {
    const raw = await fs.readFile(p, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function touchFile(p) {
  if (!(await pathExists(p))) return false
  try {
    const now = new Date()
    await fs.utimes(p, now, now)
    return true
  } catch {
    return false
  }
}

async function snapshotSessionSize(p) {
  try {
    const stat = await fs.stat(p)
    return stat.size
  } catch {
    return 0
  }
}

export { persistSession, readJsonIfExists, touchFile, snapshotSessionSize, pathExists, ensureDir }
