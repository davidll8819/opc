import { Agent } from 'undici'

// Separate socket establishment from the caller's existing whole-request deadline.
// No RetryAgent: an accepted generation must never be silently submitted twice.
export const MODEL_TRANSPORT_OPTIONS = Object.freeze({
  connectTimeout: 30000,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
  allowH2: false,
})
export function createModelTransport({ origin = 'https://app.4yi.ai', agentOptions = {}, fetcher = fetch } = {}) {
  const allowed = new URL(origin).origin
  const dispatcher = new Agent({ ...MODEL_TRANSPORT_OPTIONS, ...agentOptions })
  return {
    fetch(url, options = {}) {
      const target = new URL(url)
      if (target.origin !== allowed || target.username || target.password)
        throw new Error('Model transport destination is not allowed')
      return fetcher(target.href, { ...options, dispatcher, redirect: 'error' })
    },
    close: () => dispatcher.close(),
  }
}
