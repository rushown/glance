// Web demo: the real Glance server logic (assistant, rule-based AI, demo
// Telegram chats, TON payment links) running in the browser, so the hosted
// page works with no server. Live Telegram, open LLMs and Whisper need the
// real server; see the README.
import './shims/buffer-global'
import { AiService } from '@server/ai.js'
import { AiSettingsBody, DEFAULT_AI_SETTINGS, mergeAiSettings, publicAiSettings, resolveLlm } from '@server/ai-settings.js'
import { Assistant, DEFAULT_SETTINGS } from '@server/assistant.js'
import { EventHub } from '@server/lib/events.js'
import { HttpError } from '@server/lib/errors.js'
import { PaymentService } from '@server/payments.js'
import { MockTelegram } from '@server/telegram/mock.js'
import { explorerUrl, friendlyAddress, nanoToTon, parseAddress, RateService, TonCenter } from '@server/ton.js'
import type { ServerEvent } from '../lib/types'

const NETWORK = 'testnet'
/** Testnet zero address: payment links stay valid, and nobody holds its keys. */
const DEMO_WALLET = friendlyAddress(parseAddress(`0:${'0'.repeat(64)}`), NETWORK)

/** In-memory replacement for the server's JSON file store. */
class MemoryStore<T extends object> {
  private data: T
  constructor(defaults: T) {
    this.data = structuredClone(defaults)
  }
  get(): Readonly<T> {
    return this.data
  }
  update(mutator: (draft: T) => void): Promise<void> {
    mutator(this.data)
    return Promise.resolve()
  }
  flush(): Promise<void> {
    return Promise.resolve()
  }
}

const log = {
  level: 'info',
  info: () => {},
  debug: () => {},
  trace: () => {},
  warn: (...a: unknown[]) => console.warn('[glance demo]', ...a),
  error: (...a: unknown[]) => console.error('[glance demo]', ...a),
  fatal: (...a: unknown[]) => console.error('[glance demo]', ...a),
  silent: () => {},
  child: () => log,
}

export interface DemoResponse {
  status: number
  json: Record<string, unknown>
}

export class DemoBackend {
  private readonly hub = new EventHub()
  private readonly tg = new MockTelegram()
  private readonly ai = new AiService(null, log)
  /** The visitor's own AI key: kept in this tab's memory only, sent only to the provider they picked. */
  private aiSettings: any = { ...DEFAULT_AI_SETTINGS, provider: 'off' }
  private readonly settings = new MemoryStore({ ...DEFAULT_SETTINGS, walletAddress: DEMO_WALLET })
  private readonly toncenter = new TonCenter(NETWORK, '')
  // Demo payments are marked paid when a friend replies; polling the chain is just a slow backstop.
  private readonly payments = new PaymentService(new MemoryStore({ requests: [], seenTx: [] }), this.toncenter, this.hub, log, 60_000)
  /** Sample balance for the demo wallet (50 TON plus demo payments received); real lookup for any other address. */
  private readonly balances = {
    balance: async (address: string): Promise<bigint> => {
      if (address !== DEMO_WALLET) return this.toncenter.balance(address)
      const paid = this.payments.list().filter((r: { status: string }) => r.status === 'paid')
      return paid.reduce((sum: bigint, r: { nano: string }) => sum + BigInt(r.nano), 50_000_000_000n)
    },
  }
  private readonly assistant = new Assistant(
    this.tg, this.ai, null, this.payments, new RateService(log, new MemoryStore({ lastKnown: {} })),
    this.settings, NETWORK, log, this.balances,
  )
  private readonly ready: Promise<void>

