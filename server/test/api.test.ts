import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiService } from '../src/ai.js'
import { buildApp } from '../src/app.js'
import { Assistant, DEFAULT_SETTINGS, type SettingsData } from '../src/assistant.js'
import { EventHub, type HubEvent } from '../src/lib/events.js'
import type { Logger } from '../src/lib/logger.js'
import { JsonStore } from '../src/lib/store.js'
import { PaymentService, type PaymentsData } from '../src/payments.js'
import type { SttProvider } from '../src/stt.js'
import { MockTelegram } from '../src/telegram/mock.js'
import type { IncomingTransfer, RateService, TonCenter } from '../src/ton.js'

const TOKEN = 'test-token-0123456789abcdef'
const WALLET = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'
const log = pino({ level: 'silent' }) as unknown as Logger

let app: FastifyInstance
let dir: string
let tg: MockTelegram
let payments: PaymentService
const transfers: IncomingTransfer[] = []
const events: HubEvent[] = []
const auth = { authorization: `Bearer ${TOKEN}` }

const fakeStt: SttProvider = { name: 'fake', transcribe: async () => 'Tell Sara that I saved her a seat' }
const fakeRates = { toTon: async (amount: number) => ({ ton: (Math.ceil((amount / 10) * 100) / 100).toFixed(2), rate: 10 }) } as unknown as RateService
const fakeTon = { recentIncoming: async () => transfers, balance: async () => 12_500_000_000n } as unknown as TonCenter

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glance-'))
  const settings = await new JsonStore<SettingsData>(dir, 'settings', { ...DEFAULT_SETTINGS, defaultFiat: 'AED' }).load()
  const pstore = await new JsonStore<PaymentsData>(dir, 'payments', { requests: [], seenTx: [] }).load()
  const hub = new EventHub()
  hub.subscribe(e => events.push(e))
  tg = new MockTelegram({ autoReplies: false })
  const ai = new AiService(null, log) // no model → deterministic rules
  payments = new PaymentService(pstore, fakeTon, hub, log, 60_000)
  const assistant = new Assistant(tg, ai, fakeStt, payments, fakeRates, settings, 'testnet', log, fakeTon)
  app = await buildApp({ token: TOKEN, corsOrigins: '*', network: 'testnet', tg, ai, stt: fakeStt, assistant, payments, settings, hub })
})
afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

