import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AiService, heuristicIntent, searchNotes } from '../src/ai.js'
import { type AiSettingsData, DEFAULT_AI_SETTINGS } from '../src/ai-settings.js'
import { buildApp } from '../src/app.js'
import { Assistant, DEFAULT_SETTINGS, type SettingsData } from '../src/assistant.js'
import { EventHub } from '../src/lib/events.js'
import type { Logger } from '../src/lib/logger.js'
import { JsonStore } from '../src/lib/store.js'
import { PaymentService } from '../src/payments.js'
import { MockTelegram } from '../src/telegram/mock.js'
import type { RateService, TonCenter } from '../src/ton.js'

const log = pino({ level: 'silent' }) as unknown as Logger
const TOKEN = 'test-token-0123456789abcdef'
const auth = { authorization: `Bearer ${TOKEN}` }
const ctx = { chats: [{ id: '1001', title: 'Ali Hassan', kind: 'user' as const }], defaultFiat: 'AED' }
const fakeTon = { recentIncoming: async () => [], balance: async () => 0n } as unknown as TonCenter
const fakeRates = { toTon: async () => ({ ton: '1.00', rate: 1 }) } as unknown as RateService

function setup(ai = new AiService(null, log)) {
  const tg = new MockTelegram({ autoReplies: false })
  const settings = { get: () => ({ ...DEFAULT_SETTINGS }), update: async () => {}, flush: async () => {} } as unknown as JsonStore<SettingsData>
  const payments = new PaymentService({ get: () => ({ requests: [], seenTx: [] }), update: async () => {} } as never, fakeTon, new EventHub(), log, 60_000)
  return { tg, ai, assistant: new Assistant(tg, ai, null, payments, fakeRates, settings, 'testnet', log, fakeTon) }
}

/** Fake OpenAI-compatible server. */
function fakeOpenAi(reply: (body: any) => { status?: number; text?: string; content?: string }) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url: String(url), body, headers: init.headers as Record<string, string> })
    const r = reply(body)
    if (r.status && r.status !== 200) return new Response(r.text ?? 'error', { status: r.status })
    return Response.json({ choices: [{ message: { role: 'assistant', content: r.content ?? '{}' } }] })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('voice commands for notes, questions and briefs (no model)', () => {
  it('recognises notes, searches, briefs and questions', () => {
    expect(heuristicIntent('note: gym locker 4417', ctx)).toMatchObject({ action: 'save_note', message_text: 'Gym locker 4417' })
    expect(heuristicIntent('remember that I parked on level P2', ctx)).toMatchObject({ action: 'save_note', message_text: 'I parked on level P2' })
    expect(heuristicIntent("what's the office wifi password?", ctx)).toMatchObject({ action: 'ask', message_text: "what's the office wifi password" })
    expect(heuristicIntent('search my notes for passport', ctx)).toMatchObject({ action: 'ask', message_text: 'passport' })
    expect(heuristicIntent('show my notes', ctx)).toMatchObject({ action: 'ask', message_text: '' })
    expect(heuristicIntent('brief me on Ali', ctx)).toMatchObject({ action: 'brief', recipient_names: ['Ali'] })
    expect(heuristicIntent("what's going on with Sara", ctx)).toMatchObject({ action: 'brief', recipient_names: ['Sara'] })
    expect(heuristicIntent('catch me up', ctx).action).toBe('summarize')
  })

  it('leaves free-form questions to the model when one is set', () => {
    expect(heuristicIntent('could you ping ally im running late', ctx, { guessQuestions: false }).action).toBe('unknown')
    // With a chat open, a question is a reply to that chat.
    expect(heuristicIntent('are you coming?', { ...ctx, currentChat: { id: '1001', title: 'Ali Hassan', recent: [] } }).action).toBe('reply')
  })

  it('finds notes by keyword, tolerating word forms', () => {
    const notes = [
      { text: 'Office wifi: GlanceGuest / password tonhub2026', date: 1 },
      { text: 'Parked at Mall of the Emirates, level P2', date: 2 },
      { text: 'Gym locker code 4417', date: 3 },
    ]
    expect(searchNotes("what's the office wifi password", notes)[0]!.text).toContain('wifi')
    expect(searchNotes('where did I park', notes)[0]!.text).toContain('Parked')
    expect(searchNotes('what is the weather', notes)).toEqual([])
  })
})

describe('assistant: Telegram-native answers without a model', () => {
  it('answers from Saved Messages', async () => {
    const { assistant } = setup()
    const r = await assistant.command("What's the office wifi password?")
    expect(r).toMatchObject({ type: 'info', title: 'From your notes' })
    expect((r as { body: string }).body).toContain('tonhub2026')
  })

  it('falls back to Telegram search across chats', async () => {
    const { assistant } = setup()
    const r = await assistant.command('where is the demo day venue?')
    expect(r).toMatchObject({ type: 'info', title: 'Found in Telegram' })
    expect((r as { body: string }).body).toContain('DIFC')
  })

  it('saves a note to Saved Messages only after confirmation', async () => {
    const { assistant, tg } = setup()
    const r = await assistant.command('note: car is at P3 zone B')
    expect(r.type).toBe('confirm')
    const plan = (r as { plan: { id: string; kind: string } }).plan
    expect(plan.kind).toBe('note')
    expect((await tg.getNotes(100)).some(n => n.text === 'Car is at P3 zone B')).toBe(false)
    await assistant.execute(plan.id)
    expect((await tg.getNotes(100)).at(-1)!.text).toBe('Car is at P3 zone B')
    await expect(assistant.execute(plan.id)).rejects.toThrow() // single use
  })

  it('briefs on a person from recent messages', async () => {
    const { assistant } = setup()
    const r = await assistant.command('brief me on Ali')
    expect(r).toMatchObject({ type: 'info', title: 'Brief · Ali Hassan' })
    expect((r as { body: string }).body).toContain('book a table')
  })
})

