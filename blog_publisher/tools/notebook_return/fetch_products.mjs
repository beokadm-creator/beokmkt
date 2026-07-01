// 근거 수집용: notebook-return Firestore products 컬렉션에서 topic과 관련된
// 실제 상품을 찾아 JSON으로 출력한다.
// 사용법: node fetch_products.mjs "<topic 또는 키워드>" [limit]
import { getNotebookReturnDb, failSkip, failFatal } from './firestore_common.mjs'

const COLLECTION = process.env.NOTEBOOK_RETURN_PRODUCTS_COLLECTION || 'products'
const topic = process.argv[2] || ''
const limit = Number(process.argv[3]) || 8

// topic에서 실제 브랜드/등급 키워드만 추출해 매칭에 쓴다(조사/불용어가 섞인
// 자연어 topic 전체를 그대로 매칭하면 거의 매칭되지 않는다).
const BRAND_TERMS = ['삼성', '갤럭시북', '그램', 'LG', 'HP', '레노버', 'Lenovo', '씽크패드']
const GRADE_TERMS = ['최상', '중고', '리퍼', '반품']

function extractTerms(text) {
  const hits = [...BRAND_TERMS, ...GRADE_TERMS].filter((t) => text.includes(t))
  return hits.length ? hits : null
}

async function main() {
  let db
  try {
    db = getNotebookReturnDb()
  } catch (e) {
    failSkip(`Firestore 초기화 실패: ${e?.message || e}`)
    return
  }

  let snap
  try {
    snap = await db.collection(COLLECTION)
      .orderBy('crawledAt', 'desc')
      .limit(300)
      .get()
  } catch (e) {
    failSkip(`products 조회 실패: ${e?.message || e}`)
    return
  }

  const terms = extractTerms(topic)
  const matched = []
  const all = []
  snap.forEach((doc) => {
    const d = doc.data()
    const title = String(d.title || '')
    const row = {
      productId: doc.id,
      title,
      price: d.price ?? null,
      returnGrade: d.returnGrade ?? null,
      returnCount: d.returnCount ?? null,
      returnMinPrice: d.returnMinPrice ?? null,
      isRocket: Boolean(d.isRocket),
      affiliateUrl: d.affiliateUrl || d.url || '',
      thumbnail: d.thumbnail || (Array.isArray(d.images) ? d.images[0] : '') || '',
    }
    all.push(row)
    if (terms && terms.some((t) => title.includes(t))) matched.push(row)
  })

  // 브랜드/등급 용어가 topic에 있어도 실제 제목과 매칭되는 상품이 없을 수 있다
  // (예: "반품 노트북 로켓배송" 처럼 일반론적인 topic). 그런 경우 빈 근거를
  // 반환하는 대신 최신 상품 샘플로 폴백해 grounding 근거가 항상 존재하게 한다.
  const rows = matched.length ? matched : all
  console.log(JSON.stringify({ ok: true, count: rows.length, matched: matched.length > 0, products: rows.slice(0, limit) }))
}

main().catch((e) => failFatal(`예상 못한 오류: ${e?.message || e}`))
