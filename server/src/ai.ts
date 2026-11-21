import { z } from 'zod'
import type { Logger } from './lib/logger.js'
import { type Chat, matchChats, type Message } from './telegram/types.js'

// ── Schemas ─────────────────────────────────────────────────────────────

export const IntentSchema = z.object({
  action: z
    .enum(['reply', 'send_message', 'split_bill', 'request_payment', 'open_chat', 'summarize', 'summarize_channels', 'check_payments', 'check_balance', 'unknown'])
    .describe('What the user wants to do'),
  recipient_names: z
    .array(z.string())
    .describe('People or chats named by the user, exactly as they would appear in the chat list. Empty for reply/summarize.'),
  message_text: z
    .string()
    .describe('For reply/send_message: the message to send, cleaned up (fix STT errors, punctuation), in the user\'s voice. Otherwise empty.'),
  amount: z.number().nullable().describe('Total amount for split_bill, or per-person amount for request_payment. Null if none.'),
  currency: z.string().nullable().describe('ISO 4217 code (AED, USD, EUR...) or "TON". Null if unspecified.'),
  include_self: z.boolean().describe('split_bill only: true if the user also pays a share (default true).'),
  note: z.string().describe('Short memo for payments, e.g. "dinner at Al Fanar". Empty if none.'),
  clarification: z.string().describe('If action is unknown or ambiguous: a <=60 char question to ask the user. Otherwise empty.'),
})
export type Intent = z.infer<typeof IntentSchema>

const TriageSchema = z.object({
  chats: z.array(
    z.object({
      id: z.string(),
      priority: z.enum(['urgent', 'normal', 'low']),
      summary: z.string().describe('<= 48 characters, plain text, what needs attention'),
    }),
  ),
})
export type Triage = Record<string, { priority: 'urgent' | 'normal' | 'low'; summary: string }>

const DigestSchema = z.object({ digest: z.string().describe('<= 280 characters, plain text, no markdown') })

const DraftsSchema = z.object({
  drafts: z.array(z.string().describe('<= 50 characters, plain text, no emoji')).describe('2 or 3 distinct reply options'),
})

// ── Service ─────────────────────────────────────────────────────────────

export interface CommandContext {
  chats: Pick<Chat, 'id' | 'title' | 'kind'>[]
  currentChat?: { id: string; title: string; recent: Pick<Message, 'from' | 'text'>[] }
  defaultFiat: string
}

export interface LlmConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 (Ollama), https://api.groq.com/openai/v1 */
  baseUrl: string
  model: string
  apiKey?: string
  /** Hard limit for one model call. */
  timeoutMs?: number
  /** How long interactive features wait before answering with rules (the model result is still cached). */
  fastMs?: number
}

type Job<T> = { run: (signal: AbortSignal) => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; abort: AbortController }

/**
 * Language understanding with any open model behind an OpenAI-compatible
 * endpoint (Ollama, llama.cpp server, vLLM, LM Studio, Groq...). Responses are
 * constrained to a JSON schema and validated with zod; anything invalid, slow
 * or failing falls back to deterministic rules, so the glasses never wait on
 * a model and the app works with no model at all.
 *
 * Local models usually serve one request at a time, so calls are queued and
 * interactive requests (drafts, commands, digests) jump ahead of background
 * inbox triage.
 */
export class AiService {
  private readonly cfg?: Required<LlmConfig>
  private triageCache = new Map<string, { key: string; value: Triage[string] }>()
  private draftCache = new Map<string, string[]>()
  private triagePending = new Set<string>()
  private jsonMode: 'schema' | 'object' = 'schema'
  private queue: { hi: Job<unknown>[]; lo: Job<unknown>[] } = { hi: [], lo: [] }
  private running: { priority: 'hi' | 'lo'; abort: AbortController } | null = null

