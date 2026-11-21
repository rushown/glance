import { randomUUID } from 'node:crypto'
import type { AiService, Intent, Triage } from './ai.js'
import { truncate } from './ai.js'
import { badRequest, notFound, unavailable } from './lib/errors.js'
import type { Logger } from './lib/logger.js'
import type { JsonStore } from './lib/store.js'
import { newCode, type PaymentRequest, type PaymentService } from './payments.js'
import type { SttProvider } from './stt.js'
import { MAX_PCM_BYTES, pcmLevel } from './stt.js'
import { friendlyAddress, nanoToTon, parseAddress, paymentLink, type RateService, type TonCenter, type TonNetwork, tonToNano } from './ton.js'
import { matchChats, type Chat, type TelegramService } from './telegram/types.js'

export interface SettingsData {
  walletAddress: string
  defaultFiat: string
  /** Chats picked on the phone. When non-empty, the glasses inbox and alerts show only these. */
  focusChatIds: string[]
}

export const DEFAULT_SETTINGS: SettingsData = { walletAddress: '', defaultFiat: 'USD', focusChatIds: [] }

export interface Target {
  chatId: string
  title: string
}

export type Plan =
  | { id: string; kind: 'send'; title: string; body: string; targets: Target[]; text: string }
  | {
      id: string
      kind: 'payment_request'
      title: string
      body: string
      targets: Target[]
      nanoEach: string
      fiatEach: number | null
      fiat: string | null
      note: string
    }

export type CommandResult =
  | { type: 'confirm'; plan: Plan }
  | { type: 'open_chat'; chatId: string; title: string }
  | { type: 'info'; title: string; body: string }
  | { type: 'clarify'; body: string }

export interface InboxItem extends Chat {
  priority: Triage[string]['priority']
  summary: string
}

const PLAN_TTL_MS = 5 * 60_000
const PRIORITY_RANK = { urgent: 0, normal: 1, low: 2 } as const

/**
 * Orchestrates voice → transcript → intent → plan → (user confirms) → execute.
 * Nothing is ever sent or requested without an explicit confirmation from
 * the glasses, and plans are held server-side so the client cannot tamper
 * with recipients or amounts between preview and execution.
 */
export class Assistant {
  private plans = new Map<string, { plan: Plan; expires: number }>()

  constructor(
    private readonly tg: TelegramService,
    private readonly ai: AiService,
    private readonly stt: SttProvider | null,
    private readonly payments: PaymentService,
    private readonly rates: RateService,
    private readonly settings: JsonStore<SettingsData>,
    private readonly network: TonNetwork,
    private readonly log: Logger,
    private readonly ton?: Pick<TonCenter, 'balance'>,
  ) {}

  /** Focus filter: true if this chat should reach the glasses. */
  inFocus(chatId: string): boolean {
    const focus = this.settings.get().focusChatIds ?? []
    return focus.length === 0 || focus.includes(chatId)
  }

  // ── Inbox ─────────────────────────────────────────────────────────────
  async inbox(limit = 20): Promise<InboxItem[]> {
    const chats = (await this.tg.listChats(Math.max(limit, 40))).filter(c => this.inFocus(c.id))
    const triage = await this.ai.triage(chats)
    return chats
      .map(c => ({ ...c, priority: triage[c.id]?.priority ?? 'normal', summary: triage[c.id]?.summary ?? truncate(c.lastText, 48) }))
      .sort((a, b) => {
        const ua = a.unread > 0 ? 0 : 1
        const ub = b.unread > 0 ? 0 : 1
        return ua - ub || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.lastDate - a.lastDate
      })
      .slice(0, limit)
  }

  // ── Voice ─────────────────────────────────────────────────────────────
  async transcribe(pcm: Buffer): Promise<string> {
    if (!this.stt) throw unavailable('Speech-to-text is not configured on the server', 'stt_disabled')
    if (pcm.length < 16_000 * 2 * 0.3) throw badRequest('Recording too short', 'too_short')
    if (pcm.length > MAX_PCM_BYTES) throw badRequest('Recording too long (max 60s)', 'too_long')
    if (pcmLevel(pcm) < 0.002) throw badRequest('Only silence was recorded', 'silence')
    return this.ai.whileHolding(this.stt.transcribe(pcm))
  }