  constructor() {
    this.tg.onMessage(async ({ chat, message }: { chat: { id: string; title: string }; message: { from: string; text: string } }) => {
      // A friend who says they're paying, pays (same as the server's demo mode).
      if (/sending now/i.test(message.text)) {
        const req = this.payments.list().find((r: { chatId: string; status: string }) => r.chatId === chat.id && r.status === 'pending')
        if (req) setTimeout(() => void this.payments.markPaid(req.id, `demo-${Date.now()}`), 4000)
      }
      if (!this.assistant.inFocus(chat.id)) return
      let urgent = false
      try {
        urgent = (await this.ai.triage([chat]))[chat.id]?.priority === 'urgent'
      } catch { /* best-effort */ }
      this.hub.publish({ type: 'message', chatId: chat.id, chatTitle: chat.title, from: message.from, text: message.text.slice(0, 200), urgent })
    })
    this.ready = this.tg.start().then(() => this.payments.start())
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    queueMicrotask(() => fn({ type: 'telegram', status: this.tg.status().state } as ServerEvent))
    return this.hub.subscribe((e: { type: string }) => { if (e.type !== 'ping') fn(e as ServerEvent) })
  }

  async handle(method: string, url: string, body: unknown): Promise<DemoResponse> {
    await this.ready
    try {
      return { status: 200, json: await this.route(method, url, (body ?? {}) as Record<string, any>) }
    } catch (err) {
      if (err instanceof HttpError) {
        const e = err as { statusCode: number; code: string; message: string }
        return { status: e.statusCode, json: { error: e.code, message: e.message } }
      }
      console.error('[glance demo]', err)
      return { status: 500, json: { error: 'internal', message: (err as Error).message || 'Something went wrong' } }
    }
  }