  constructor(
    cfg: LlmConfig | null,
    private readonly log: Logger,
  ) {
    if (cfg?.baseUrl && cfg.model) {
      this.cfg = { apiKey: '', timeoutMs: 45_000, fastMs: 6000, ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') }
    }
  }

  get enabled() {
    return Boolean(this.cfg)
  }

  /** Model name for status displays, or null when running on rules only. */
  get model() {
    return this.cfg?.model ?? null
  }

  private enqueue<T>(run: (signal: AbortSignal) => Promise<T>, priority: 'hi' | 'lo'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue[priority].push({ run, resolve, reject, abort: new AbortController() } as Job<unknown>)
      // Someone is waiting on the glasses: stop background work instead of queueing behind it.
      if (priority === 'hi' && this.running?.priority === 'lo') this.running.abort.abort(new Error('preempted'))
      void this.pump()
    })
  }

  private async pump() {
    if (this.running) return
    const priority = this.queue.hi.length ? 'hi' : 'lo'
    const job = this.queue[priority].shift()
    if (!job) return
    this.running = { priority, abort: job.abort }
    try {
      job.resolve(await job.run(job.abort.signal))
    } catch (err) {
      job.reject(err)
    } finally {
      this.running = null
      void this.pump()
    }
  }

  private async structured<S extends z.ZodType>(schema: S, name: string, system: string, user: string, priority: 'hi' | 'lo' = 'hi'): Promise<z.infer<S> | null> {
    const cfg = this.cfg
    if (!cfg) return null
    // The time limit covers waiting in the queue too.
    const deadline = Date.now() + cfg.timeoutMs
    return this.enqueue(async signal => {
      const remaining = deadline - Date.now()
      if (remaining < 1500) return null
      const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>
      const call = (mode: 'schema' | 'object') =>
        fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.2,
            stream: false,
            messages: [
              // Small open models follow the schema far better when they also see it in the prompt.
              { role: 'system', content: `${system}\n\nAnswer with one JSON object only, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}` },
              { role: 'user', content: user },
            ],
            response_format: mode === 'schema' ? { type: 'json_schema', json_schema: { name, schema: jsonSchema, strict: true } } : { type: 'json_object' },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        })
      let res = await call(this.jsonMode)
      if (res.status === 400 && this.jsonMode === 'schema') {
        // Some servers only support plain JSON mode; remember and retry once.
        this.log.warn({ model: cfg.model }, 'json_schema response_format rejected, using json_object')
        this.jsonMode = 'object'
        res = await call('object')
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const parsed = schema.safeParse(extractJson(json.choices?.[0]?.message?.content ?? ''))
      if (!parsed.success) {
        this.log.warn({ name, issues: parsed.error.issues.slice(0, 3) }, 'model output did not match schema')
        return null
      }
      return parsed.data as z.infer<S>
    }, priority)
  }

  // ── Voice command → intent ────────────────────────────────────────────
  /**
   * Clear commands ("split 240 dirhams with Ali and Sara", "who paid?") are
   * parsed by rules instantly. Only free-form speech goes to the model.
   */
  async parseCommand(transcript: string, ctx: CommandContext): Promise<Intent> {
    const text = transcript.trim()
    if (!text) return unknown('I did not catch that')
    const fast = heuristicIntent(text, ctx)
    if (fast.action !== 'unknown' || !this.enabled) return fast
    try {
      const out = await this.structured(
        IntentSchema,
        'intent',
        [
          'You turn short voice commands spoken to smart glasses into structured actions for a Telegram + TON wallet assistant.',
          'The transcript comes from speech-to-text and may contain recognition errors; infer the intended names from the chat list.',
          'Actions:',
          '- reply: answer the currently open chat. Use when a chat is open and the user dictates a message without naming anyone else.',
          '- send_message: send a message to named people/chats.',
          '- split_bill: divide a total among named people (and usually the user) and send each a TON payment request.',
          '- request_payment: ask named people for a specific amount each.',
          '- open_chat: show a named chat.',
          '- summarize: digest of unread / important personal and group messages.',
          '- summarize_channels: digest of the Telegram channels and communities the user follows (news, announcements, crypto groups).',
          '- check_payments: status of outstanding payment requests.',
          "- check_balance: the user's own TON wallet balance.",
          '- unknown: anything else, with a clarification question.',
          `If the user gives an amount without currency, use ${ctx.defaultFiat}. "dirham(s)" = AED. "gram(s)" and "toncoin" = TON.`,
          'For reply/send_message, write message_text as the user would type it: natural, concise, correct punctuation. Do not add sign-offs.',
          'Never invent recipients that were not spoken.',
        ].join('\n'),
        [
          `<chats>\n${ctx.chats.map(c => `${c.title} (${c.kind})`).join('\n')}\n</chats>`,
          ctx.currentChat
            ? `<open_chat title="${ctx.currentChat.title}">\n${ctx.currentChat.recent.map(m => `${m.from}: ${m.text}`).join('\n')}\n</open_chat>`
            : '<open_chat>none</open_chat>',
          `<transcript>${text}</transcript>`,
        ].join('\n\n'),
      )
      if (out) return normalizeIntent(out)
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'intent parsing failed, using heuristics')
    }
    return fast
  }

  // ── Inbox triage ──────────────────────────────────────────────────────
  /**
   * Never blocks on the model: chats without a cached model verdict get a
   * rule-based one now, and the model refines them in the background for the
   * next refresh.
   */
  async triage(chats: Chat[]): Promise<Triage> {
    const result: Triage = {}
    const todo: Chat[] = []
    for (const c of chats) {
      const key = `${c.lastDate}:${c.unread}`
      const hit = this.triageCache.get(c.id)
      if (hit && hit.key === key) result[c.id] = hit.value
      else if (c.unread === 0) result[c.id] = { priority: 'low', summary: truncate(c.lastText, 48) }
      else {
        result[c.id] = heuristicTriage(c)
        todo.push(c)
      }
    }
    if (todo.length && this.enabled) void this.refineTriage(todo)
    return result
  }

  private async refineTriage(chats: Chat[]) {
    const todo = chats.filter(c => !this.triagePending.has(`${c.id}:${c.lastDate}:${c.unread}`)).slice(0, 12)
    if (!todo.length) return
    const keys = todo.map(c => `${c.id}:${c.lastDate}:${c.unread}`)
    for (const k of keys) this.triagePending.add(k)
    try {
      const out = await this.structured(
        TriageSchema,
        'triage',
        [
          'You triage a Telegram inbox for someone wearing smart glasses who can only glance at a tiny display.',
          'urgent = needs action from the user soon (direct questions, blockers, time-sensitive plans, mentions, money).',
          'normal = personal messages that can wait an hour.',
          'low = muted channels, promotions, spam, chatter that needs no action.',
          'summary: <= 48 characters describing what needs attention, e.g. "Asks you to book table for 3".',
          'Return one entry per chat id given, using the exact ids.',
        ].join('\n'),
        todo
          .map(c => `<chat id="${c.id}" kind="${c.kind}" unread="${c.unread}" muted="${Boolean(c.muted)}" title="${c.title}">${c.lastFrom}: ${c.lastText}</chat>`)
          .join('\n'),
        'lo',
      )
      for (const e of out?.chats ?? []) {
        const c = todo.find(x => x.id === e.id)
        if (c && e.summary.trim()) this.triageCache.set(c.id, { key: `${c.lastDate}:${c.unread}`, value: { priority: e.priority, summary: truncate(e.summary, 48) } })
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'background triage failed; rules stay in place')
    } finally {
      for (const k of keys) this.triagePending.delete(k)
    }
  }

  // ── Digest ────────────────────────────────────────────────────────────
  async digest(items: Array<{ chat: Chat; messages: Message[] }>, kind: 'inbox' | 'channels' = 'inbox'): Promise<string> {
    if (!items.length) return kind === 'channels' ? 'No new posts in your channels.' : 'Inbox zero. Nothing needs you right now.'
    const instructions =
      kind === 'channels'
        ? 'Summarize the new posts in these Telegram channels and communities for a smart-glasses display. Keep only real news and decisions; skip promotions, shilling and spam (say "skipped promo" if a whole channel is noise). One short line per channel, format "Name: gist". Max 280 characters total. Plain text, no emoji.'
        : 'Summarize these unread Telegram conversations for a smart-glasses display. Lead with what needs action. Use short lines separated by newlines, one per chat, format "Name: gist". Max 280 characters total. Plain text, no emoji.'
    try {
      const out = await this.structured(
        DigestSchema,
        'digest',
        instructions,
        items
          .map(i => `<chat title="${i.chat.title}">\n${i.messages.map(m => `${m.from}: ${m.text}`).join('\n')}\n</chat>`)
          .join('\n'),
      )
      if (out?.digest.trim()) return truncate(out.digest, 400)
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'digest failed, using heuristics')
    }
    return items
      .slice(0, 5)
      .map(i => `${i.chat.title}: ${truncate(i.messages.filter(m => !m.out).at(-1)?.text ?? i.chat.lastText, 90)}`)
      .join('\n\n')
  }

  // ── Reply drafts ──────────────────────────────────────────────────────
  /**
   * 2-3 short replies the user can approve with one tap instead of dictating.
   * Waits at most `fastMs` for the model, then answers with rule-based drafts;
   * the model's drafts are cached for the next request on the same message.
   */
  async drafts(chat: Pick<Chat, 'id' | 'title' | 'kind'>, messages: Pick<Message, 'id' | 'from' | 'out' | 'text'>[]): Promise<{ drafts: string[]; source: 'model' | 'rules' }> {
    if (!messages.length) return { drafts: ['Hi!'], source: 'rules' }
    const rules = { drafts: heuristicDrafts(messages), source: 'rules' as const }
    if (!this.cfg) return rules
    const key = `${chat.id}:${messages.at(-1)!.id}`
    const cached = this.draftCache.get(key)
    if (cached) return { drafts: cached, source: 'model' }
    const fromModel = this.structured(
      DraftsSchema,
      'drafts',
      [
        'You draft quick replies for someone reading Telegram on smart glasses. They approve one with a single tap, so each draft must be ready to send as-is.',
        'Write 2 or 3 distinct options that answer the latest incoming message(s): e.g. a yes, a no/later, and a specific helpful answer.',
        'Match the language, tone and formality of the conversation. Max 50 characters each. No emoji, no quotes, no sign-offs.',
        "Never invent facts (times, places, amounts) the user has not stated; prefer \"I'll check\" style answers over guesses.",
      ].join('\n'),
      `<chat title="${chat.title}" kind="${chat.kind}">\n${messages.map(m => `${m.out ? 'Me' : m.from}: ${m.text}`).join('\n')}\n</chat>`,
    )
      .then(out => {
        const drafts = [...new Set((out?.drafts ?? []).map(d => truncate(d.replace(/^["“]|["”]$/g, '').trim(), 60)).filter(Boolean))].slice(0, 3)
        if (drafts.length) {
          this.draftCache.set(key, drafts)
          if (this.draftCache.size > 200) this.draftCache.delete(this.draftCache.keys().next().value!)
        }
        return drafts
      })
      .catch(err => {
        this.log.warn({ err: (err as Error).message }, 'drafts failed, using heuristics')
        return [] as string[]
      })
    const timer = new Promise<null>(r => setTimeout(() => r(null), this.cfg!.fastMs).unref())
    const drafts = await Promise.race([fromModel, timer])
    return drafts?.length ? { drafts, source: 'model' } : rules
  }
}