  async command(transcript: string, currentChatId?: string): Promise<CommandResult> {
    const chats = await this.tg.listChats(100)
    let currentChat: { id: string; title: string; recent: { from: string; text: string }[] } | undefined
    if (currentChatId) {
      const chat = chats.find(c => c.id === currentChatId) ?? (await this.tg.getChat(currentChatId))
      if (chat) {
        const recent = await this.tg.getMessages(chat.id, 8)
        currentChat = { id: chat.id, title: chat.title, recent: recent.map(m => ({ from: m.from, text: m.text })) }
      }
    }
    const intent = await this.ai.parseCommand(transcript, {
      chats: chats.map(c => ({ id: c.id, title: c.title, kind: c.kind })),
      currentChat,
      defaultFiat: this.settings.get().defaultFiat,
    })
    this.log.info({ action: intent.action, recipients: intent.recipient_names.length }, 'voice intent')
    return this.planFor(intent, chats, currentChat)
  }

  private resolve(names: string[], chats: Chat[]): { targets: Target[]; missing: string[] } {
    const targets: Target[] = []
    const missing: string[] = []
    for (const name of names) {
      const best = matchChats(chats, name)[0]
      if (!best || best.score < 0.5) missing.push(name)
      else if (!targets.some(t => t.chatId === best.chat.id)) targets.push({ chatId: best.chat.id, title: best.chat.title })
    }
    return { targets, missing }
  }

  private remember<P extends Plan>(plan: P): P {
    const now = Date.now()
    for (const [id, p] of this.plans) if (p.expires < now) this.plans.delete(id)
    this.plans.set(plan.id, { plan, expires: now + PLAN_TTL_MS })
    return plan
  }

  private async planFor(intent: Intent, chats: Chat[], current?: { id: string; title: string }): Promise<CommandResult> {
    switch (intent.action) {
      case 'reply': {
        if (!current) return { type: 'clarify', body: 'Open a chat first, or say "tell <name> …"' }
        if (!intent.message_text) return { type: 'clarify', body: 'What should I reply?' }
        return {
          type: 'confirm',
          plan: this.remember({
            id: randomUUID(), kind: 'send', title: `Reply to ${current.title}`,
            body: intent.message_text, targets: [{ chatId: current.id, title: current.title }], text: intent.message_text,
          }),
        }
      }
      case 'send_message': {
        const { targets, missing } = this.resolve(intent.recipient_names, chats)
        if (missing.length) return { type: 'clarify', body: `Couldn't find ${missing.join(', ')} in your chats` }
        if (!targets.length) return { type: 'clarify', body: 'Who should I send it to?' }
        if (!intent.message_text) return { type: 'clarify', body: 'What should the message say?' }
        return {
          type: 'confirm',
          plan: this.remember({
            id: randomUUID(), kind: 'send', title: `To ${targets.map(t => t.title).join(', ')}`,
            body: intent.message_text, targets, text: intent.message_text,
          }),
        }
      }
      case 'split_bill':
      case 'request_payment':
        return this.planPayment(intent, chats)
      case 'open_chat': {
        const { targets } = this.resolve(intent.recipient_names.slice(0, 1), chats)
        const t = targets[0]
        if (!t) return { type: 'clarify', body: `Couldn't find "${intent.recipient_names[0] ?? ''}"` }
        return { type: 'open_chat', chatId: t.chatId, title: t.title }
      }
      case 'summarize':
        return { type: 'info', title: 'Catch-up', body: await this.digest() }
      case 'summarize_channels':
        return { type: 'info', title: 'Channels', body: await this.digest('channels') }
      case 'check_payments':
        return { type: 'info', title: 'Payments', body: await this.paymentsReport() }
      case 'check_balance':
        return { type: 'info', title: 'Wallet', body: await this.walletReport() }
      default:
        return { type: 'clarify', body: intent.clarification || 'Sorry, I did not get that' }
    }
  }

