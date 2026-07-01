// notebook-return Firestore articles 컬렉션에 글 1건을 기록한다.
// 사용법: node publish_article.mjs <payload.json 경로>
// payload.json 필드: slug, title, metaDesc, bodyHtml, body, tags, relatedProductIds, contentType
import { readFileSync } from 'fs'
import { FieldValue } from 'firebase-admin/firestore'
import { getNotebookReturnDb, failSkip, failFatal } from './firestore_common.mjs'

const COLLECTION = process.env.NOTEBOOK_RETURN_ARTICLES_COLLECTION || 'articles'
const payloadPath = process.argv[2]

if (!payloadPath) {
  failFatal('payload.json 경로가 필요합니다')
}

async function main() {
  let payload
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf-8'))
  } catch (e) {
    failFatal(`payload 읽기 실패: ${e?.message || e}`)
    return
  }

  const slug = String(payload.slug || '').trim()
  if (!slug) {
    failFatal('slug가 비어 있습니다')
    return
  }

  let db
  try {
    db = getNotebookReturnDb()
  } catch (e) {
    failSkip(`Firestore 초기화 실패: ${e?.message || e}`)
    return
  }

  const doc = {
    slug,
    title: payload.title || '',
    metaDesc: payload.metaDesc || '',
    bodyHtml: payload.bodyHtml || '',
    body: payload.body || '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    relatedProductIds: Array.isArray(payload.relatedProductIds) ? payload.relatedProductIds : [],
    contentType: payload.contentType || 'howto',
    source: 'blog_publisher',
    updatedAt: FieldValue.serverTimestamp(),
  }

  try {
    const ref = db.collection(COLLECTION).doc(slug)
    const existing = await ref.get()
    if (!existing.exists) {
      doc.createdAt = FieldValue.serverTimestamp()
    }
    await ref.set(doc, { merge: true })
  } catch (e) {
    const msg = String(e?.message || e)
    if (/credential|default credentials|UNAUTHENTICATED|PERMISSION_DENIED|getApplicationDefault/i.test(msg)) {
      failSkip(`Firestore 쓰기 권한/자격증명 문제: ${msg}`)
      return
    }
    failFatal(`Firestore 쓰기 실패: ${msg}`)
    return
  }

  console.log(JSON.stringify({ ok: true, slug }))
}

main().catch((e) => failFatal(`예상 못한 오류: ${e?.message || e}`))
