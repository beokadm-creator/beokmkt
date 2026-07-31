import { onRequest } from 'firebase-functions/v2/https'

let _handler = null

export const api = onRequest({ timeoutSeconds: 300, memory: '1Gi' }, async (req, res) => {
  if (!_handler) {
    const mod = await import('./app.mjs')
    _handler = mod.default
  }
  return _handler(req, res)
})