/** Pull the JSON object out of a model reply (tolerates code fences or chatter around it). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(t)
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)) } catch { /* fall through */ }
    }
    return null
  }
}

export function heuristicDrafts(messages: Pick<Message, 'out' | 'text'>[]): string[] {
  const last = [...messages].reverse().find(m => !m.out)?.text.toLowerCase() ?? ''
  if (/\b(pay(ing|ment)?|paid|sen(d|t|ding)|ton|money|transfer(red)?)\b/.test(last)) return ['Thanks, got it!', 'Will check and confirm', 'Not received yet']
  if (/\b(call|ring)\b/.test(last)) return ['Will call you in 10 min', 'Can\'t talk now, text me?', 'Calling now']
  if (/\?|can you|could you|please/.test(last)) return ['Yes, on it', 'Can\'t right now, sorry', 'Let me check and get back to you']
  if (/\b(landing|arriv|on my way|omw|late|coming)\b/.test(last)) return ['See you soon!', 'No rush, take your time', 'Let me know when you\'re here']
  return ['Sounds good!', 'Thanks!', 'Will reply properly soon']
}

// ── Helpers & heuristics (also used when Claude is unavailable) ───────────

export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : `${clean.slice(0, n - 1).trimEnd()}…`
}

function unknown(clarification: string): Intent {
  return { action: 'unknown', recipient_names: [], message_text: '', amount: null, currency: null, include_self: true, note: '', clarification }
}

