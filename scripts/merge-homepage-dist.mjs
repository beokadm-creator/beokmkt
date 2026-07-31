import { cp, rm, stat } from 'fs/promises'
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

// 홈페이지 merge가 SPA 셸(dist/index.html)을 덮어쓰면 프로덕션에서 관리 콘솔
// (/login, /dashboard 등)이 접근 불가가 된다. 홈페이지를 복사한 뒤 SPA 셸을
// app.html로 복원하고, firebase.json이 admin 경로를 /app.html로 rewrite한다.
const spaShellPath = path.join(distDir, '.spa-shell.html')
await cp(path.join(distDir, 'index.html'), spaShellPath, { force: true })

await cp(homepageDir, distDir, {
  recursive: true,
  force: true,
  errorOnExist: false,
})

await cp(spaShellPath, path.join(distDir, 'app.html'), { force: true })
await rm(spaShellPath, { force: true })

console.log(`[merge-homepage-dist] merged ${homepageDir} → ${distDir} (SPA shell → app.html)`)
