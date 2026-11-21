import { EventEmitter } from 'node:events'
import { Api, TelegramClient } from 'telegram'
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js'
import { StringSession } from 'telegram/sessions/index.js'
import type { Dialog } from 'telegram/tl/custom/dialog.js'
import type { Logger } from '../lib/logger.js'
import type { JsonStore } from '../lib/store.js'
import type { Chat, ChatKind, IncomingMessage, Message, TelegramService, TelegramStatus } from './types.js'

export interface SessionData {
  telegramSession: string
}

type Entity = NonNullable<Dialog['entity']>

/**
 * Real Telegram account over MTProto (gramjs). Acts as a full user client so
 * the glasses can show the user's actual inbox, not just bot messages.
 *
 * Login is a three-step HTTP flow driven from the phone UI:
 *   requestCode(phone) -> submitCode(code) -> [submitPassword(2fa)]
 * The resulting session string is persisted (0600) in DATA_DIR.
 */
export class LiveTelegram implements TelegramService {
  private client: TelegramClient
  private readonly emitter = new EventEmitter()
  private st: TelegramStatus = { mode: 'live', state: 'connecting' }
  private entities = new Map<string, Entity>()
  private chatCache = new Map<string, Chat>()
  private pendingPhone?: { phone: string; hash: string }
  /** One getDialogs call serves every lookup within a few seconds (avoids FLOOD_WAIT). */
  private dialogsCache?: { at: number; limit: number; chats: Chat[]; inflight?: Promise<Chat[]> }
  private handlerAttached = false

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly store: JsonStore<SessionData>,
    private readonly log: Logger,
  ) {
    this.client = this.makeClient(store.get().telegramSession)
  }

  private makeClient(session: string) {
    const client = new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
      connectionRetries: 10,
      retryDelay: 2000,
      autoReconnect: true,
    })
    client.setLogLevel('error' as never)
    return client
  }

  async start() {
    try {
      await this.client.connect()
      if (await this.client.checkAuthorization()) await this.onAuthorized()
      else this.st = { mode: 'live', state: 'needs_login' }
    } catch (err) {
      this.log.error({ err }, 'telegram connect failed')
      this.st = { mode: 'live', state: 'error', error: (err as Error).message }
    }
  }

  private async onAuthorized() {
    const me = (await this.client.getMe()) as Api.User
    this.st = { mode: 'live', state: 'ready', me: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'me' }
    await this.store.update(d => { d.telegramSession = (this.client.session as StringSession).save() })
    if (!this.handlerAttached) {
      this.client.addEventHandler(e => void this.handleNew(e), new NewMessage({ incoming: true }))
      this.handlerAttached = true
    }
    await this.listChats(50).catch(err => this.log.warn({ err }, 'initial dialog fetch failed'))
    this.log.info({ me: this.st.me }, 'telegram ready')
  }

  async stop() {
    await this.client.disconnect().catch(() => {})
  }

  status(): TelegramStatus {
    return { ...this.st }
  }

  private requireReady() {
    if (this.st.state !== 'ready') throw new Error(`Telegram not ready (${this.st.state})`)
  }

  async listChats(limit: number): Promise<Chat[]> {
    this.requireReady()
    const want = Math.min(limit, 100)
    const c = this.dialogsCache
    if (c && c.limit >= want) {
      if (c.inflight) return (await c.inflight).slice(0, want)
      if (Date.now() - c.at < 4000) return c.chats.slice(0, want)
    }
    const inflight = this.fetchDialogs(want)
    this.dialogsCache = { at: Date.now(), limit: want, chats: c?.chats ?? [], inflight }
    try {
      const chats = await inflight
      this.dialogsCache = { at: Date.now(), limit: want, chats }
      return chats
    } catch (err) {
      this.dialogsCache = undefined
      throw err
    }
  }

  private invalidateDialogs() {
    if (this.dialogsCache && !this.dialogsCache.inflight) this.dialogsCache.at = 0
  }

  private async fetchDialogs(limit: number): Promise<Chat[]> {
    // Archived chats are hidden on purpose: they are what the user chose to ignore.
    const dialogs = await this.client.getDialogs({ limit, archived: false })
    const chats: Chat[] = []
    for (const d of dialogs) {
      if (!d.id || !d.entity) continue
      const id = d.id.toString()
      this.entities.set(id, d.entity)
      const chat = this.toChat(d, id)
      this.chatCache.set(id, chat)
      chats.push(chat)
    }
    return chats
  }

  private toChat(d: Dialog, id: string): Chat {
    const ent = d.entity as Api.User | Api.Chat | Api.Channel
    const kind: ChatKind = d.isUser ? ((ent as Api.User).bot ? 'bot' : 'user') : d.isChannel && !d.isGroup ? 'channel' : 'group'
    const muteUntil = d.dialog.notifySettings?.muteUntil ?? 0
    return {
      id,
      title: d.title || d.name || 'Unknown',
      kind,
      unread: d.unreadCount,
      lastFrom: d.message?.out ? 'You' : d.isUser ? d.title || '' : d.isChannel && !d.isGroup ? d.title || '' : senderNameSync(d.message),
      lastText: describeMessage(d.message),
      lastDate: d.message?.date ?? d.date,
      username: 'username' in ent && ent.username ? ent.username : undefined,
      muted: muteUntil > Date.now() / 1000,
    }
  }

  async getChat(chatId: string) {
    if (!this.chatCache.has(chatId)) await this.listChats(100)
    return this.chatCache.get(chatId)
  }

  private async entity(chatId: string): Promise<Entity> {
    let ent = this.entities.get(chatId)
    if (!ent) {
      await this.listChats(100)
      ent = this.entities.get(chatId)
    }
    if (!ent) throw new Error(`Unknown chat ${chatId}`)
    return ent
  }

  async getMessages(chatId: string, limit: number): Promise<Message[]> {
    this.requireReady()
    const ent = await this.entity(chatId)
    const msgs = await this.client.getMessages(ent, { limit })
    const out: Message[] = []
    for (const m of msgs) {
      out.push({
        id: m.id,
        chatId,
        from: m.out ? 'You' : await senderName(m),
        out: Boolean(m.out),
        text: describeMessage(m),
        date: m.date,
      })
    }
    return out.reverse()
  }

  async sendMessage(chatId: string, text: string): Promise<Message> {
    this.requireReady()
    const ent = await this.entity(chatId)
    const m = await this.client.sendMessage(ent, { message: text, linkPreview: false })
    const cached = this.chatCache.get(chatId)
    if (cached) Object.assign(cached, { lastFrom: 'You', lastText: text, lastDate: m.date, unread: 0 })
    this.invalidateDialogs()
    return { id: m.id, chatId, from: 'You', out: true, text, date: m.date }
  }

  async markRead(chatId: string) {
    this.requireReady()
    await this.client.markAsRead(await this.entity(chatId))
    const cached = this.chatCache.get(chatId)
    if (cached) cached.unread = 0
    this.invalidateDialogs()
  }

  onMessage(fn: (m: IncomingMessage) => void) {
    this.emitter.on('msg', fn)
    return () => this.emitter.off('msg', fn)
  }

  private async handleNew(e: NewMessageEvent) {
    try {
      const m = e.message
      const chatId = e.chatId?.toString()
      if (!chatId) return
      let chat = this.chatCache.get(chatId)
      if (!chat) {
        await this.listChats(50)
        chat = this.chatCache.get(chatId)
      }
      if (!chat) return
      const message: Message = { id: m.id, chatId, from: await senderName(m), out: false, text: describeMessage(m), date: m.date }
      Object.assign(chat, { lastFrom: message.from, lastText: message.text, lastDate: message.date, unread: chat.unread + 1 })
      this.invalidateDialogs()
      this.emitter.emit('msg', { chat: { ...chat }, message })
    } catch (err) {
      this.log.warn({ err }, 'failed to process incoming telegram message')
    }
  }

  // ── Login flow ────────────────────────────────────────────────────────
  async requestCode(phone: string) {
    if (this.st.state === 'ready') throw new Error('Already logged in')
    if (!this.client.connected) await this.client.connect()
    const res = await this.client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone)
    this.pendingPhone = { phone, hash: res.phoneCodeHash }
    this.st = { mode: 'live', state: 'awaiting_code' }
  }

  async submitCode(code: string) {
    if (!this.pendingPhone) throw new Error('Request a login code first')
    try {
      await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.pendingPhone.phone,
          phoneCodeHash: this.pendingPhone.hash,
          phoneCode: code,
        }),
      )
      this.pendingPhone = undefined
      await this.onAuthorized()
    } catch (err) {
      if ((err as { errorMessage?: string }).errorMessage === 'SESSION_PASSWORD_NEEDED') {
        const pw = await this.client.invoke(new Api.account.GetPassword())
        this.st = { mode: 'live', state: 'awaiting_password', passwordHint: pw.hint }
        return
      }
      throw err
    }
  }

  async submitPassword(password: string) {
    if (this.st.state !== 'awaiting_password') throw new Error('No 2FA password requested')
    let failure: Error | undefined
    await this.client.signInWithPassword(
      { apiId: this.apiId, apiHash: this.apiHash },
      {
        password: async () => password,
        onError: async err => {
          failure = err
          return true // stop; we surface the error to the caller instead of retrying
        },
      },
    )
    if (failure) throw failure
    this.pendingPhone = undefined
    await this.onAuthorized()
  }

  async logout() {
    try {
      await this.client.invoke(new Api.auth.LogOut())
    } catch (err) {
      this.log.warn({ err }, 'telegram logout call failed; clearing session anyway')
    }
    await this.client.disconnect().catch(() => {})
    await this.store.update(d => { d.telegramSession = '' })
    this.entities.clear()
    this.chatCache.clear()
    this.dialogsCache = undefined
    this.client = this.makeClient('')
    this.handlerAttached = false
    await this.client.connect()
    this.st = { mode: 'live', state: 'needs_login' }
  }
}