  private async route(method: string, url: string, body: Record<string, any>): Promise<Record<string, unknown>> {
    const u = new URL(url, 'http://demo')
    const q = u.searchParams
    const p = u.pathname.replace(/^\/api/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const at = (m: string, ...parts: (string | null)[]) =>
      method === m && p.length === parts.length && parts.every((x, i) => x === null || x === p[i])
    const d = this

    if (at('GET', 'status')) {
      const s = d.settings.get()
      return { version: '1.0.0-web-demo', telegram: d.tg.status(), ai: d.ai.model, aiProvider: d.ai.provider, stt: null, ton: { network: NETWORK, wallet: s.walletAddress || null }, defaultFiat: s.defaultFiat }
    }
    if (at('GET', 'inbox')) return { chats: await d.assistant.inbox(Math.min(20, Number(q.get('limit')) || 12)) }
    if (at('GET', 'chats')) {
      const focus = new Set(d.settings.get().focusChatIds ?? [])
      const chats = await d.tg.listChats(100)
      return {
        chats: chats
          .map((c: any) => ({ id: c.id, title: c.title, kind: c.kind, unread: c.unread, muted: Boolean(c.muted), lastDate: c.lastDate, focused: focus.has(c.id) }))
          .sort((a: any, b: any) => Number(b.focused) - Number(a.focused) || b.lastDate - a.lastDate),
      }
    }
    if (at('POST', 'chats', null, 'drafts')) return d.assistant.draftsWithSource(p[1])
    if (at('GET', 'chats', null, 'messages')) {
      const chat = await d.tg.getChat(p[1])
      if (!chat) throw new HttpError(404, 'Chat not found', 'not_found')
      return { chat, messages: await d.tg.getMessages(p[1], Math.min(50, Number(q.get('limit')) || 15)) }
    }
    if (at('POST', 'chats', null, 'read')) { await d.tg.markRead(p[1]); return { ok: true } }
    if (at('POST', 'voice')) {
      return { transcript: '', result: { type: 'info', title: 'Voice needs a server', body: 'Speech-to-text (Whisper) runs on the Glance server. In this web demo, type a command instead.' } }
    }
    if (at('POST', 'command')) {
      const text = String(body.text ?? '').trim().slice(0, 500)
      if (!text) throw new HttpError(400, 'Say or type a command', 'bad_request')
      return { transcript: text, result: await d.assistant.command(text, body.chatId) }
    }
    if (at('POST', 'plans', null, 'execute')) return d.assistant.execute(p[1])
    if (at('GET', 'digest')) return { body: await d.assistant.digest(q.get('kind') === 'channels' ? 'channels' : 'inbox') }
    if (at('GET', 'payments')) {
      return {
        summary: await d.assistant.paymentsReport(),
        requests: d.payments.list().map((r: any) => ({
          ...r,
          ton: nanoToTon(r.nano),
          txUrl: r.txHash && !r.txHash.startsWith('demo-') ? explorerUrl(NETWORK, 'tx', r.txHash) : null,
        })),
      }
    }
    if (at('GET', 'wallet')) {
      const w = await d.assistant.walletInfo()
      return { ...w, explorer: w.address ? explorerUrl(NETWORK, 'address', w.address) : null }
    }
    if (at('POST', 'payments', null, 'cancel')) {
      if (!(await d.payments.cancel(p[1]))) throw new HttpError(404, 'No pending request with that id', 'not_found')
      return { ok: true }
    }
    if (at('POST', 'payments', 'poll')) return { matched: await d.payments.poll() }
    if (at('GET', 'settings')) return { ...d.settings.get() }
    if (at('PUT', 'settings')) {
      let wallet: string | undefined
      if (typeof body.walletAddress === 'string') {
        try {
          wallet = body.walletAddress.trim() ? friendlyAddress(parseAddress(body.walletAddress), NETWORK) : ''
        } catch (err) {
          throw new HttpError(400, (err as Error).message, 'invalid_address')
        }
      }
      await d.settings.update((s: any) => {
        if (wallet !== undefined) s.walletAddress = wallet
        if (typeof body.defaultFiat === 'string' && /^[A-Za-z]{3}$/.test(body.defaultFiat)) s.defaultFiat = body.defaultFiat.toUpperCase()
        if (Array.isArray(body.focusChatIds)) s.focusChatIds = [...new Set(body.focusChatIds.map(String))].slice(0, 50)
      })
      return { ...d.settings.get() }
    }
    if (at('GET', 'ai')) return { ...publicAiSettings(d.aiSettings, d.ai, null) }
    if (at('PUT', 'ai')) {
      const parsed = AiSettingsBody.safeParse(body)
      if (!parsed.success || parsed.data.provider === 'server') throw new HttpError(400, 'Pick a provider', 'invalid_ai_settings')
      try {
        d.aiSettings = mergeAiSettings(d.aiSettings, parsed.data)
      } catch (err) {
        throw new HttpError(400, (err as Error).message, 'invalid_ai_settings')
      }
      d.ai.configure(resolveLlm(d.aiSettings, null))
      let test = null
      if (d.ai.enabled) {
        const started = Date.now()
        const error = await d.ai.test()
        test = { ok: !error, error: error && /fetch|network|cors/i.test(error) ? `${error} (this provider may block calls from a browser; run a Glance server instead)` : error, ms: Date.now() - started }
      }
      return { ...publicAiSettings(d.aiSettings, d.ai, null), test }
    }
    if (at('POST', 'ai', 'test')) {
      if (!d.ai.enabled) return { ok: false, error: 'AI is off', ms: 0 }
      const started = Date.now()
      const error = await d.ai.test()
      return { ok: !error, error, ms: Date.now() - started }
    }
    if (method === 'POST' && p[0] === 'telegram') return d.tg.status()
    if (at('POST', 'demo', 'incoming')) { d.tg.receive(String(body.chatId), String(body.text ?? '').slice(0, 500)); return { ok: true } }
    if (at('POST', 'demo', 'payments', null, 'paid')) {
      if (!(await d.payments.markPaid(p[2], `demo-${Date.now()}`))) throw new HttpError(404, 'No pending request with that id', 'not_found')
      return { ok: true }
    }
    throw new HttpError(404, `Not available in the web demo: ${method} ${u.pathname}`, 'not_found')
  }
}
