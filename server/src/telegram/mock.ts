import { EventEmitter } from 'node:events'
import type { Chat, IncomingMessage, Message, TelegramService, TelegramStatus } from './types.js'
import { unref } from '../lib/timers.js'

const now = () => Math.floor(Date.now() / 1000)

/**
 * Self-contained demo Telegram account. Lets anyone run the full glasses
 * experience (triage, voice replies, bill splits) without a Telegram login.
 * Simulates the other side replying so the demo feels alive.
 */
export class MockTelegram implements TelegramService {
  private readonly emitter = new EventEmitter()
  private chats = new Map<string, Chat>()
  private messages = new Map<string, Message[]>()
  private seq = 1000
  private timers = new Set<NodeJS.Timeout>()

  constructor(private readonly opts: { autoReplies?: boolean } = {}) {
    this.seed()
  }

  private seed() {
    const t = now()
    const add = (chat: Omit<Chat, 'lastFrom' | 'lastText' | 'lastDate'>, msgs: Array<[string, boolean, string, number]>) => {
      const list: Message[] = msgs.map(([from, out, text, ago]) => ({
        id: this.seq++, chatId: chat.id, from, out, text, date: t - ago,
      }))
      const last = list[list.length - 1]!
      this.chats.set(chat.id, { ...chat, lastFrom: last.from, lastText: last.text, lastDate: last.date })
      this.messages.set(chat.id, list)
    }
    add({ id: '1001', title: 'Ali Hassan', kind: 'user', unread: 2, username: 'alihassan' }, [
      ['You', true, 'Dinner at Al Fanar tonight?', 7200],
      ['Ali Hassan', false, 'Yes! 8pm works', 5400],
      ['Ali Hassan', false, 'Can you book a table for 3? I am stuck in a meeting until 7:30', 300],
    ])
    add({ id: '1002', title: 'Sara Khan', kind: 'user', unread: 1, username: 'sarak' }, [
      ['Sara Khan', false, 'Landing at DXB at 7:10, will come straight to the restaurant', 900],
    ])
    add({ id: '1003', title: 'Mom', kind: 'user', unread: 1 }, [
      ['Mom', false, 'Call me when you are free, nothing urgent ❤️', 3600],
    ])
    add({ id: '2001', title: 'TON Builders Dubai', kind: 'group', unread: 14 }, [
      ['Omar', false, 'Demo day venue confirmed: DIFC Innovation Hub, 10am', 4000],
      ['Lina', false, 'Who is bringing the HDMI adapters?', 2000],
      ['Omar', false, 'Reminder: submissions close Friday 23:59 GST', 600],
    ])
    add({ id: '2002', title: 'Product Team', kind: 'group', unread: 3 }, [
      ['Jake', false, 'Prod deploy failed on the payments service, rolling back', 240],
      ['Jake', false, '@you can you approve the hotfix PR? Blocking release', 120],
    ])
    add({ id: '3001', title: 'Crypto Deals 🔥', kind: 'channel', unread: 48, muted: true }, [
      ['Crypto Deals 🔥', false, '🚀 New presale open, 50% bonus for the first hour', 5400],
      ['Crypto Deals 🔥', false, '100x gem launching NOW, last chance!!!', 1800],
    ])
    add({ id: '3002', title: 'TON Community', kind: 'channel', unread: 4 }, [
      ['TON Community', false, 'Mainnet upgrade scheduled for Dec 2. Validators must update by Dec 1.', 21600],
      ['TON Community', false, 'Wallet fees drop ~40% after the upgrade, no action needed for users.', 14400],
      ['TON Community', false, 'Hackathon: 120+ teams registered for Heads Up, kickoff Nov 23.', 3000],
    ])
    add({ id: '3003', title: 'Even Realities', kind: 'channel', unread: 2 }, [
      ['Even Realities', false, 'G2 firmware 2.4 is rolling out: faster BLE reconnect and new R1 ring gestures.', 10800],
      ['Even Realities', false, 'Even Hub now lists 200+ apps. Developer docs updated for SDK 0.0.16.', 2400],
    ])
  }

  async start() {}
  async stop() {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }
  status(): TelegramStatus {
    return { mode: 'mock', state: 'ready', me: 'Demo User' }
  }
  async listChats(limit: number): Promise<Chat[]> {
    return [...this.chats.values()].sort((a, b) => b.lastDate - a.lastDate).slice(0, limit)
  }
  async getChat(chatId: string) {
    return this.chats.get(chatId)
  }
  async getMessages(chatId: string, limit: number): Promise<Message[]> {
    return (this.messages.get(chatId) ?? []).slice(-limit)
  }
  async sendMessage(chatId: string, text: string): Promise<Message> {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error(`Unknown chat ${chatId}`)
    const msg: Message = { id: this.seq++, chatId, from: 'You', out: true, text, date: now() }
    this.messages.get(chatId)!.push(msg)
    Object.assign(chat, { lastFrom: 'You', lastText: text, lastDate: msg.date, unread: 0 })
    if (this.opts.autoReplies !== false && chat.kind === 'user') this.scheduleReply(chat, text)
    return msg
  }
  async markRead(chatId: string) {
    const chat = this.chats.get(chatId)
    if (chat) chat.unread = 0
  }
  onMessage(fn: (m: IncomingMessage) => void) {
    this.emitter.on('msg', fn)
    return () => this.emitter.off('msg', fn)
  }
  /** Inject an incoming message (used by the demo endpoint and tests). */
  receive(chatId: string, text: string, from?: string) {
    const chat = this.chats.get(chatId)
    if (!chat) return
    const msg: Message = { id: this.seq++, chatId, from: from ?? chat.title, out: false, text, date: now() }
    this.messages.get(chatId)!.push(msg)
    Object.assign(chat, { lastFrom: msg.from, lastText: text, lastDate: msg.date, unread: chat.unread + 1 })
    this.emitter.emit('msg', { chat: { ...chat }, message: msg })
  }
  private scheduleReply(chat: Chat, text: string) {
    const reply = /ton:\/\/|pay/i.test(text)
      ? 'Got it, sending now 👍'
      : /\?/.test(text) ? 'Sounds good!' : 'Perfect, thanks!'
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.receive(chat.id, reply)
    }, 6000)
    unref(t)
    this.timers.add(t)
  }
  async requestCode() {}
  async submitCode() {}
  async submitPassword() {}
  async logout() {}
}