function normalizeIntent(i: Intent): Intent {
  return {
    ...i,
    recipient_names: i.recipient_names.map(n => n.trim()).filter(Boolean),
    message_text: i.message_text.trim(),
    currency: i.currency ? i.currency.trim().toUpperCase() : null,
    amount: i.amount !== null && Number.isFinite(i.amount) && i.amount > 0 ? i.amount : null,
    note: i.note.trim(),
  }
}

const CURRENCY_WORDS: Record<string, string> = {
  dirham: 'AED', dirhams: 'AED', aed: 'AED', dollar: 'USD', dollars: 'USD', usd: 'USD', bucks: 'USD',
  euro: 'EUR', euros: 'EUR', eur: 'EUR', pound: 'GBP', pounds: 'GBP', gbp: 'GBP', ton: 'TON', tons: 'TON', toncoin: 'TON',
  // Toncoin was renamed Gram in 2026.
  gram: 'TON', grams: 'TON',
  rupee: 'INR', rupees: 'INR', inr: 'INR', riyal: 'SAR', riyals: 'SAR',
}

function splitNames(s: string): string[] {
  return s
    .split(/,|\band\b|&/i)
    .map(x => x.replace(/\b(me|myself|i)\b/gi, '').trim())
    .filter(x => x.length > 1)
}

