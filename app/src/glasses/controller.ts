import { Api, ApiError } from '../lib/api'
import { type Glasses, H, type Input, type Page, type TextSpec, W } from '../lib/glasses'
import { Recorder, startBrowserMic } from '../lib/recorder'
import { clip, clock, fitBytes, formatChatLines, inboxLabel, ITEM_BYTES, levelBar, pageLines, paginate } from '../lib/text'
import type { CommandResult, InboxItem, Message, Plan, ServerEvent, Status } from '../lib/types'

type Back = { name: 'inbox' } | { name: 'chat'; chatId: string; title: string }

type Screen =
  | { name: 'boot' }
  | { name: 'setup'; reason: string }
  | { name: 'inbox' }
  | { name: 'chat'; chatId: string; title: string; pages: string[]; page: number; kind: InboxItem['kind'] }
  | { name: 'reply'; chatId: string; title: string; context: string; plans: Plan[] }
  | { name: 'listening'; chatId?: string; back: Back; viaHold: boolean }
  | { name: 'working'; back: Back; token: number }
  | { name: 'confirm'; plan: Plan; back: Back }
  | { name: 'info'; title: string; pages: string[]; page: number; back: Back; retry?: { chatId?: string }; auto?: boolean }

type InboxAction = { act: 'voice' } | { act: 'chat'; chat: InboxItem } | { act: 'payments' } | { act: 'digest' } | { act: 'channels' }

// Layout measured in the Even Hub simulator: ~26 px per text line.
const HDR_H = 32
const BODY_Y = 34
const FOOT_H = 30
const PAGE_LINES = 7
const MAX_INBOX_CHATS = 16 // 20 list items max: speak + 16 chats + payments + catch-up + channels

const hdr = (content: string): TextSpec => ({ name: 'hdr', x: 0, y: 0, w: W, h: HDR_H, content })
const body = (content: string, h = H - BODY_Y - FOOT_H - 2): TextSpec => ({ name: 'body', x: 0, y: BODY_Y, w: W, h, content, border: true })
const foot = (content: string): TextSpec => ({ name: 'foot', x: 0, y: H - FOOT_H, w: W, h: FOOT_H, content, brightness: 2 })
const SPEAK_REPLY = '● Speak a reply'

export interface ControllerState {
  screen: Screen['name']
  status: Status | null
  online: boolean
  lastTranscript: string
  error: string
}

/**
 * Drives everything shown on the glasses. One screen at a time; every input
 * is routed by the active screen. Network work is async but guarded so a
 * stale response can never overwrite a newer screen.
 */
export class Controller {
  private screen: Screen = { name: 'boot' }
  private inbox: InboxItem[] = []
  private actions: InboxAction[] = []
  private status: Status | null = null
  private online = false
  private recorder = new Recorder()
  private stopBrowserMic?: () => void
  private listenTick?: ReturnType<typeof setInterval>
  private headerBase = 'GLANCE'
  private toastTimer?: ReturnType<typeof setTimeout>
  private autoTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private clockTimer?: ReturnType<typeof setInterval>
  private lastInputAt = 0
  private workToken = 0
  private lastTranscript = ''
  private lastError = ''
  private stopEvents?: () => void
  private listeners = new Set<(s: ControllerState) => void>()
  private disposed = false
  /** Reply drafts are fetched as soon as a chat opens, so a tap shows them instantly. */
  private drafts = new Map<string, { key: string; at: number; plans: Promise<{ plans: Plan[]; source: 'model' | 'rules' }> }>()

  constructor(
    private readonly g: Glasses,
    readonly api: Api,
  ) {
    g.onInput(i => this.onInput(i))
    g.onAudio(pcm => this.onPcm(pcm))
  }

