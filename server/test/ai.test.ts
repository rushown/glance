import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiService, extractJson, stripSpeaker } from '../src/ai.js'
import type { Logger } from '../src/lib/logger.js'

const log = pino({ level: 'silent' }) as unknown as Logger
const cfg = { baseUrl: 'http://llm.local/v1/', model: 'qwen2.5:3b', fastMs: 300, timeoutMs: 2000 }

/** Fake OpenAI-compatible /chat/completions server. */
function fakeLlm(reply: (body: any) => { status?: number; content?: string; delayMs?: number }) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push({ url, body, headers: init.headers as Record<string, string> })
    const r = reply(body)
    if (r.delayMs) await new Promise(res => setTimeout(res, r.delayMs))
    if (r.status && r.status !== 200) return new Response('bad request', { status: r.status })
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: r.content ?? '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const ctx = { chats: [{ id: '1', title: 'Ali Hassan', kind: 'user' as const }], defaultFiat: 'AED' }
const chat = { id: '1', title: 'Ali', kind: 'user' as const, unread: 1, lastFrom: 'Ali', lastText: 'book a table?', lastDate: 5 }
const msgs = [{ id: 7, from: 'Ali', out: false, text: 'Can you book a table for 3 at 8?' }]

describe('AiService (open models via OpenAI-compatible API)', () => {
  it('parses clear commands with rules, without calling the model', async () => {
    const calls = fakeLlm(() => ({ content: '{}' }))
    const intent = await new AiService(cfg, log).parseCommand('split 240 dirhams with Ali for dinner', ctx)
    expect(intent).toMatchObject({ action: 'split_bill', amount: 240, currency: 'AED' })
    expect(calls).toHaveLength(0)
  })

  it('sends free-form speech to the model with a JSON schema and validates the reply', async () => {
    const calls = fakeLlm(() => ({
      content: '```json\n{"action":"send_message","recipient_names":["Ali Hassan"],"message_text":"Running 10 min late","amount":null,"currency":null,"include_self":true,"note":"","clarification":""}\n```',
    }))
    const intent = await new AiService(cfg, log).parseCommand('could you ping ally im running ten late', ctx)
    expect(intent).toMatchObject({ action: 'send_message', recipient_names: ['Ali Hassan'], message_text: 'Running 10 min late' })
    const c = calls[0]!
    expect(c.url).toBe('http://llm.local/v1/chat/completions')
    expect(c.body.model).toBe('qwen2.5:3b')
    expect(c.body.response_format.type).toBe('json_schema')
    expect(c.body.response_format.json_schema.schema.required).toContain('action')
    expect(c.body.response_format.json_schema.schema.$schema).toBeUndefined()
    expect(c.body.messages[1].content).toContain('<transcript>could you ping ally im running ten late</transcript>')
    expect(c.headers.Authorization).toBeUndefined() // local servers need no key
  })

  it('falls back to json_object mode when json_schema is rejected, and sends the API key', async () => {
    const calls = fakeLlm(b => (b.response_format.type === 'json_schema' ? { status: 400 } : { content: '{"digest":"Ali: wants a table for 3 at 8"}' }))
    const ai = new AiService({ ...cfg, apiKey: 'gsk_test' }, log)
    const out = await ai.digest([{ chat, messages: [{ id: 1, chatId: '1', from: 'Ali', out: false, text: 'table for 3 at 8?', date: 1 }] }])
    expect(out).toBe('Ali: wants a table for 3 at 8')
    expect(calls.map(c => c.body.response_format.type)).toEqual(['json_schema', 'json_object'])
    expect(calls[0]!.headers.Authorization).toBe('Bearer gsk_test')
  })

  it('uses rules when the model returns junk', async () => {
    fakeLlm(() => ({ content: 'Sure! Here is your answer: not json' }))
    const intent = await new AiService(cfg, log).parseCommand('hmm what is up with the thing', ctx)
    expect(intent.action).toBe('unknown')
  })

  it('never blocks the inbox: rules now, model triage cached for the next refresh', async () => {
    const calls = fakeLlm(() => ({ content: JSON.stringify({ chats: [{ id: '1', priority: 'urgent', summary: 'Asks you to book a table for 3' }] }), delayMs: 50 }))
    const ai = new AiService(cfg, log)
    const first = await ai.triage([chat])
    expect(first['1']!.summary).toBe('book a table?') // rules, instantly
    await new Promise(r => setTimeout(r, 120))
    expect((await ai.triage([chat]))['1']).toEqual({ priority: 'urgent', summary: 'Asks you to book a table for 3' })
    await ai.triage([chat])
    expect(calls).toHaveLength(1)
  })

  it('answers drafts with rules when the model is slow, then serves the model drafts from cache', async () => {
    fakeLlm(() => ({ content: JSON.stringify({ drafts: ['Booked, see you at 8', 'Can\'t tonight, sorry'] }), delayMs: 500 }))
    const ai = new AiService(cfg, log)
    const first = await ai.drafts(chat, msgs)
    expect(first.source).toBe('rules')
    expect(first.drafts.length).toBeGreaterThanOrEqual(2)
    await new Promise(r => setTimeout(r, 400))
    expect(await ai.drafts(chat, msgs)).toEqual({ drafts: ['Booked, see you at 8', 'Can\'t tonight, sorry'], source: 'model' })
  })

  it('runs one model call at a time, interactive before background', async () => {
    const order: string[] = []
    fakeLlm(b => {
      const name = b.response_format.json_schema.name
      order.push(name)
      return { content: name === 'digest' ? '{"digest":"x"}' : '{"chats":[]}', delayMs: 30 }
    })
    const ai = new AiService(cfg, log)
    void ai.triage([chat]) // background
    void ai.triage([{ ...chat, id: '2', lastDate: 9 }]) // queued background
    await ai.digest([{ chat, messages: [] }]) // interactive jumps the queue
    await new Promise(r => setTimeout(r, 100))
    expect(order).toEqual(['triage', 'digest', 'triage'])
  })

  it('extracts JSON from chatty replies', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Here you go: {"a": 2} hope it helps')).toEqual({ a: 2 })
    expect(extractJson('nope')).toBeNull()
  })

  it('never truncates drafts (they would be sent with "…") and keeps at least two', async () => {
    fakeLlm(() => ({ content: JSON.stringify({ drafts: ['Booked for 8!', 'I can book a table for 3 but you will need to cover the extra deposit for tonight'] }) }))
    const ai = new AiService({ ...cfg, fastMs: 1000 }, log)
    const { drafts, source } = await ai.drafts(chat, msgs)
    expect(source).toBe('model')
    expect(drafts[0]).toBe('Booked for 8!')
    expect(drafts.every(d => !d.endsWith('…') && d.length <= 60)).toBe(true)
    expect(drafts.length).toBeGreaterThanOrEqual(2)
  })

  it('strips the speaker from triage summaries', () => {
    expect(stripSpeaker('Ali Hassan: Can you book a table for 3?', ['Ali Hassan', 'Ali Hassan'])).toBe('Can you book a table for 3?')
    expect(stripSpeaker('Jake: approve the hotfix PR', ['Product Team', 'Jake'])).toBe('approve the hotfix PR')
    expect(stripSpeaker('Asks you to book a table', ['Ali'])).toBe('Asks you to book a table')
  })

  it('pauses background triage while speech-to-text runs', async () => {
    const order: string[] = []
    fakeLlm(b => { order.push(b.response_format.json_schema.name); return { content: '{"chats":[]}', delayMs: 10 } })
    const ai = new AiService(cfg, log)
    let finishStt!: () => void
    const stt = ai.whileHolding(new Promise<void>(r => { finishStt = r }))
    void ai.triage([chat])
    await new Promise(r => setTimeout(r, 60))
    expect(order).toEqual([]) // held
    finishStt(); await stt
    await new Promise(r => setTimeout(r, 60))
    expect(order).toEqual(['triage'])
  })
})
