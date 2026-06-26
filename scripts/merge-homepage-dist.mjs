import { cp, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const homepageDir = path.join(rootDir, 'static/homepage')
const distDir = path.join(rootDir, 'dist')

if (!existsSync(homepageDir)) {
  console.error(`[merge-homepage-dist] missing ${homepageDir}`)
  process.exit(1)
}

if (!existsSync(distDir)) {
  console.error(`[merge-homepage-dist] missing ${distDir}; run vite build first`)
  process.exit(1)
}

await stat(path.join(homepageDir, 'index.html'))
await cp(homepageDir, distDir, {
  recursive: true,
  force: true,
  errorOnExist: false,
})

console.log(`[merge-homepage-dist] merged ${homepageDir} → ${distDir}`)
