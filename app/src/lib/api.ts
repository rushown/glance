import type { ChatSummary, CommandResult, InboxItem, Message, PaymentRequest, Plan, ServerEvent, Settings, Status, WalletInfo } from './types'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

type DemoBackend = import('../demo/backend').DemoBackend
let demoBackend: Promise<DemoBackend> | undefined
/** The in-browser demo backend, loaded only when no server is set. */
const loadDemo = () => (demoBackend ??= import('../demo/backend').then(m => new m.DemoBackend()))

export interface ApiConfig {
  baseUrl: string
  token: string
}

/** Typed client for the Glance server. All calls time out; none hang the UI. */
export class Api {
  constructor(private cfg: ApiConfig) {}

  /** No server set: run on the built-in web demo (sample chats, rule-based AI, in the browser). */
  get demo() {
    return !this.cfg.baseUrl
  }

  get configured() {
    return this.demo || Boolean(this.cfg.baseUrl && this.cfg.token)
  }

  get config(): ApiConfig {
    return { ...this.cfg }
  }

  setConfig(cfg: ApiConfig) {
    this.cfg = { baseUrl: cfg.baseUrl.replace(/\/+$/, ''), token: cfg.token.trim() }
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; raw?: BodyInit } = {}): Promise<T> {
    if (!this.configured) throw new ApiError(0, 'not_configured', 'Server not configured')
    if (this.demo) {
      const res = await (await loadDemo()).handle(method, path, body)
      if (res.status >= 400) throw new ApiError(res.status, String(res.json.error ?? 'error'), String(res.json.message ?? `HTTP ${res.status}`))
      return res.json as T
    }
    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          ...(opts.raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      })
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError'
      throw new ApiError(0, timeout ? 'timeout' : 'network', timeout ? 'Server took too long' : 'Cannot reach server')
    }
    const text = await res.text()
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? `HTTP ${res.status}`))
    return json as T
  }

  status = () => this.req<Status>('GET', '/api/status')
  inbox = (limit = 16) => this.req<{ chats: InboxItem[] }>('GET', `/api/inbox?limit=${limit}`, undefined, { timeoutMs: 30_000 })
  messages = (chatId: string, limit = 14) =>
    this.req<{ chat: InboxItem; messages: Message[] }>('GET', `/api/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`)
  markRead = (chatId: string) => this.req<{ ok: boolean }>('POST', `/api/chats/${encodeURIComponent(chatId)}/read`, {})
  voice = (pcm: Uint8Array, chatId?: string) =>
    this.req<{ transcript: string; result: CommandResult }>('POST', `/api/voice${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`, undefined, {
      raw: new Blob([pcm as BlobPart]),
      timeoutMs: 60_000,
    })
  command = (text: string, chatId?: string) =>
    this.req<{ transcript: string; result: CommandResult }>('POST', '/api/command', { text, chatId }, { timeoutMs: 60_000 })
  execute = (planId: string) => this.req<{ title: string; body: string }>('POST', `/api/plans/${planId}/execute`, {}, { timeoutMs: 45_000 })
  digest = (kind: 'inbox' | 'channels' = 'inbox') => this.req<{ body: string }>('GET', `/api/digest?kind=${kind}`, undefined, { timeoutMs: 75_000 })
  drafts = (chatId: string) => this.req<{ plans: Plan[]; source?: 'model' | 'rules' }>('POST', `/api/chats/${encodeURIComponent(chatId)}/drafts`, {}, { timeoutMs: 30_000 })
  chats = () => this.req<{ chats: ChatSummary[] }>('GET', '/api/chats', undefined, { timeoutMs: 30_000 })
  wallet = () => this.req<WalletInfo>('GET', '/api/wallet')
  payments = () => this.req<{ summary: string; requests: PaymentRequest[] }>('GET', '/api/payments')
  cancelPayment = (id: string) => this.req<{ ok: boolean }>('POST', `/api/payments/${id}/cancel`, {})
  pollPayments = () => this.req<{ matched: number }>('POST', '/api/payments/poll', {})
  demoPaid = (id: string) => this.req<{ ok: boolean }>('POST', `/api/demo/payments/${id}/paid`, {})
  demoIncoming = (chatId: string, text: string) => this.req<{ ok: boolean }>('POST', '/api/demo/incoming', { chatId, text })
  settings = () => this.req<Settings>('GET', '/api/settings')
  saveSettings = (s: Partial<Settings>) => this.req<Settings>('PUT', '/api/settings', s)
  tgRequestCode = (phone: string) => this.req<Status['telegram']>('POST', '/api/telegram/login/request-code', { phone })
  tgCode = (code: string) => this.req<Status['telegram']>('POST', '/api/telegram/login/code', { code })
  tgPassword = (password: string) => this.req<Status['telegram']>('POST', '/api/telegram/login/password', { password })
  tgLogout = () => this.req<Status['telegram']>('POST', '/api/telegram/logout', {})

  /** Live server events. Reconnects automatically; returns a disposer. */
  events(onEvent: (e: ServerEvent) => void, onState?: (connected: boolean) => void): () => void {
    if (!this.configured) return () => {}
    if (this.demo) {
      let stop: (() => void) | undefined
      let stopped = false
      void loadDemo().then(b => {
        if (stopped) return
        stop = b.subscribe(onEvent)
        onState?.(true)
      })
      return () => { stopped = true; stop?.() }
    }
    let es: EventSource | null = null
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      es = new EventSource(`${this.cfg.baseUrl}/api/events?token=${encodeURIComponent(this.cfg.token)}`)
      for (const type of ['message', 'payment', 'telegram']) {
        es.addEventListener(type, ev => {
          try { onEvent(JSON.parse((ev as MessageEvent).data) as ServerEvent) } catch { /* ignore malformed */ }
        })
      }
      es.onopen = () => onState?.(true)
      es.onerror = () => {
        onState?.(false)
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          es = null
          retry = setTimeout(open, 5000)
        }
      }
    }
    open()
    return () => {
      stopped = true
      clearTimeout(retry)
      es?.close()
    }
  }
}