describe('api', () => {
  it('serves health without auth and rejects bad tokens', async () => {
    expect((await app.inject('/health')).statusCode).toBe(200)
    expect((await app.inject('/api/status')).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/status', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401)
    const ok = await app.inject({ url: '/api/status', headers: auth })
    expect(ok.json()).toMatchObject({ telegram: { mode: 'mock', state: 'ready' }, stt: 'fake', ton: { network: 'testnet', wallet: null } })
  })

  it('returns a triaged inbox with unread chats first', async () => {
    const res = await app.inject({ url: '/api/inbox?limit=6', headers: auth })
    const { chats } = res.json() as { chats: Array<{ title: string; unread: number; priority: string }> }
    expect(chats).toHaveLength(6)
    expect(chats[0]!.priority).toBe('urgent')
    expect(chats.find(c => c.title.startsWith('Crypto'))!.priority).toBe('low')
  })

  it('turns voice into a confirmable message plan and sends it once', async () => {
    const pcm = Buffer.alloc(32000)
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2)
    const res = await app.inject({ method: 'POST', url: '/api/voice', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: pcm })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.transcript).toContain('Sara')
    expect(body.result.type).toBe('confirm')
    expect(body.result.plan).toMatchObject({ kind: 'send', targets: [{ chatId: '1002', title: 'Sara Khan' }] })

    const exec = await app.inject({ method: 'POST', url: `/api/plans/${body.result.plan.id}/execute`, headers: auth })
    expect(exec.statusCode).toBe(200)
    const msgs = await tg.getMessages('1002', 1)
    expect(msgs[0]).toMatchObject({ out: true, text: 'I saved her a seat' })
    // single-use plans
    expect((await app.inject({ method: 'POST', url: `/api/plans/${body.result.plan.id}/execute`, headers: auth })).statusCode).toBe(404)
  })

  it('rejects silent recordings', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/voice', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(32000) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('silence')
  })

  it('requires a wallet before splitting', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'split 300 with Ali and Sara' } })
    expect(res.json().result).toMatchObject({ type: 'clarify' })
  })

  it('validates wallet addresses', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { walletAddress: 'nope' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { walletAddress: WALLET } })
    expect(ok.json().walletAddress).toMatch(/^0Q/)
  })

  it('splits a bill, messages each friend, and detects on-chain payment', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'Split 300 dirhams with Ali and Sara for dinner' } })
    const { result } = res.json()
    expect(result.type).toBe('confirm')
    expect(result.plan.kind).toBe('payment_request')
    expect(result.plan.body).toContain('Ali Hassan: 100 AED (10.00 TON)')

    const exec = await app.inject({ method: 'POST', url: `/api/plans/${result.plan.id}/execute`, headers: auth })
    expect(exec.statusCode).toBe(200)
    const aliMsg = (await tg.getMessages('1001', 1))[0]!
    expect(aliMsg.text).toContain('ton://transfer/0Q')
    expect(aliMsg.text).not.toMatch(/tonkeeper/i)
    expect(aliMsg.text).toContain('amount=10000000000')

    const list = (await app.inject({ url: '/api/payments', headers: auth })).json().requests as Array<{ id: string; code: string; name: string; status: string }>
    expect(list).toHaveLength(2)
    const ali = list.find(r => r.name === 'Ali Hassan')!

    // An underpayment and a wrong code must not match; the right one must.
    transfers.push(
      { hash: 'h1', lt: '1', from: 'x', nano: 5_000_000_000n, comment: `${ali.code} dinner`, at: 0 },
      { hash: 'h2', lt: '2', from: 'x', nano: 10_000_000_000n, comment: 'GL-ZZZZZ', at: 0 },
    )
    expect(await payments.poll()).toBe(0)
    transfers.push({ hash: 'h3', lt: '3', from: 'x', nano: 10_000_000_000n, comment: `${ali.code} dinner`, at: 0 })
    expect(await payments.poll()).toBe(1)
    expect(payments.get(ali.id)!.status).toBe('paid')
    expect(events.some(e => e.type === 'payment' && e.from === 'Ali Hassan')).toBe(true)
    // idempotent
    expect(await payments.poll()).toBe(0)

    const summary = (await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'who paid' } })).json()
    expect(summary.result.body).toContain('1 pending, 1 paid')
    expect(summary.result.body).toContain('Wallet: 12.5 TON (testnet)')
    const paid = (await app.inject({ url: '/api/payments', headers: auth })).json().requests.find((r: { status: string }) => r.status === 'paid')
    expect(paid.txUrl).toContain('testnet.tonviewer.com/transaction/')
  })

  it('opens chats and returns messages', async () => {
    const r = (await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'open product team' } })).json()
    expect(r.result).toMatchObject({ type: 'open_chat', chatId: '2002' })
    const m = await app.inject({ url: '/api/chats/2002/messages?limit=5', headers: auth })
    expect(m.json().messages.length).toBeGreaterThan(0)
    expect((await app.inject({ url: '/api/chats/9999/messages', headers: auth })).statusCode).toBe(404)
  })

  it('reports the wallet balance', async () => {
    const r = (await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: "what's my balance" } })).json()
    expect(r.result).toMatchObject({ type: 'info', title: 'Wallet' })
    expect(r.result.body).toContain('12.5 TON')
    const w = (await app.inject({ url: '/api/wallet', headers: auth })).json()
    expect(w).toMatchObject({ balanceTon: '12.5', network: 'testnet' })
    expect(w.explorer).toContain('testnet.tonviewer.com/0Q')
  })

  it('drafts one-tap replies that send once confirmed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chats/1001/drafts', headers: auth })
    const { plans } = res.json() as { plans: Array<{ id: string; kind: string; body: string; targets: Array<{ chatId: string }> }> }
    expect(plans.length).toBeGreaterThanOrEqual(2)
    expect(plans.every(p => p.kind === 'send' && p.targets[0]!.chatId === '1001' && p.body.length <= 60)).toBe(true)
    const exec = await app.inject({ method: 'POST', url: `/api/plans/${plans[0]!.id}/execute`, headers: auth })
    expect(exec.statusCode).toBe(200)
    expect((await tg.getMessages('1001', 1))[0]).toMatchObject({ out: true, text: plans[0]!.body })
    // channels can't be replied to
    expect((await app.inject({ method: 'POST', url: '/api/chats/3002/drafts', headers: auth })).json().plans).toEqual([])
  })

  it('digests channels separately from the inbox', async () => {
    const ch = (await app.inject({ url: '/api/digest?kind=channels', headers: auth })).json().body as string
    expect(ch).toContain('TON Community')
    expect(ch).toContain('Even Realities')
    const inbox = (await app.inject({ url: '/api/digest', headers: auth })).json().body as string
    expect(inbox).not.toContain('TON Community')
    const voice = (await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'whats new in my channels' } })).json()
    expect(voice.result).toMatchObject({ type: 'info', title: 'Channels' })
  })

  it('limits the inbox and alerts to focus chats', async () => {
    const all = (await app.inject({ url: '/api/chats', headers: auth })).json().chats as Array<{ id: string; focused: boolean }>
    expect(all.length).toBeGreaterThanOrEqual(8)
    const put = await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { focusChatIds: ['2002', '1002'] } })
    expect(put.json().focusChatIds).toEqual(['2002', '1002'])
    const inbox = (await app.inject({ url: '/api/inbox?limit=10', headers: auth })).json().chats as Array<{ id: string }>
    expect(inbox.map(c => c.id).sort()).toEqual(['1002', '2002'])
    const picked = (await app.inject({ url: '/api/chats', headers: auth })).json().chats as Array<{ id: string; focused: boolean }>
    expect(picked.slice(0, 2).every(c => c.focused)).toBe(true)
    await app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { focusChatIds: [] } })
    expect((await app.inject({ url: '/api/inbox?limit=10', headers: auth })).json().chats.length).toBeGreaterThan(2)
  })
})