export function heuristicIntent(text: string, ctx: CommandContext): Intent {
  const t = text.trim().replace(/[.!]+$/, '')
  const lower = t.toLowerCase()
  const money = lower.match(/(\d+(?:[.,]\d+)?)\s*([a-z]+)?/)
  const amount = money ? Number(money[1]!.replace(',', '.')) : null
  const currency = money?.[2] ? CURRENCY_WORDS[money[2]] ?? null : null
  const note = lower.match(/\bfor ([a-z0-9 '\-]+?)(?: with| between| among|$)/)?.[1]?.trim() ?? ''

  let m: RegExpMatchArray | null
  if ((m = lower.match(/\bsplit\b.*?\b(?:with|between|among)\s+(.+?)(?:\s+for\s+.*)?$/))) {
    return { ...unknown(''), action: 'split_bill', recipient_names: splitNames(m[1]!), amount, currency: currency ?? ctx.defaultFiat, include_self: !/\bbetween\b/.test(lower) || /\bme\b/.test(m[1]!), note }
  }
  if ((m = lower.match(/\b(?:request|ask|charge)\s+(.+?)\s+(?:for\s+)?\d/))) {
    return { ...unknown(''), action: 'request_payment', recipient_names: splitNames(m[1]!), amount, currency: currency ?? ctx.defaultFiat, note }
  }
  if (/\b(channels?|news|communit(y|ies)|announcements?)\b/.test(lower) && /\b(summar|digest|what|catch|news|new|update)/.test(lower)) return { ...unknown(''), action: 'summarize_channels' }
  if (/\b(summar|digest|what did i miss|catch me up|what'?s new)/.test(lower)) return { ...unknown(''), action: 'summarize' }
  if (/\b(balance|how much (ton|gram|money) do i have|my wallet)\b/.test(lower)) return { ...unknown(''), action: 'check_balance' }
  if (/\b(payments?|who paid|who owes|pending)\b/.test(lower)) return { ...unknown(''), action: 'check_payments' }
  if ((m = t.match(/^(?:open|show|read)\s+(?:chat\s+(?:with\s+)?)?(.+)$/i))) {
    return { ...unknown(''), action: 'open_chat', recipient_names: [m[1]!.trim()] }
  }
  if ((m = t.match(/^(?:tell|message|text|send)\s+(.+?)(?:\s+that|\s*[:,])\s+(.+)$/i))) {
    return { ...unknown(''), action: 'send_message', recipient_names: splitNames(m[1]!), message_text: capitalize(m[2]!) }
  }
  if ((m = t.match(/^let\s+(.+?)\s+know\s+(?:that\s+)?(.+)$/i))) {
    return { ...unknown(''), action: 'send_message', recipient_names: splitNames(m[1]!), message_text: capitalize(m[2]!) }
  }
  // Spoken without "that": "tell Sara I saved her a seat". Find the longest leading name that is a chat.
  if ((m = t.match(/^(?:tell|message|text)\s+(.+)$/i))) {
    const words = m[1]!.split(/\s+/)
    for (let k = Math.min(3, words.length - 1); k >= 1; k--) {
      const name = words.slice(0, k).join(' ')
      const best = matchChats(ctx.chats as Chat[], name)[0]
      if (best && best.score >= 0.75) {
        return { ...unknown(''), action: 'send_message', recipient_names: [name], message_text: capitalize(words.slice(k).join(' ')) }
      }
    }
  }
  if ((m = t.match(/^(?:reply|answer|say)\s*(?:with|that)?[:,]?\s+(.+)$/i)) || ctx.currentChat) {
    const body = m ? m[1]! : t
    if (ctx.currentChat) return { ...unknown(''), action: 'reply', message_text: capitalize(body) }
  }
  return unknown('Try "reply…", "tell Ali…" or "split 90 with Sara"')
}

/** Capitalize and fix the lower-case contractions speech-to-text often produces ("im", "dont"). */
function capitalize(s: string) {
  const x = s
    .trim()
    .replace(/\bi\b/g, 'I')
    .replace(/\b(i|you|we|they)m\b/gi, (_m, w: string) => `${w === 'i' ? 'I' : w}'m`)
    .replace(/\bim\b/gi, "I'm")
    .replace(/\b(don|can|won|isn|aren|didn|doesn|wasn|couldn|shouldn|wouldn)t\b/gi, "$1't")
  return x.charAt(0).toUpperCase() + x.slice(1)
}


export function heuristicTriage(c: Chat): Triage[string] {
  const text = c.lastText.toLowerCase()
  let priority: 'urgent' | 'normal' | 'low' = c.kind === 'user' ? 'normal' : 'low'
  if (c.muted || c.kind === 'channel') priority = 'low'
  else if (/\?|urgent|asap|now|blocking|@you|can you|please|pay|call me|today|tonight/.test(text)) priority = c.kind === 'user' || /@you|blocking|asap|urgent/.test(text) ? 'urgent' : 'normal'
  return { priority, summary: truncate(c.lastText, 48) }
}
