import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const provider = searchParams.get('provider')
    const apiKey = searchParams.get('apiKey')

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: 'Provider and API key are required' },
        { status: 400 }
      )
    }

    let isValid = false
    let errorDetails = ''

    try {
      let response: Response

      switch (provider) {
        case 'openai':
          try {
            // OpenAI API 연결 테스트 - 가장 간단한 models 엔드포인트 사용
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000) // 5초 타임아웃으로 감소

            response = await fetch('https://api.openai.com/v1/models', {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
              },
              signal: controller.signal
            })

            clearTimeout(timeoutId)

            if (response.ok) {
              const data = await response.json()
              isValid = true
              errorDetails = `API 연결 성공 - ${data.object || 'models'}`
            } else {
              isValid = false
              const errorData = await response.json().catch(() => null)
              errorDetails = errorData?.error?.message || `HTTP ${response.status}`
            }
          } catch (openaiError) {
            isValid = false
            if (openaiError instanceof Error) {
              if (openaiError.name === 'AbortError') {
                errorDetails = 'OpenAI API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `OpenAI API 오류: ${openaiError.message}`
              }
            } else {
              errorDetails = 'OpenAI API 연결 실패'
            }
          }
          break

        case 'gemini':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000) // 5초 타임아웃

            // Gemini API 연결 테스트 - 실제 존재하는 모델들만 시도
            const models = [
              'gemini-2.0-flash-exp',        // 최신 모델 (실험적)
              'gemini-1.5-flash-latest',     // 최신 Flash
              'gemini-1.5-flash',            // 안정적인 Flash
              'gemini-1.5-pro-latest',       // 최신 Pro
              'gemini-1.5-pro-001',          // 특정 버전 Pro
              'gemini-pro',                  // 기본 Pro
              'gemini-flash'                 // 기본 Flash
            ]

            for (const model of models) {
              try {
                response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text: 'hi' }] }]
                  }),
                  signal: controller.signal
                })

                if (response.ok) {
                  clearTimeout(timeoutId)
                  const data = await response.json()
                  isValid = true
                  errorDetails = `Gemini API 연결 성공 (${model})`
                  break
                } else {
                  // 404 에러는 모델이 없는 것이므로 다음 모델 시도
                  if (response.status === 404) {
                    continue
                  }
                }
              } catch (modelError) {
                continue
              }
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = 'Gemini API: 모든 모델 시도 실패 (모델 이름이 변경되었을 수 있음)'
            }
          } catch (geminiError) {
            isValid = false
            if (geminiError instanceof Error) {
              if (geminiError.name === 'AbortError') {
                errorDetails = 'Gemini API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `Gemini API 오류: ${geminiError.message}`
              }
            } else {
              errorDetails = 'Gemini API 연결 실패'
            }
          }
          break

        case 'zhipu':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000) // 5초 타임아웃

            // Zhipu GLM API 연결 테스트 - 실제 존재하는 모델들만 시도
            const models = [
              'glm-4-flash',       // 최신 Flash 모델
              'glm-4-air',         // Air 모델
              'glm-4-0520',        // 특정 버전
              'glm-4',             // 기본 GLM-4
              'glm-3-turbo',       // Turbo 모델
              'chatglm3-6b'        // ChatGLM3
            ]

            let lastError = ''

            for (const model of models) {
              try {
                response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                  },
                  body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 10
                  }),
                  signal: controller.signal
                })

                if (response.ok) {
                  clearTimeout(timeoutId)
                  isValid = true
                  errorDetails = `Zhipu API 연결 성공 (${model} 모델)`
                  break
                } else {
                  const errorData = await response.json().catch(() => null)
                  lastError = errorData?.error?.message || `HTTP ${response.status}`

                  // 1211 에러는 모델이 없는 것이므로 다음 모델 시도
                  if (errorData?.error?.code === '1211') {
                    continue
                  }
                }
              } catch (modelError) {
                lastError = modelError instanceof Error ? modelError.message : 'Unknown error'
                continue
              }
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = `Zhipu API 실패: ${lastError} (모든 모델 시도 실패)`
            }
          } catch (zhipuError) {
            isValid = false
            if (zhipuError instanceof Error) {
              if (zhipuError.name === 'AbortError') {
                errorDetails = 'Zhipu API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `Zhipu API 오류: ${zhipuError.message}`
              }
            } else {
              errorDetails = 'Zhipu API 연결 실패'
            }
          }
          break

        case 'zai':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000) // 5초 타임아웃

            // Z.ai는 다른 엔드포인트일 수 있음
            const endpoints = [
              {
                url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                models: ['glm-4-flash', 'glm-4-air', 'glm-4-0520', 'glm-4', 'glm-3-turbo']
              },
              {
                // Z.ai 전용 엔드포인트가 있을 수 있음
                url: 'https://api.z.ai/v1/chat/completions',
                models: ['glm-4-flash', 'glm-4-air', 'glm-4']
              }
            ]

            let lastError = ''

            for (const endpoint of endpoints) {
              for (const model of endpoint.models) {
                try {
                  response = await fetch(endpoint.url, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                      model: model,
                      messages: [{ role: 'user', content: 'hi' }],
                      max_tokens: 10
                    }),
                    signal: controller.signal
                  })

                  if (response.ok) {
                    clearTimeout(timeoutId)
                    isValid = true
                    errorDetails = `Z.ai API 연결 성공 (${model} 모델 - ${endpoint.url})`
                    break
                  } else {
                    const errorData = await response.json().catch(() => null)
                    lastError = errorData?.error?.message || `HTTP ${response.status}`

                    // 1211 에러는 모델이 없는 것이므로 다음 모델 시도
                    if (errorData?.error?.code === '1211') {
                      continue
                    }
                  }
                } catch (modelError) {
                  // 네트워크 에러는 엔드포인트가 잘못된 것일 수 있음
                  lastError = modelError instanceof Error ? modelError.message : 'Unknown error'
                  continue
                }
              }

              if (isValid) break
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = `Z.ai API 실패: ${lastError} (모든 엔드포인트와 모델 시도 실패)`
            }
          } catch (zaiError) {
            isValid = false
            if (zaiError instanceof Error) {
              if (zaiError.name === 'AbortError') {
                errorDetails = 'Z.ai API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `Z.ai API 오류: ${zaiError.message}`
              }
            } else {
              errorDetails = 'Z.ai API 연결 실패'
            }
          }
          break

        case 'anthropic':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000)

            // Anthropic Claude API - 최신 모델들 시도
            const models = [
              'claude-3-5-sonnet-20241022',  // 최신 Sonnet
              'claude-3-5-haiku-20241022',   // 최신 Haiku
              'claude-3-haiku-20240307',      // 이전 Haiku
              'claude-3-sonnet-20240229'      // 이전 Sonnet
            ]

            let lastError = ''

            for (const model of models) {
              try {
                const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                  },
                  body: JSON.stringify({
                    model: model,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'hi' }]
                  }),
                  signal: controller.signal
                })

                if (anthropicResponse.ok) {
                  clearTimeout(timeoutId)
                  isValid = true
                  errorDetails = `Anthropic Claude API 연결 성공 (${model})`
                  break
                } else {
                  const errorData = await anthropicResponse.json().catch(() => null)
                  lastError = errorData?.error?.message || `HTTP ${anthropicResponse.status}`
                }
              } catch (modelError) {
                lastError = modelError instanceof Error ? modelError.message : 'Unknown error'
                continue
              }
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = `Anthropic API 실패: ${lastError}`
            }
          } catch (anthropicError) {
            isValid = false
            if (anthropicError instanceof Error) {
              if (anthropicError.name === 'AbortError') {
                errorDetails = 'Anthropic API 요청 시간 초과 (10초)'
              } else {
                errorDetails = `Anthropic API 오류: ${anthropicError.message}`
              }
            } else {
              errorDetails = 'Anthropic API 연결 실패'
            }
          }
          break

        case 'cohere':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000)

            // Cohere API - 최신 모델들 시도
            const models = [
              'command-r-plus-08-2024',  // 최신 R+
              'command-r-08-2024',       // 최신 R
              'command',                 // 기본 Command
              'command-light'            // 가벼운 버전
            ]

            let lastError = ''

            for (const model of models) {
              try {
                const cohereResponse = await fetch('https://api.cohere.ai/v1/chat', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                  },
                  body: JSON.stringify({
                    model: model,
                    message: 'hi',
                    max_tokens: 10
                  }),
                  signal: controller.signal
                })

                if (cohereResponse.ok) {
                  clearTimeout(timeoutId)
                  isValid = true
                  errorDetails = `Cohere API 연결 성공 (${model})`
                  break
                } else {
                  const errorData = await cohereResponse.json().catch(() => null)
                  lastError = errorData?.message || `HTTP ${cohereResponse.status}`
                }
              } catch (modelError) {
                lastError = modelError instanceof Error ? modelError.message : 'Unknown error'
                continue
              }
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = `Cohere API 실패: ${lastError}`
            }
          } catch (cohereError) {
            isValid = false
            if (cohereError instanceof Error) {
              if (cohereError.name === 'AbortError') {
                errorDetails = 'Cohere API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `Cohere API 오류: ${cohereError.message}`
              }
            } else {
              errorDetails = 'Cohere API 연결 실패'
            }
          }
          break

        case 'mistral':
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 5000)

            // Mistral AI API - 최신 모델들 시도
            const models = [
              'mistral-large-latest',    // 최신 Large
              'mistral-medium-latest',   // 최신 Medium
              'mistral-small-latest',    // 최신 Small
              'codestral-latest',        // 코드 전용
              'mixtral-8x7b-32768'       // Mixtral
            ]

            let lastError = ''

            for (const model of models) {
              try {
                const mistralResponse = await fetch('https://api.mistral.ai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                  },
                  body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 10
                  }),
                  signal: controller.signal
                })

                if (mistralResponse.ok) {
                  clearTimeout(timeoutId)
                  isValid = true
                  errorDetails = `Mistral AI API 연결 성공 (${model})`
                  break
                } else {
                  const errorData = await mistralResponse.json().catch(() => null)
                  lastError = errorData?.message || `HTTP ${mistralResponse.status}`
                }
              } catch (modelError) {
                lastError = modelError instanceof Error ? modelError.message : 'Unknown error'
                continue
              }
            }

            clearTimeout(timeoutId)

            if (!isValid) {
              errorDetails = `Mistral API 실패: ${lastError}`
            }
          } catch (mistralError) {
            isValid = false
            if (mistralError instanceof Error) {
              if (mistralError.name === 'AbortError') {
                errorDetails = 'Mistral API 요청 시간 초과 (5초)'
              } else {
                errorDetails = `Mistral API 오류: ${mistralError.message}`
              }
            } else {
              errorDetails = 'Mistral API 연결 실패'
            }
          }
          break

        default:
          return NextResponse.json(
            { error: 'Unknown provider' },
            { status: 400 }
          )
      }
    } catch (fetchError) {
      isValid = false
      errorDetails = fetchError instanceof Error ? fetchError.message : 'Network error'
    }

    return NextResponse.json({
      valid: isValid,
      details: isValid ? 'API 연결 성공' : errorDetails
    })
  } catch (error) {
    console.error('API key validation error:', error)
    return NextResponse.json(
      {
        valid: false,
        error: 'Validation failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
