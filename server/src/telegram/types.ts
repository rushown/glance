export type ChatKind = 'user' | 'group' | 'channel' | 'bot'

export interface Chat {
  id: string
  title: string
  kind: ChatKind
  unread: number
  lastFrom: string
  lastText: string
  lastDate: number // unix seconds
  username?: string
  muted?: boolean
}

export interface Message {
  id: number
  chatId: string
  from: string
  out: boolean
  text: string
  date: number // unix seconds
}

export type TelegramState =
  | 'connecting'
  | 'needs_login'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'ready'
  | 'error'

export interface TelegramStatus {
  mode: 'live' | 'mock'
  state: TelegramState
  me?: string
  error?: string
  passwordHint?: string
}

export interface IncomingMessage {
  chat: Chat
  message: Message
}

export interface TelegramService {
  start(): Promise<void>
  stop(): Promise<void>
  status(): TelegramStatus
  listChats(limit: number): Promise<Chat[]>
  getChat(chatId: string): Promise<Chat | undefined>
  getMessages(chatId: string, limit: number): Promise<Message[]>
  sendMessage(chatId: string, text: string): Promise<Message>
  markRead(chatId: string): Promise<void>
  onMessage(fn: (m: IncomingMessage) => void): () => void
  // Interactive login (live mode only; mock resolves immediately)
  requestCode(phone: string): Promise<void>
  submitCode(code: string): Promise<void>
  submitPassword(password: string): Promise<void>
  logout(): Promise<void>
}

/** Lower-case, strip accents and punctuation for fuzzy name matching. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Rank chats against a spoken name ("Ali", "sara k", "the design team").
 * Returns matches best-first; score 1 = exact.
 */
export function matchChats(chats: Chat[], spoken: string): Array<{ chat: Chat; score: number }> {
  const q = normalizeName(spoken).replace(/^(the|my|to|with) /, '')
  if (!q) return []
  const out: Array<{ chat: Chat; score: number }> = []
  for (const chat of chats) {
    const title = normalizeName(chat.title)
    const user = chat.username ? normalizeName(chat.username) : ''
    let score = 0
    if (title === q || user === q) score = 1
    else if (title.split(' ')[0] === q) score = 0.9
    else if (title.startsWith(q)) score = 0.8
    else if (title.split(' ').some(w => w === q)) score = 0.75
    else if (title.includes(q) || (user && user.includes(q))) score = 0.6
    else {
      const d = levenshtein(title.split(' ')[0] ?? '', q)
      if (q.length >= 3 && d <= Math.max(1, Math.floor(q.length / 4))) score = 0.5
    }
    if (score > 0) out.push({ chat, score: chat.kind === 'user' ? score : score - 0.05 })
  }
  return out.sort((a, b) => b.score - a.score || b.chat.lastDate - a.chat.lastDate)
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}