  private async planPayment(intent: Intent, chats: Chat[]): Promise<CommandResult> {
    const wallet = this.settings.get().walletAddress
    if (!wallet) return { type: 'clarify', body: 'Connect a TON wallet in the phone app first' }
    if (!intent.amount) return { type: 'clarify', body: 'How much? e.g. "split 240 dirhams with Ali"' }
    const { targets, missing } = this.resolve(intent.recipient_names, chats)
    if (missing.length) return { type: 'clarify', body: `Couldn't find ${missing.join(', ')} in your chats` }
    if (!targets.length) return { type: 'clarify', body: 'Who should pay?' }

    const currency = intent.currency ?? this.settings.get().defaultFiat
    const split = intent.action === 'split_bill'
    const shares = split ? targets.length + (intent.include_self ? 1 : 0) : 1
    const each = intent.amount / shares
    let tonEach: string
    try {
      tonEach = (await this.rates.toTon(each, currency)).ton
    } catch (err) {
      this.log.error({ err }, 'rate conversion failed')
      return { type: 'clarify', body: `Can't get the TON/${currency} rate right now` }
    }
    const isTon = currency === 'TON'
    const fiatEach = isTon ? null : Math.round(each * 100) / 100
    const eachLabel = isTon ? `${tonEach} TON` : `${fiatEach} ${currency} (${tonEach} TON)`
    const header = split
      ? `${intent.amount} ${currency} / ${shares}${intent.include_self ? ' incl. you' : ''}`
      : `${intent.amount} ${currency} each`
    const body = [header, ...targets.map(t => `${t.title}: ${eachLabel}`), intent.note ? `For: ${intent.note}` : '']
      .filter(Boolean)
      .join('\n')
    return {
      type: 'confirm',
      plan: this.remember({
        id: randomUUID(), kind: 'payment_request', title: split ? 'Split bill' : 'Request payment',
        body, targets, nanoEach: tonToNano(tonEach).toString(), fiatEach, fiat: isTon ? null : currency, note: intent.note,
      }),
    }
  }

  // ── Execution ─────────────────────────────────────────────────────────
  async execute(planId: string): Promise<{ title: string; body: string }> {
    const entry = this.plans.get(planId)
    if (!entry || entry.expires < Date.now()) throw notFound('This action expired, please try again')
    this.plans.delete(planId) // single use: a double-tap can never send twice
    const { plan } = entry
    if (plan.kind === 'send') {
      const sent: string[] = []
      const failed: string[] = []
      for (const t of plan.targets) {
        try {
          await this.tg.sendMessage(t.chatId, plan.text)
          sent.push(t.title)
        } catch (err) {
          this.log.error({ err, chatId: t.chatId }, 'send failed')
          failed.push(t.title)
        }
      }
      if (!sent.length) throw unavailable(`Could not send to ${failed.join(', ')}`)
      return { title: 'Sent', body: `Sent to ${sent.join(', ')}${failed.length ? `\nFailed: ${failed.join(', ')}` : ''}` }
    }
    return this.executePayment(plan)
  }

  private async executePayment(plan: Extract<Plan, { kind: 'payment_request' }>) {
    const address = friendlyAddress(parseAddress(this.settings.get().walletAddress), this.network)
    const nano = BigInt(plan.nanoEach)
    const ton = nanoToTon(nano)
    const requests: PaymentRequest[] = []
    const failed: string[] = []
    for (const t of plan.targets) {
      const code = newCode()
      const comment = plan.note ? `${code} ${truncate(plan.note, 60)}` : code
      const link = paymentLink(address, nano, comment)
      const first = t.title.split(' ')[0]
      const amountLine = plan.fiat ? `${plan.fiatEach} ${plan.fiat} ≈ ${ton} TON` : `${ton} TON`
      const text = [
        `Hi ${first}! ${plan.note ? `Your share for ${plan.note}` : 'Payment request'}: ${amountLine}`,
        '',
        `Pay with Gram Wallet or any TON wallet: ${link}`,
        '',
        `Or send ${ton} TON to ${address} with comment ${code}`,
        this.network === 'testnet' ? '(TON testnet, no real money)' : '',
      ]
        .filter((l, i, a) => l !== '' || a[i - 1] !== '')
        .join('\n')
        .trim()
      try {
        await this.tg.sendMessage(t.chatId, text)
        requests.push({
          id: randomUUID(), code, chatId: t.chatId, name: t.title, nano: nano.toString(),
          fiatAmount: plan.fiatEach, fiat: plan.fiat, note: plan.note, address, link,
          status: 'pending', createdAt: Math.floor(Date.now() / 1000),
        })
      } catch (err) {
        this.log.error({ err, chatId: t.chatId }, 'payment request message failed')
        failed.push(t.title)
      }
    }
    await this.payments.add(requests)
    if (!requests.length) throw unavailable(`Could not message ${failed.join(', ')}`)
    return {
      title: 'Requests sent',
      body: `${ton} TON requested from ${requests.map(r => r.name).join(', ')}${failed.length ? `\nFailed: ${failed.join(', ')}` : ''}\nI'll ping you when they pay.`,
    }
  }

