import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRetry } from '../src/lib/http.js'

afterEach(() => vi.unstubAllGlobals())

describe('fetchRetry', () => {
  it('retries once when a reused keep-alive socket was reset', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => {
      if (++n === 1) throw new TypeError('fetch failed: write ECONNRESET')
      return new Response('ok')
    })
    expect(await (await fetchRetry('http://x')).text()).toBe('ok')
    expect(n).toBe(2)
  })
  it('does not retry timeouts or HTTP errors', async () => {
    let n = 0
    vi.stubGlobal('fetch', async () => {
      n++
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    await expect(fetchRetry('http://x')).rejects.toThrow('timed out')
    expect(n).toBe(1)
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }))
    expect((await fetchRetry('http://x')).status).toBe(500)
  })
})
