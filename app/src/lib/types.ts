// Mirrors the server's response shapes.
export type Priority = 'urgent' | 'normal' | 'low'

export interface InboxItem {
  id: string
  title: string
  kind: 'user' | 'group' | 'channel' | 'bot'
  unread: number
  lastFrom: string
  lastText: string
  lastDate: number
  muted?: boolean
  priority: Priority
  summary: string
}

export interface Message {
  id: number
  chatId: string
  from: string
  out: boolean
  text: string
  date: number
}

export interface Plan {
  id: string
  kind: 'send' | 'payment_request' | 'note'
  title: string
  body: string
  targets: { chatId: string; title: string }[]
}

export type CommandResult =
  | { type: 'confirm'; plan: Plan }
  | { type: 'open_chat'; chatId: string; title: string }
  | { type: 'info'; title: string; body: string }
  | { type: 'clarify'; body: string }

export interface Status {
  version: string
  telegram: { mode: 'live' | 'mock'; state: string; me?: string; error?: string; passwordHint?: string }
  /** Open model name served by the LLM endpoint, or null when running on rules. */
  ai: string | null
  /** Who serves the model: openai, anthropic, gemini, openrouter, custom (null = rules only). */
  aiProvider?: string | null
  stt: string | null
  ton: { network: 'mainnet' | 'testnet'; wallet: string | null }
  defaultFiat: string
}

export interface PaymentRequest {
  id: string
  code: string
  name: string
  ton: string
  fiatAmount: number | null
  fiat: string | null
  note: string
  status: 'pending' | 'paid' | 'cancelled'
  createdAt: number
  paidAt?: number
  link: string
  txUrl: string | null
}

export interface ChatSummary {
  id: string
  title: string
  kind: InboxItem['kind']
  unread: number
  muted: boolean
  lastDate: number
  focused: boolean
}

export interface Settings {
  walletAddress: string
  defaultFiat: string
  focusChatIds: string[]
}

export type AiProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom'

export interface AiSettings {
  provider: 'off' | 'server' | AiProviderId
  model: string
  baseUrl: string
  hasKey: boolean
  keyHint: string
  active: { provider: string; model: string } | null
  serverModel: string | null
  providers: Array<{ id: AiProviderId; label: string; model: string; keyHint: string; needsKey: boolean; needsUrl: boolean }>
  test?: AiTest | null
}

export interface AiTest {
  ok: boolean
  error: string | null
  ms: number
}

export interface WalletInfo {
  address: string | null
  balanceTon: string | null
  network: 'mainnet' | 'testnet'
  explorer: string | null
}

export type ServerEvent =
  | { type: 'message'; chatId: string; chatTitle: string; from: string; text: string; urgent: boolean }
  | { type: 'payment'; requestId: string; from: string; amountTon: string; note: string }
  | { type: 'telegram'; status: string }
