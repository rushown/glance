import { timingSafeEqual } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify'
import { z, ZodError } from 'zod'
import type { AiService } from './ai.js'
import type { Assistant, SettingsData } from './assistant.js'
import { badRequest, HttpError, notFound } from './lib/errors.js'
import type { EventHub, HubEvent } from './lib/events.js'
import type { Logger } from './lib/logger.js'
import type { JsonStore } from './lib/store.js'
import type { PaymentService } from './payments.js'
import { MAX_PCM_BYTES, type SttProvider } from './stt.js'
import { MockTelegram } from './telegram/mock.js'
import type { TelegramService } from './telegram/types.js'
import { explorerUrl, friendlyAddress, nanoToTon, parseAddress, type TonNetwork } from './ton.js'

export interface AppDeps {
  token: string
  corsOrigins: string
  network: TonNetwork
  tg: TelegramService
  ai: AiService
  stt: SttProvider | null
  assistant: Assistant
  payments: PaymentService
  settings: JsonStore<SettingsData>
  hub: EventHub
  logger?: Logger
  version?: string
}

const TG_ERRORS: Record<string, string> = {
  PHONE_CODE_INVALID: 'That login code is not correct',
  PHONE_CODE_EXPIRED: 'That login code expired, request a new one',
  PHONE_NUMBER_INVALID: 'That phone number is not valid',
  PHONE_NUMBER_BANNED: 'This phone number is banned by Telegram',
  PASSWORD_HASH_INVALID: 'Wrong two-step verification password',
  API_ID_INVALID: 'Server TG_API_ID / TG_API_HASH are invalid',
  AUTH_KEY_UNREGISTERED: 'Telegram session expired, log in again',
  CHAT_WRITE_FORBIDDEN: 'You cannot write in this chat',
  USER_IS_BLOCKED: 'This user has blocked you',
}