/** Sender name from entities already attached to the message (no network call). */
function senderNameSync(m?: Api.Message): string {
  const s = m?.sender as Api.User | Api.Channel | undefined
  if (!s) return ''
  if ('firstName' in s) return [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || ''
  return ('title' in s && s.title) || ''
}

async function senderName(m: Api.Message): Promise<string> {
  try {
    const s = (await m.getSender()) as Api.User | Api.Channel | Api.Chat | undefined
    if (!s) return 'Unknown'
    if ('firstName' in s) return [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || 'Unknown'
    return ('title' in s && s.title) || 'Unknown'
  } catch {
    return 'Unknown'
  }
}

/** Plain-text summary of a message, including media placeholders. */
function describeMessage(m?: Api.Message): string {
  if (!m) return ''
  const text = m.message?.trim() ?? ''
  const media = m.media
  let tag = ''
  if (media instanceof Api.MessageMediaPhoto) tag = '[photo]'
  else if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as Api.Document | undefined
    const attrs = doc?.attributes ?? []
    if (attrs.some(a => a instanceof Api.DocumentAttributeAudio && a.voice)) tag = '[voice message]'
    else if (attrs.some(a => a instanceof Api.DocumentAttributeSticker)) tag = '[sticker]'
    else if (attrs.some(a => a instanceof Api.DocumentAttributeVideo)) tag = '[video]'
    else tag = '[file]'
  } else if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) tag = '[location]'
  else if (media instanceof Api.MessageMediaPoll) tag = '[poll]'
  return [tag, text].filter(Boolean).join(' ')
}