  // ── Reply drafts ──────────────────────────────────────────────────────
  /** AI-drafted replies for a chat, each held as a one-tap send plan. */
  async drafts(chatId: string): Promise<Plan[]> {
    return (await this.draftsWithSource(chatId)).plans
  }

  async draftsWithSource(chatId: string): Promise<{ plans: Plan[]; source: 'model' | 'rules' }> {
    const chat = await this.tg.getChat(chatId)
    if (!chat) throw notFound('Chat not found')
    if (chat.kind === 'channel') return { plans: [], source: 'rules' }
    const messages = await this.tg.getMessages(chatId, 10)
    const { drafts: texts, source } = await this.ai.drafts(chat, messages)
    const plans = texts.map(text =>
      this.remember({ id: randomUUID(), kind: 'send', title: `Reply to ${chat.title}`, body: text, targets: [{ chatId, title: chat.title }], text }),
    )
    return { plans, source }
  }

  // ── Info ──────────────────────────────────────────────────────────────
  async digest(kind: 'inbox' | 'channels' = 'inbox'): Promise<string> {
    let pick: Chat[]
    if (kind === 'channels') {
      // Channels and big communities you follow, even if muted (that's where news lives).
      const all = (await this.tg.listChats(60)).filter(c => this.inFocus(c.id))
      pick = all.filter(c => c.unread > 0 && (c.kind === 'channel' || (c.kind === 'group' && c.unread >= 10))).slice(0, 6)
    } else {
      const inbox = await this.inbox(20)
      pick = inbox.filter(c => c.unread > 0 && c.priority !== 'low' && c.kind !== 'channel').slice(0, 5)
    }
    const items = await Promise.all(pick.map(async chat => ({ chat, messages: await this.tg.getMessages(chat.id, Math.min(Math.max(chat.unread, 1), 10)) })))
    return this.ai.digest(items, kind)
  }

  /** Last good balance per address; toncenter's keyless tier allows ~1 request/s, shared with payment polling. */
  private balanceCache = new Map<string, { at: number; ton: string }>()

  async walletInfo(): Promise<{ address: string | null; balanceTon: string | null; network: TonNetwork }> {
    const address = this.settings.get().walletAddress || null
    let balanceTon: string | null = null
    if (address && this.ton) {
      const hit = this.balanceCache.get(address)
      if (hit && Date.now() - hit.at < 30_000) return { address, balanceTon: hit.ton, network: this.network }
      try {
        balanceTon = nanoToTon(await this.ton.balance(address))
        this.balanceCache.set(address, { at: Date.now(), ton: balanceTon })
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'balance lookup failed')
        balanceTon = hit?.ton ?? null // a slightly stale balance beats none
      }
    }
    return { address, balanceTon, network: this.network }
  }

  async walletReport(): Promise<string> {
    const w = await this.walletInfo()
    if (!w.address) return 'No wallet connected.\nAdd your TON address in the phone app.'
    const short = `${w.address.slice(0, 6)}…${w.address.slice(-4)}`
    const bal = w.balanceTon !== null ? `${w.balanceTon} TON` : 'Balance unavailable'
    return `${bal}\n${short} · ${w.network}`
  }

  async paymentsReport(): Promise<string> {
    const w = await this.walletInfo()
    const head = w.balanceTon !== null ? `Wallet: ${w.balanceTon} TON (${w.network})` : ''
    return [head, this.paymentsSummary()].filter(Boolean).join('\n\n')
  }

  paymentsSummary(): string {
    const recent = this.payments.list().filter(r => r.status !== 'cancelled').slice(0, 8)
    if (!recent.length) return 'No payment requests yet.\nTry: "split 240 dirhams with Ali and Sara"'
    const pending = recent.filter(r => r.status === 'pending')
    const lines = recent.map(r => `${r.status === 'paid' ? '[x]' : '[ ]'} ${r.name}: ${nanoToTon(r.nano)} TON${r.note ? ` · ${truncate(r.note, 18)}` : ''}`)
    return [`${pending.length} pending, ${recent.length - pending.length} paid`, ...lines].join('\n')
  }
}