function telegramMessage(code: string) {
  const flood = code.match(/^FLOOD_WAIT_(\d+)$/)
  if (flood) return `Telegram rate limit, try again in ${flood[1]}s`
  return TG_ERRORS[code] ?? `Telegram error: ${code}`
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...(d.logger ? { loggerInstance: d.logger } : { logger: false }),
    trustProxy: true,
    // Default request logs would include ?token= on the SSE route; we log our own sanitized line instead.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: 60_000,
  })

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_PCM_BYTES + 1024 }, (_req, body, done) =>
    done(null, body),
  )

  await app.register(cors, {
    origin: d.corsOrigins === '*' ? true : d.corsOrigins.split(',').map(s => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  })
  await app.register(rateLimit, { global: true, max: 240, timeWindow: '1 minute' })

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return
    req.log.info(
      { method: req.method, url: req.url.replace(/token=[^&]*/g, 'token=***'), status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    )
  })

  // ── Auth ────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/') || req.method === 'OPTIONS') return
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    // EventSource cannot send headers, so the SSE route alone accepts ?token=
    const query = req.url.startsWith('/api/events') ? ((req.query as { token?: string }).token ?? '') : ''
    if (!safeEqual(bearer || query, d.token)) throw new HttpError(401, 'Invalid or missing token', 'unauthorized')
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message })
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') })
    const rpc = (err as { errorMessage?: string }).errorMessage
    if (rpc) return reply.status(400).send({ error: 'telegram', message: telegramMessage(rpc) })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: 'request', message: (err as Error).message })
    req.log.error({ err }, 'unhandled error')
    const msg = (err as Error).message ?? ''
    if (/Telegram not ready/.test(msg)) return reply.status(503).send({ error: 'telegram_not_ready', message: msg })
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' })
  })

  // ── Health & status ──────────────────────────────────────────────────
  app.get('/health', async () => ({ ok: true }))

  app.get('/api/status', async () => {
    const s = d.settings.get()
    return {
      version: d.version ?? '1.0.0',
      telegram: d.tg.status(),
      ai: d.ai.model,
      stt: d.stt?.name ?? null,
      ton: { network: d.network, wallet: s.walletAddress || null },
      defaultFiat: s.defaultFiat,
    }
  })

  // ── Inbox ───────────────────────────────────────────────────────────
  app.get('/api/inbox', async req => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(20).default(12) }).parse(req.query)
    return { chats: await d.assistant.inbox(limit) }
  })

  // Every chat (for the phone's "focus chats" picker), focus first.
  app.get('/api/chats', async () => {
    const focus = new Set(d.settings.get().focusChatIds ?? [])
    const chats = await d.tg.listChats(100)
    return {
      chats: chats
        .map(c => ({ id: c.id, title: c.title, kind: c.kind, unread: c.unread, muted: Boolean(c.muted), lastDate: c.lastDate, focused: focus.has(c.id) }))
        .sort((a, b) => Number(b.focused) - Number(a.focused) || b.lastDate - a.lastDate),
    }
  })

  app.post('/api/chats/:id/drafts', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async req => {
    const { id } = z.object({ id: z.string().min(1).max(32) }).parse(req.params)
    return { plans: await d.assistant.drafts(id) }
  })

  app.get('/api/chats/:id/messages', async req => {
    const { id } = z.object({ id: z.string().min(1).max(32) }).parse(req.params)
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(15) }).parse(req.query)
    const chat = await d.tg.getChat(id)
    if (!chat) throw notFound('Chat not found')
    return { chat, messages: await d.tg.getMessages(id, limit) }
  })

  app.post('/api/chats/:id/read', async req => {
    const { id } = z.object({ id: z.string().min(1).max(32) }).parse(req.params)
    await d.tg.markRead(id)
    return { ok: true }
  })

  // ── Voice & commands ─────────────────────────────────────────────────
  app.post(
    '/api/voice',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async req => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send raw PCM as application/octet-stream')
      const { chatId } = z.object({ chatId: z.string().max(32).optional() }).parse(req.query)
      const transcript = await d.assistant.transcribe(req.body)
      if (!transcript) return { transcript: '', result: { type: 'clarify', body: 'I did not catch that' } }
      return { transcript, result: await d.assistant.command(transcript, chatId) }
    },
  )

  app.post('/api/command', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const body = z.object({ text: z.string().min(1).max(500), chatId: z.string().max(32).optional() }).parse(req.body)
    return { transcript: body.text, result: await d.assistant.command(body.text, body.chatId) }
  })

  app.post('/api/plans/:id/execute', async req => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return d.assistant.execute(id)
  })

  app.get('/api/digest', async req => {
    const { kind } = z.object({ kind: z.enum(['inbox', 'channels']).default('inbox') }).parse(req.query)
    return { body: await d.assistant.digest(kind) }
  })

  // ── Payments ────────────────────────────────────────────────────────
  app.get('/api/payments', async () => ({
    summary: await d.assistant.paymentsReport(),
    requests: d.payments.list().map(r => ({
      ...r,
      ton: nanoToTon(r.nano),
      txUrl: r.txHash && !r.txHash.startsWith('demo-') ? explorerUrl(d.network, 'tx', r.txHash) : null,
    })),
  }))
  app.get('/api/wallet', async () => {
    const w = await d.assistant.walletInfo()
    return { ...w, explorer: w.address ? explorerUrl(d.network, 'address', w.address) : null }
  })
  app.post('/api/payments/:id/cancel', async req => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const r = await d.payments.cancel(id)
    if (!r) throw notFound('No pending request with that id')
    return { ok: true }
  })
  app.post('/api/payments/poll', async () => ({ matched: await d.payments.poll() }))

  // ── Settings ────────────────────────────────────────────────────────
  app.get('/api/settings', async () => d.settings.get())
  app.put('/api/settings', async req => {
    const body = z
      .object({
        walletAddress: z.string().max(100).optional(),
        defaultFiat: z.string().regex(/^[A-Za-z]{3}$/).optional(),
        focusChatIds: z.array(z.string().min(1).max(32)).max(50).optional(),
      })
      .parse(req.body)
    let wallet: string | undefined
    if (body.walletAddress !== undefined) {
      try {
        wallet = body.walletAddress.trim() ? friendlyAddress(parseAddress(body.walletAddress), d.network) : ''
      } catch (err) {
        throw badRequest((err as Error).message, 'invalid_address')
      }
    }
    await d.settings.update(s => {
      if (wallet !== undefined) s.walletAddress = wallet
      if (body.defaultFiat) s.defaultFiat = body.defaultFiat.toUpperCase()
      if (body.focusChatIds) s.focusChatIds = [...new Set(body.focusChatIds)]
    })
    return d.settings.get()
  })

  // ── Telegram login ───────────────────────────────────────────────────
  const loginLimit = { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }
  app.post('/api/telegram/login/request-code', loginLimit, async req => {
    const { phone } = z.object({ phone: z.string().regex(/^\+?[0-9 ()-]{6,20}$/) }).parse(req.body)
    await d.tg.requestCode(phone.replace(/[ ()-]/g, ''))
    return d.tg.status()
  })
  app.post('/api/telegram/login/code', loginLimit, async req => {
    const { code } = z.object({ code: z.string().regex(/^[0-9]{4,8}$/) }).parse(req.body)
    await d.tg.submitCode(code)
    return d.tg.status()
  })
  app.post('/api/telegram/login/password', loginLimit, async req => {
    const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body)
    await d.tg.submitPassword(password)
    return d.tg.status()
  })
  app.post('/api/telegram/logout', async () => {
    await d.tg.logout()
    return d.tg.status()
  })

  // ── Server-sent events ───────────────────────────────────────────────
  app.get('/api/events', { config: { rateLimit: false } }, (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
    })
    const send = (e: HubEvent) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    send({ type: 'telegram', status: d.tg.status().state })
    const unsubscribe = d.hub.subscribe(send)
    const ping = setInterval(() => send({ type: 'ping' }), 20_000)
    req.raw.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
    reply.hijack()
  })

  // ── Demo helpers (mock Telegram only) ────────────────────────────────
  if (d.tg instanceof MockTelegram) {
    const mock = d.tg
    app.post('/api/demo/incoming', async req => {
      const { chatId, text } = z.object({ chatId: z.string(), text: z.string().min(1).max(500) }).parse(req.body)
      mock.receive(chatId, text)
      return { ok: true }
    })
    app.post('/api/demo/payments/:id/paid', async req => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
      const r = await d.payments.markPaid(id, `demo-${Date.now()}`)
      if (!r) throw notFound('No pending request with that id')
      return { ok: true }
    })
  }

  return app
}
