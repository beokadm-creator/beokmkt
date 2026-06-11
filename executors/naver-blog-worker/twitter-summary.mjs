import 'dotenv/config'

const AI_API_KEY = process.env.AI_API_KEY || ''
const AI_MODEL = process.env.AI_MODEL || 'glm-5.1'
const AI_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function callAi(messages) {
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.5,
      max_tokens: 500,
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${err}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

async function generateTweetSummary(html, title, link) {
  if (!AI_API_KEY) {
    const text = stripHtmlToText(html)
    const summary = text.slice(0, 200).replace(/\n/g, ' ').trim()
    return `${title}\n\n${summary}...\n\n${link}\n\n#웹개발 #홈페이지제작`
  }

  const text = stripHtmlToText(html)
  const prompt = `다음 블로그 글을 한 줄 요약 + 핵심 포인트로 트윗을 작성하세요.

규칙:
- 280자 이내
- 해시태그 3~5개 포함 (#웹개발 #홈페이지제작 등 관련 태그)
- 마지막에 링크 포함
- 설명이나 따옴표 없이 트윗 텍스트만 출력
- 한국어로 작성

제목: ${title}
링크: ${link}

본문:
${text.slice(0, 3000)}`

  try {
    const messages = [
      { role: 'system', content: '트위터 전문 마케터입니다. 검색에 잘 걸리는 트윗을 작성합니다. 트윗 텍스트만 출력하세요.' },
      { role: 'user', content: prompt },
    ]
    let tweet = await callAi(messages)
    tweet = tweet.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
    tweet = tweet.replace(/^["']|["']$/g, '').trim()
    if (!tweet.includes(link)) {
      tweet = tweet + `\n\n${link}`
    }
    if (tweet.length > 280) {
      const linkPart = `\n\n${link}`
      const maxBody = 280 - linkPart.length
      tweet = tweet.slice(0, maxBody) + linkPart
    }
    return tweet
  } catch (e) {
    console.error(`[twitter-summary] AI 실패: ${e.message}`)
    return `${title}\n\n${link}\n\n#웹개발 #홈페이지제작`
  }
}

export { generateTweetSummary }