describe('assistant with a model', () => {
  it('answers questions using notes as context', async () => {
    const calls = fakeOpenAi(() => ({ content: '{"answer":"GlanceGuest, password tonhub2026","from_notes":true}' }))
    const { assistant } = setup(new AiService({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: 'sk-test' }, log))
    const r = await assistant.command("what's the office wifi password?")
    expect(r).toMatchObject({ type: 'info', title: 'From your notes', body: 'GlanceGuest, password tonhub2026' })
    const answerCall = calls.find(c => c.body.response_format?.json_schema?.name === 'answer')!
    expect(answerCall.body.messages[1].content).toContain('Office wifi: GlanceGuest')
    expect(answerCall.headers.Authorization).toBe('Bearer sk-test')
  })

  it('drops temperature for models that reject it', async () => {
    const calls = fakeOpenAi(b => (b.temperature !== undefined ? { status: 400, text: '{"error":{"message":"Unsupported value: temperature"}}' } : { content: '{"ok":true}' }))
    const ai = new AiService({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: 'sk-test' }, log)
    expect(await ai.test()).toBeNull()
    expect(calls.map(c => 'temperature' in c.body)).toEqual([true, false])
  })

  it('calls Claude through the Anthropic SDK with structured outputs', async () => {
    const calls: Array<{ url: string; body: any; headers: Headers }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) })
      return Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: '{"answer":"Level P2, zone F","from_notes":true}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    })
    const ai = new AiService({ provider: 'anthropic', baseUrl: '', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' }, log)
    const r = await ai.answer('where did I park', [{ text: 'Parked at level P2, zone F', date: 1 }])
    expect(r).toEqual({ answer: 'Level P2, zone F', fromNotes: true })
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-ant-test')
    expect(calls[0]!.body.output_config.format.type).toBe('json_schema')
    expect(calls[0]!.body.output_config.effort).toBe('low')
    expect(calls[0]!.body.temperature).toBeUndefined()
  })

  it('reports a rejected key instead of hiding it', async () => {
    fakeOpenAi(() => ({ status: 401, text: 'invalid api key' }))
    const ai = new AiService({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', apiKey: 'bad' }, log)
    expect(await ai.test()).toMatch(/API key rejected/)
  })
})

describe('AI settings API', () => {
  let app: FastifyInstance
  let dir: string
  let ai: AiService

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'glance-ai-'))
    const store = await new JsonStore<AiSettingsData>(dir, 'ai', { ...DEFAULT_AI_SETTINGS, provider: 'off' }).load()
    const s = setup()
    ai = s.ai
    const settings = await new JsonStore<SettingsData>(dir, 'settings', { ...DEFAULT_SETTINGS }).load()
    app = await buildApp({
      token: TOKEN, corsOrigins: '*', network: 'testnet', tg: s.tg, ai, stt: null, assistant: s.assistant,
      payments: {} as PaymentService, settings, hub: new EventHub(), aiSettings: store, serverLlm: null,
    })
  })
  afterAll(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('stores the key on the server and never returns it', async () => {
    const calls = fakeOpenAi(() => ({ content: '{"ok":true}' }))
    const put = await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'openrouter', apiKey: 'sk-or-secret-1234' } })
    expect(put.statusCode).toBe(200)
    expect(put.body).not.toContain('secret')
    expect(put.json()).toMatchObject({ provider: 'openrouter', hasKey: true, keyHint: '…1234', active: { provider: 'openrouter', model: 'openai/gpt-5-mini' }, test: { ok: true } })
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')

    const get = await app.inject({ method: 'GET', url: '/api/ai', headers: auth })
    expect(get.body).not.toContain('secret')
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: auth })).json()).toMatchObject({ ai: 'openai/gpt-5-mini', aiProvider: 'openrouter' })
    expect(await readFile(join(dir, 'ai.json'), 'utf8')).toContain('sk-or-secret-1234')

    // Changing only the model keeps the saved key.
    const model = await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'openrouter', model: 'anthropic/claude-haiku-5-5' } })
    expect(model.json()).toMatchObject({ hasKey: true, active: { model: 'anthropic/claude-haiku-5-5' } })
  })

  it('validates input and can turn AI off', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'openai' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'custom', baseUrl: 'nope', model: 'x' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'server' } })).statusCode).toBe(400) // no LLM_BASE_URL
    const off = await app.inject({ method: 'PUT', url: '/api/ai', headers: auth, payload: { provider: 'off' } })
    expect(off.json()).toMatchObject({ provider: 'off', hasKey: false, active: null, test: null })
    expect(ai.enabled).toBe(false)
  })

  it('requires the app token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ai' })).statusCode).toBe(401)
  })
})
