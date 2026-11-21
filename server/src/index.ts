import 'node:process'
import { pino } from 'pino'
import { AiService } from './ai.js'
import { buildApp } from './app.js'
import { Assistant, DEFAULT_SETTINGS, type SettingsData } from './assistant.js'
import { loadConfig } from './config.js'
import { EventHub } from './lib/events.js'
import type { Logger } from './lib/logger.js'
import { JsonStore } from './lib/store.js'
import { PaymentService, type PaymentsData } from './payments.js'
import { createStt } from './stt.js'
import { LiveTelegram, type SessionData } from './telegram/live.js'
import { MockTelegram } from './telegram/mock.js'
import type { TelegramService } from './telegram/types.js'
import { friendlyAddress, parseAddress, RateService, type RatesData, TonCenter } from './ton.js'

const VERSION = '1.0.0'

async function main() {
  const cfg = loadConfig()
  const log = pino({
    level: cfg.LOG_LEVEL,
    redact: ['req.headers.authorization', 'password', 'code', 'phone'],
    ...(cfg.PRETTY_LOGS ? { transport: { target: 'pino-pretty' } } : {}),
  }) as unknown as Logger

  const [sessionStore, paymentsStore, settingsStore, ratesStore] = await Promise.all([
    new JsonStore<SessionData>(cfg.DATA_DIR, 'session', { telegramSession: '' }).load(),
    new JsonStore<PaymentsData>(cfg.DATA_DIR, 'payments', { requests: [], seenTx: [] }).load(),
    new JsonStore<SettingsData>(cfg.DATA_DIR, 'settings', { ...DEFAULT_SETTINGS, defaultFiat: cfg.DEFAULT_FIAT }).load(),
    new JsonStore<RatesData>(cfg.DATA_DIR, 'rates', { lastKnown: {} }).load(),
  ])
  if (!settingsStore.get().walletAddress && cfg.TON_WALLET_ADDRESS) {
    const addr = friendlyAddress(parseAddress(cfg.TON_WALLET_ADDRESS), cfg.TON_NETWORK)
    await settingsStore.update(s => { s.walletAddress = addr })
  }

  const hub = new EventHub()
  const tg: TelegramService =
    cfg.TELEGRAM_MODE === 'live'
      ? new LiveTelegram(cfg.TG_API_ID!, cfg.TG_API_HASH, sessionStore, log.child({ mod: 'telegram' }))
      : new MockTelegram()
  const ai = new AiService(
    cfg.LLM_BASE_URL ? { baseUrl: cfg.LLM_BASE_URL, model: cfg.LLM_MODEL, apiKey: cfg.LLM_API_KEY, timeoutMs: cfg.LLM_TIMEOUT_MS, fastMs: cfg.LLM_FAST_MS } : null,
    log.child({ mod: 'ai' }),
  )
  const stt = createStt(cfg)
  void stt?.prepare?.().then(() => log.info({ stt: stt.name }, 'speech-to-text ready'))
  const rates = new RateService(log.child({ mod: 'rates' }), ratesStore)
  const toncenter = new TonCenter(cfg.TON_NETWORK, cfg.TONCENTER_API_KEY)
  const payments = new PaymentService(paymentsStore, toncenter, hub, log.child({ mod: 'payments' }), cfg.PAYMENT_POLL_MS)
  const assistant = new Assistant(tg, ai, stt, payments, rates, settingsStore, cfg.TON_NETWORK, log.child({ mod: 'assistant' }), toncenter)

  // Push incoming messages to the glasses, flagged urgent by triage.
  tg.onMessage(async ({ chat, message }) => {
    // Demo realism: in mock mode a friend who says they're paying, pays.
    if (tg instanceof MockTelegram && /sending now/i.test(message.text)) {
      const req = payments.list().find(r => r.chatId === chat.id && r.status === 'pending')
      if (req) setTimeout(() => void payments.markPaid(req.id, `demo-${Date.now()}`), 4000).unref()
    }
    // Only chats the user picked reach the glasses (all chats if none picked).
    if (!assistant.inFocus(chat.id)) return
    let urgent = false
    try {
      urgent = (await ai.triage([chat]))[chat.id]?.priority === 'urgent'
    } catch { /* triage is best-effort */ }
    hub.publish({ type: 'message', chatId: chat.id, chatTitle: chat.title, from: message.from, text: message.text.slice(0, 200), urgent })
  })

  await tg.start()
  hub.publish({ type: 'telegram', status: tg.status().state })
  payments.start()

  const app = await buildApp({
    token: cfg.APP_TOKEN, corsOrigins: cfg.CORS_ORIGINS, network: cfg.TON_NETWORK,
    tg, ai, stt, assistant, payments, settings: settingsStore, hub, logger: log, version: VERSION,
  })
  await app.listen({ port: cfg.PORT, host: cfg.HOST })
  log.info(
    { telegram: cfg.TELEGRAM_MODE, ai: ai.model ?? 'rules', stt: stt?.name ?? 'disabled', ton: cfg.TON_NETWORK },
    `Glance server v${VERSION} ready`,
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    const force = setTimeout(() => process.exit(1), 10_000)
    force.unref()
    payments.stop()
    await app.close().catch(() => {})
    await tg.stop().catch(() => {})
    await Promise.all([sessionStore.flush(), paymentsStore.flush(), settingsStore.flush(), ratesStore.flush()])
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', err => log.error({ err }, 'unhandled rejection'))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