  // ── Public API (used by the phone UI) ─────────────────────────────────
  onState(fn: (s: ControllerState) => void) {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  private snapshot(): ControllerState {
    return { screen: this.screen.name, status: this.status, online: this.online, lastTranscript: this.lastTranscript, error: this.lastError }
  }

  private changed() {
    const s = this.snapshot()
    for (const fn of this.listeners) fn(s)
  }

  async start() {
    this.clockTimer = setInterval(() => this.tickClock(), 30_000)
    await this.boot()
  }

  /** Re-run startup (after settings change or on retry). */
  async boot() {
    this.stopEvents?.()
    this.stopEvents = undefined
    await this.show({ name: 'boot' })
    if (!this.api.configured) {
      return this.show({ name: 'setup', reason: 'Open Glance on your phone\nand connect your server.' })
    }
    try {
      this.status = await this.api.status()
      this.online = true
      this.lastError = ''
    } catch (err) {
      this.online = false
      this.lastError = describe(err)
      return this.show({ name: 'setup', reason: `Can't reach server:\n${describe(err)}` })
    }
    this.stopEvents = this.api.events(
      e => this.onServerEvent(e),
      connected => { this.online = connected; this.changed() },
    )
    if (this.status.telegram.state !== 'ready') {
      return this.show({ name: 'setup', reason: `Telegram: ${humanTgState(this.status.telegram.state)}\nFinish login in the phone app.` })
    }
    await this.openInbox()
  }

  /** Run a typed command exactly like a voice command (phone UI + demos). */
  async runText(text: string) {
    const back = this.backFromHere()
    const chatId = back.name === 'chat' ? back.chatId : undefined
    const token = await this.working(back, `"${clip(text, 80)}"\n\nThinking…`)
    try {
      const res = await this.api.command(text, chatId)
      if (token !== this.workToken) return
      this.lastTranscript = res.transcript
      await this.handleResult(res.result, res.transcript, back)
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  startVoice() {
    void this.startListening(this.backFromHere(), false)
  }

  dispose() {
    this.disposed = true
    this.stopEvents?.()
    this.stopMic()
    clearInterval(this.clockTimer)
    clearTimeout(this.toastTimer)
    clearTimeout(this.autoTimer)
    clearTimeout(this.refreshTimer)
    this.listeners.clear()
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  private async show(next: Screen) {
    if (this.disposed) return
    clearTimeout(this.autoTimer)
    this.screen = next
    const page = this.layout(next)
    this.headerBase = page.texts.find(t => t.name === 'hdr')?.content ?? 'GLANCE'
    clearTimeout(this.toastTimer)
    this.toastTimer = undefined
    await this.g.render(page)
    this.changed()
  }

  private layout(s: Screen): Page {
    switch (s.name) {
      case 'boot':
        return { texts: [hdr(this.inboxHeader()), body('Connecting…')], capture: 'body' }
      case 'setup':
        return { texts: [hdr('GLANCE · setup'), body(s.reason), foot('tap: retry · 2x: exit')], capture: 'body' }
      case 'inbox': {
        this.actions = [
          { act: 'voice' },
          ...this.inbox.slice(0, MAX_INBOX_CHATS).map(chat => ({ act: 'chat', chat }) as const),
          { act: 'digest' },
          { act: 'channels' },
          { act: 'payments' },
        ]
        const items = this.actions.map(a =>
          a.act === 'voice' ? '▶ Speak a command'
            : a.act === 'chat' ? inboxLabel(a.chat)
              : a.act === 'payments' ? '■ Payments & wallet'
                : a.act === 'digest' ? '▶ Catch me up'
                  : '▶ Channel digest',
        )
        return { texts: [hdr(this.inboxHeader())], list: { name: 'inbox', x: 0, y: BODY_Y, w: W, h: H - BODY_Y, items }, capture: 'inbox' }
      }
      case 'chat': {
        const pager = s.pages.length > 1 ? ` ${s.page + 1}/${s.pages.length}` : ''
        const hint = s.kind === 'channel' ? 'swipe: scroll · 2x: back' : 'tap: reply · hold: speak · 2x: back'
        return {
          texts: [hdr(`‹ ${clip(s.title, 30)}${pager}`), body(s.pages[s.page] ?? ''), foot(hint)],
          capture: 'body',
        }
      }
      case 'reply': {
        // Last incoming message for context, then one-tap AI drafts.
        const items = [...s.plans.map(p => fitBytes(p.body, ITEM_BYTES)), SPEAK_REPLY]
        return {
          texts: [hdr(`Reply to ${clip(s.title, 28)}`), { name: 'ctx', x: 0, y: BODY_Y, w: W, h: 60, content: s.context, brightness: 2 }],
          list: { name: 'reply', x: 0, y: BODY_Y + 62, w: W, h: H - BODY_Y - 62, items },
          capture: 'reply',
        }
      }
      case 'listening':
        return {
          texts: [hdr(s.chatId && s.back.name === 'chat' ? `● Reply to ${clip(s.back.title, 24)}` : '● Listening'), body(this.listeningText()), foot('tap: done · 2x: cancel')],
          capture: 'body',
        }
      case 'working':
        return { texts: [hdr('GLANCE'), body('Working…')], capture: 'body' }
      case 'confirm': {
        const text = s.plan.kind === 'send' ? `“${s.plan.body}”` : s.plan.body
        const items = s.plan.kind === 'send' ? ['Send', 'Cancel'] : ['Send requests', 'Cancel']
        return {
          texts: [hdr(clip(s.plan.title, 40)), body(paginate(text, 6)[0] ?? '', 168)],
          list: { name: 'choice', x: 0, y: 206, w: W, h: H - 206, items },
          capture: 'choice',
        }
      }
      case 'info': {
        const pager = s.pages.length > 1 ? ` ${s.page + 1}/${s.pages.length}` : ''
        const hint = s.retry ? 'tap: try again · 2x: back' : s.pages.length > 1 ? 'swipe: more · tap: back' : 'tap: back'
        return { texts: [hdr(`${clip(s.title, 36)}${pager}`), body(s.pages[s.page] ?? ''), foot(s.auto ? '' : hint)], capture: 'body' }
      }
    }
  }

  private inboxHeader() {
    const urgent = this.inbox.filter(c => c.priority === 'urgent' && c.unread > 0).length
    const unread = this.inbox.reduce((n, c) => n + (c.unread > 0 && !c.muted ? 1 : 0), 0)
    const parts = ['GLANCE']
    if (urgent) parts.push(`${urgent} urgent`)
    else if (unread) parts.push(`${unread} unread`)
    else if (this.inbox.length) parts.push('all caught up')
    if (!this.online && this.status) parts.push('offline')
    parts.push(clock())
    return parts.join(' · ')
  }

  private tickClock() {
    if (this.screen.name === 'inbox' && !this.toastTimer) {
      this.headerBase = this.inboxHeader()
      void this.g.setText('hdr', this.headerBase)
    }
  }

  private toast(text: string, ms = 6000) {
    if (!this.g.hasText('hdr') || this.screen.name === 'listening') return
    clearTimeout(this.toastTimer)
    void this.g.setText('hdr', clip(text, 52))
    this.toastTimer = setTimeout(() => {
      this.toastTimer = undefined
      if (this.screen.name === 'inbox') this.headerBase = this.inboxHeader()
      void this.g.setText('hdr', this.headerBase)
    }, ms)
  }

  // ── Screens ──────────────────────────────────────────────────────────
  private async openInbox() {
    try {
      const { chats } = await this.api.inbox(17)
      this.inbox = chats
      this.online = true
    } catch (err) {
      if (!this.inbox.length) return this.fail(err, { name: 'inbox' }, true)
      this.toast(`Offline: ${describe(err)}`)
    }
    await this.show({ name: 'inbox' })
  }

  private async openChat(chatId: string, title: string, keepPage = false) {
    try {
      const { messages, chat } = await this.api.messages(chatId, 14)
      const lines = formatChatLines(messages, undefined, chat.kind)
      const pages = pageLines(lines.length ? lines : ['No messages yet.'], PAGE_LINES)
      const cur = this.screen
      const page = keepPage && cur.name === 'chat' && cur.chatId === chatId ? Math.min(cur.page, pages.length - 1) : pages.length - 1
      if (chat.kind !== 'channel') this.prefetchDrafts(chatId, messages.at(-1)?.id ?? 0)
      this.lastIncoming.set(chatId, [...messages].reverse().find(m => !m.out))
      await this.show({ name: 'chat', chatId, title: chat.title || title, pages, page, kind: chat.kind })
      if (chat.unread > 0) void this.api.markRead(chatId).catch(() => {})
      const cached = this.inbox.find(c => c.id === chatId)
      if (cached) cached.unread = 0
    } catch (err) {
      await this.fail(err, { name: 'inbox' })
    }
  }

  private lastIncoming = new Map<string, Message | undefined>()

  private prefetchDrafts(chatId: string, lastId: number) {
    const key = `${chatId}:${lastId}`
    if (this.drafts.get(chatId)?.key === key) return
    const plans = this.api.drafts(chatId).then(
      r => ({ plans: r.plans, source: r.source ?? ('model' as const) }),
      () => ({ plans: [] as Plan[], source: 'rules' as const }),
    )
    this.drafts.set(chatId, { key, at: Date.now(), plans })
  }

  private async openReply(chatId: string, title: string) {
    const back: Back = { name: 'chat', chatId, title }
    let entry = this.drafts.get(chatId)
    if (!entry) {
      this.prefetchDrafts(chatId, -1)
      entry = this.drafts.get(chatId)!
    }
    // Usually ready already (prefetched when the chat opened); otherwise show progress.
    const ready = await Promise.race([entry.plans.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 150))])
    let token = this.workToken
    if (!ready) token = await this.working(back, 'Drafting replies…')
    let { plans, source } = await entry.plans
    if (source === 'rules' && Date.now() - entry.at > 1500) {
      // A slow local model may have finished since: the server answers instantly from its cache.
      const fresh = await Promise.race([
        this.api.drafts(chatId).catch(() => null),
        new Promise<null>(r => setTimeout(() => r(null), 1500)),
      ])
      if (fresh?.plans.length) {
        plans = fresh.plans
        source = fresh.source ?? 'model'
        this.drafts.set(chatId, { key: entry.key, at: Date.now(), plans: Promise.resolve({ plans, source }) })
      }
    }
    if (token !== this.workToken) return
    const last = this.lastIncoming.get(chatId)
    const context = last ? `${clip(last.from.split(' ')[0] ?? '', 12)}: ${clip(last.text, 96)}` : 'Pick a reply or speak your own'
    await this.show({ name: 'reply', chatId, title, context, plans: plans.slice(0, 3) })
  }

  private async openPayments(back: Back) {
    const token = await this.working(back, 'Checking payments…')
    try {
      await this.api.pollPayments().catch(() => {})
      const { summary } = await this.api.payments()
      if (token !== this.workToken) return
      await this.show({ name: 'info', title: 'Payments', pages: paginate(summary, PAGE_LINES), page: 0, back })
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  private async openDigest(back: Back, kind: 'inbox' | 'channels' = 'inbox') {
    const token = await this.working(back, kind === 'channels' ? 'Reading your channels…' : 'Catching you up…')
    try {
      const { body: text } = await this.api.digest(kind)
      if (token !== this.workToken) return
      await this.show({ name: 'info', title: kind === 'channels' ? 'Channels' : 'Catch-up', pages: paginate(text, PAGE_LINES), page: 0, back })
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  private async working(back: Back, text: string): Promise<number> {
    const token = ++this.workToken
    await this.show({ name: 'working', back, token })
    await this.g.setText('body', text)
    return token
  }

  private async goBack(back: Back) {
    if (back.name === 'chat') return this.openChat(back.chatId, back.title, true)
    return this.openInbox()
  }

  private backFromHere(): Back {
    const s = this.screen
    if (s.name === 'chat' || s.name === 'reply') return { name: 'chat', chatId: s.chatId, title: s.title }
    if ('back' in s) return s.back
    return { name: 'inbox' }
  }

  private async fail(err: unknown, back: Back, retryBoot = false) {
    this.lastError = describe(err)
    if (err instanceof ApiError && err.code === 'telegram_not_ready') {
      return this.show({ name: 'setup', reason: 'Telegram disconnected.\nLog in again in the phone app.' })
    }
    if (retryBoot) return this.show({ name: 'setup', reason: `Can't load inbox:\n${describe(err)}` })
    await this.show({ name: 'info', title: 'Something went wrong', pages: paginate(describe(err), PAGE_LINES), page: 0, back })
  }

  // ── Voice ─────────────────────────────────────────────────────────────
  private listeningText() {
    const secs = Math.floor(this.recorder.seconds)
    const hint = this.recorder.speechDetected ? 'Got it… pause when done' : 'Speak now'
    const examples = this.screen.name === 'listening' && this.screen.chatId
      ? 'e.g. "On my way, 10 minutes"'
      : 'e.g. "Tell Ali I booked the table"\n"Split 240 dirhams with Ali and Sara"\n"What did I miss?"'
    return `${hint}   0:${String(secs).padStart(2, '0')}\n${levelBar(this.recorder.level)}\n\n${examples}`
  }

  private async startListening(back: Back, viaHold: boolean) {
    if (this.screen.name === 'listening' || this.screen.name === 'working') return
    if (this.status && !this.status.stt) {
      return this.show({ name: 'info', title: 'Voice unavailable', pages: ['Speech-to-text is not configured on the server.\nSet STT_API_KEY in the server .env.'], page: 0, back })
    }
    const chatId = back.name === 'chat' ? back.chatId : undefined
    this.recorder.start()
    await this.show({ name: 'listening', chatId, back, viaHold })
    const ok = await this.g.mic(true)
    if (!ok) {
      return this.show({ name: 'info', title: 'Microphone error', pages: ['Could not open the glasses microphone.'], page: 0, back, retry: { chatId } })
    }
    if (this.g.emulated) {
      try {
        this.stopBrowserMic = await startBrowserMic(pcm => this.g.pushEmulatedAudio(pcm))
      } catch {
        await this.g.mic(false)
        return this.show({ name: 'info', title: 'Microphone blocked', pages: ['Allow microphone access in the browser,\nor type a command in the phone panel.'], page: 0, back })
      }
    }
    clearInterval(this.listenTick)
    this.listenTick = setInterval(() => {
      if (this.screen.name === 'listening') void this.g.setText('body', this.listeningText())
    }, 450)
  }

  private stopMic() {
    clearInterval(this.listenTick)
    this.listenTick = undefined
    this.stopBrowserMic?.()
    this.stopBrowserMic = undefined
    void this.g.mic(false)
  }

  private onPcm(pcm: Uint8Array) {
    if (this.screen.name !== 'listening') return
    const r = this.recorder.push(pcm)
    if (r === 'stop') void this.finishListening()
    else if (r === 'timeout') void this.cancelListening("Didn't hear anything.")
  }

  private async cancelListening(reason?: string) {
    const s = this.screen
    if (s.name !== 'listening') return
    this.stopMic()
    if (reason) await this.show({ name: 'info', title: 'Listening stopped', pages: [reason], page: 0, back: s.back, retry: { chatId: s.chatId } })
    else await this.goBack(s.back)
  }

  private async finishListening() {
    const s = this.screen
    if (s.name !== 'listening') return
    this.stopMic()
    if (!this.recorder.speechDetected) return this.cancelListening("Didn't hear anything.")
    const pcm = this.recorder.pcm()
    const token = await this.working(s.back, 'Transcribing…')
    const stage = setTimeout(() => { if (token === this.workToken && this.screen.name === 'working') void this.g.setText('body', 'Understanding…') }, 1800)
    try {
      const res = await this.api.voice(pcm, s.chatId)
      if (token !== this.workToken) return
      this.lastTranscript = res.transcript
      await this.handleResult(res.result, res.transcript, s.back)
    } catch (err) {
      if (token !== this.workToken) return
      if (err instanceof ApiError && ['silence', 'too_short'].includes(err.code)) {
        await this.show({ name: 'info', title: 'Listening stopped', pages: ["Didn't catch that."], page: 0, back: s.back, retry: { chatId: s.chatId } })
      } else await this.fail(err, s.back)
    } finally {
      clearTimeout(stage)
    }
  }

  private async handleResult(r: CommandResult, transcript: string, back: Back) {
    this.changed()
    switch (r.type) {
      case 'confirm':
        return this.show({ name: 'confirm', plan: r.plan, back })
      case 'open_chat':
        return this.openChat(r.chatId, r.title)
      case 'info':
        return this.show({ name: 'info', title: r.title, pages: paginate(r.body, PAGE_LINES), page: 0, back })
      case 'clarify': {
        const chatId = back.name === 'chat' ? back.chatId : undefined
        const heard = transcript ? `Heard: "${clip(transcript, 90)}"\n\n` : ''
        return this.show({ name: 'info', title: 'Hmm…', pages: paginate(`${heard}${r.body}`, PAGE_LINES), page: 0, back, retry: { chatId } })
      }
    }
  }

  private async execute(plan: Plan, back: Back) {
    const token = await this.working(back, plan.kind === 'send' ? 'Sending…' : 'Sending payment requests…')
    try {
      const res = await this.api.execute(plan.id)
      for (const t of plan.targets) this.drafts.delete(t.chatId)
      if (token !== this.workToken) return
      await this.show({ name: 'info', title: res.title, pages: paginate(res.body, PAGE_LINES), page: 0, back, auto: true })
      this.autoTimer = setTimeout(() => {
        if (this.screen.name === 'info' && this.screen.auto) void this.goBack(back)
      }, 2600)
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  // ── Input routing ─────────────────────────────────────────────────────
  private onInput(i: Input) {
    this.lastInputAt = Date.now()
    if (i.kind === 'exit') return this.dispose()
    if (i.kind === 'background') {
      if (this.screen.name === 'listening') void this.cancelListening()
      return
    }
    if (i.kind === 'foreground') {
      if (this.screen.name === 'inbox') void this.openInbox()
      else if (this.screen.name === 'chat') void this.openChat(this.screen.chatId, this.screen.title, true)
      return
    }
    const s = this.screen
    switch (s.name) {
      case 'boot':
        return
      case 'setup':
        if (i.kind === 'tap') void this.boot()
        else if (i.kind === 'double') this.g.requestExit()
        return
      case 'inbox':
        if (i.kind === 'double') return this.g.requestExit()
        if (i.kind === 'hold') return void this.startListening({ name: 'inbox' }, true)
        if (i.kind === 'select') return void this.onInboxSelect(i.index)
        return
      case 'chat':
        if (i.kind === 'double') return void this.openInbox()
        if (s.kind === 'channel' && (i.kind === 'tap' || i.kind === 'hold')) return
        if (i.kind === 'tap') return void this.openReply(s.chatId, s.title)
        if (i.kind === 'hold') return void this.startListening({ name: 'chat', chatId: s.chatId, title: s.title }, true)
        if (i.kind === 'up' && s.page > 0) return void this.flip(s, s.page - 1)
        if (i.kind === 'down' && s.page < s.pages.length - 1) return void this.flip(s, s.page + 1)
        return
      case 'listening':
        if (i.kind === 'double') return void this.cancelListening()
        if (i.kind === 'tap' || (i.kind === 'release' && s.viaHold)) return void this.finishListening()
        return
      case 'working':
        if (i.kind === 'double') {
          this.workToken++ // discard the in-flight result
          return void this.goBack(s.back)
        }
        return
      case 'reply': {
        const back: Back = { name: 'chat', chatId: s.chatId, title: s.title }
        if (i.kind === 'double') return void this.goBack(back)
        if (i.kind === 'hold') return void this.startListening(back, true)
        if (i.kind === 'select') {
          const plan = s.plans[i.index]
          if (plan) return void this.show({ name: 'confirm', plan, back })
          return void this.startListening(back, false)
        }
        return
      }
      case 'confirm':
        if (i.kind === 'double') return void this.goBack(s.back)
        if (i.kind === 'select') return void (i.index === 0 ? this.execute(s.plan, s.back) : this.goBack(s.back))
        return
      case 'info':
        if (i.kind === 'double') return void this.goBack(s.back)
        if (i.kind === 'up' && s.page > 0) return void this.flip(s, s.page - 1)
        if (i.kind === 'down' && s.page < s.pages.length - 1) return void this.flip(s, s.page + 1)
        if (i.kind === 'tap') return void (s.retry ? this.startListening(s.back, false) : this.goBack(s.back))
        if (i.kind === 'hold') return void this.startListening(s.back, true)
        return
    }
  }

  private async flip(s: Extract<Screen, { name: 'chat' | 'info' }>, page: number) {
    this.screen = { ...s, page }
    const pager = ` ${page + 1}/${s.pages.length}`
    const title = s.name === 'chat' ? `‹ ${clip(s.title, 30)}${pager}` : `${clip(s.title, 36)}${pager}`
    this.headerBase = title
    await this.g.setText('hdr', title)
    await this.g.setText('body', s.pages[page] ?? '')
  }

  private async onInboxSelect(index: number) {
    const a = this.actions[index]
    if (!a) return
    if (a.act === 'voice') return this.startListening({ name: 'inbox' }, false)
    if (a.act === 'chat') return this.openChat(a.chat.id, a.chat.title)
    if (a.act === 'payments') return this.openPayments({ name: 'inbox' })
    if (a.act === 'channels') return this.openDigest({ name: 'inbox' }, 'channels')
    return this.openDigest({ name: 'inbox' })
  }

  // ── Live events ───────────────────────────────────────────────────────
  private onServerEvent(e: ServerEvent) {
    if (e.type === 'telegram') {
      if (this.status) this.status.telegram.state = e.status
      if (e.status === 'ready' && this.screen.name === 'setup') void this.boot()
      this.changed()
      return
    }
    if (e.type === 'payment') {
      this.toast(`■ PAID · ${e.from.split(' ')[0]} sent ${e.amountTon} TON`, 8000)
      this.changed()
      const s = this.screen
      if (s.name === 'info' && s.title === 'Payments') setTimeout(() => void this.openPayments(s.back), 1200)
      return
    }
    // New message
    const s = this.screen
    const cached = this.inbox.find(c => c.id === e.chatId)
    if (cached) Object.assign(cached, { lastFrom: e.from, lastText: e.text, lastDate: Math.floor(Date.now() / 1000), unread: cached.unread + 1 })
    if (s.name === 'chat' && s.chatId === e.chatId) {
      void this.openChat(s.chatId, s.title)
      return
    }
    this.toast(`${e.urgent ? '●' : '○'} ${e.from.split(' ')[0]}: ${e.text}`)
    if (s.name === 'inbox') this.scheduleInboxRefresh()
  }

  private scheduleInboxRefresh() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      if (this.screen.name !== 'inbox') return
      // Don't yank the list out from under someone who is scrolling.
      if (Date.now() - this.lastInputAt < 4000) return this.scheduleInboxRefresh()
      void this.openInbox()
    }, 6500)
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

function humanTgState(s: string) {
  return (
    { needs_login: 'not logged in', awaiting_code: 'waiting for login code', awaiting_password: 'waiting for 2FA password', connecting: 'connecting', error: 'connection error' } as Record<string, string>
  )[s] ?? s
}
