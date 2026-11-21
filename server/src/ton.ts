import { Address, fromNano, toNano } from '@ton/core'
import type { Logger } from './lib/logger.js'
import type { JsonStore } from './lib/store.js'

export type TonNetwork = 'mainnet' | 'testnet'

export function parseAddress(raw: string): Address {
  try {
    return Address.parse(raw.trim())
  } catch {
    throw new Error(`Invalid TON address: ${raw}`)
  }
}

/** User-friendly, URL-safe, non-bounceable form appropriate for receiving wallets. */
export function friendlyAddress(addr: Address, network: TonNetwork): string {
  return addr.toString({ urlSafe: true, bounceable: false, testOnly: network === 'testnet' })
}

/** Round up to 0.01 TON so nobody underpays because of float rounding. */
export function roundTon(ton: number): string {
  return (Math.ceil(ton * 100) / 100).toFixed(2)
}

export function tonToNano(ton: string): bigint {
  return toNano(ton)
}

export function nanoToTon(nano: bigint | string): string {
  const s = fromNano(BigInt(nano))
  const n = Number(s)
  return Number.isInteger(n) ? n.toFixed(0) : n.toFixed(Math.min(4, (s.split('.')[1] ?? '').length))
}

/**
 * Standard TON transfer deeplink (TEP-style `ton://transfer`). Wallet-agnostic:
 * opens Gram Wallet / Wallet in Telegram or whichever TON wallet the payer uses,
 * pre-filled with amount and comment.
 */
export function paymentLink(address: string, nano: bigint, comment: string): string {
  return `ton://transfer/${address}?amount=${nano.toString()}&text=${encodeURIComponent(comment)}`
}

/** Public explorer link for a transaction or address. */
export function explorerUrl(network: TonNetwork, kind: 'tx' | 'address', id: string): string {
  const host = network === 'testnet' ? 'https://testnet.tonviewer.com' : 'https://tonviewer.com'
  if (kind === 'address') return `${host}/${id}`
  // toncenter v3 returns base64 hashes; explorers use hex.
  const hex = /^[0-9a-f]{64}$/i.test(id) ? id : Buffer.from(id, 'base64').toString('hex')
  return `${host}/transaction/${hex}`
}

// ── Exchange rates ────────────────────────────────────────────────────────

export interface RatesData {
  /** Last good price per fiat code, kept across restarts as a fallback. */
  lastKnown: Record<string, { at: number; price: number }>
}

const STALE_LIMIT_MS = 24 * 60 * 60_000

export class RateService {
  private cache = new Map<string, { at: number; price: number }>()
  constructor(
    private readonly log: Logger,
    private readonly store?: JsonStore<RatesData>,
    private readonly ttlMs = 60_000,
  ) {}

  private async fromTonApi(cur: string): Promise<number | undefined> {
    const res = await fetch(`https://tonapi.io/v2/rates?tokens=ton&currencies=${cur.toLowerCase()}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return undefined
    const json = (await res.json()) as { rates?: Record<string, { prices?: Record<string, number> }> }
    return json.rates?.TON?.prices?.[cur]
  }

  private async fromCoinGecko(cur: string): Promise<number | undefined> {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=${cur.toLowerCase()}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return undefined
    const json = (await res.json()) as Record<string, Record<string, number>>
    return json['the-open-network']?.[cur.toLowerCase()]
  }

  /** Price of 1 TON in `fiat`. Tries two live sources, then the last known price (<24h). */
  async tonPrice(fiat: string): Promise<number> {
    const cur = fiat.toUpperCase()
    if (cur === 'TON') return 1
    const hit = this.cache.get(cur)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.price
    for (const [name, source] of [['tonapi', this.fromTonApi], ['coingecko', this.fromCoinGecko]] as const) {
      try {
        const price = await source.call(this, cur)
        if (price && Number.isFinite(price) && price > 0) {
          const entry = { at: Date.now(), price }
          this.cache.set(cur, entry)
          void this.store?.update(d => { d.lastKnown[cur] = entry })
          return price
        }
      } catch (err) {
        this.log.warn({ source: name, err: (err as Error).message }, 'rate source failed')
      }
    }
    const stale = hit ?? this.store?.get().lastKnown[cur]
    if (stale && Date.now() - stale.at < STALE_LIMIT_MS) {
      this.log.warn({ cur, ageMin: Math.round((Date.now() - stale.at) / 60_000) }, 'using last known rate')
      return stale.price
    }
    throw new Error(`No TON/${cur} exchange rate available`)
  }

  async toTon(amount: number, fiat: string): Promise<{ ton: string; rate: number }> {
    const rate = await this.tonPrice(fiat)
    return { ton: roundTon(amount / rate), rate }
  }
}

// ── Incoming-transfer scanner ─────────────────────────────────────────────

export interface IncomingTransfer {
  hash: string
  lt: string
  from: string
  nano: bigint
  comment: string
  at: number
}

interface V3Tx {
  hash: string
  lt: string
  now: number
  in_msg?: {
    source?: string | null
    value?: string | null
    message_content?: { decoded?: { type?: string; '@type'?: string; comment?: string } | null } | null
  } | null
}

export class TonCenter {
  constructor(
    private readonly network: TonNetwork,
    private readonly apiKey: string,
  ) {}

  private get base() {
    return this.network === 'testnet' ? 'https://testnet.toncenter.com/api/v3' : 'https://toncenter.com/api/v3'
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { 'X-API-Key': this.apiKey } : {}
  }

  /** GET with one retry on 429: the keyless tier allows ~1 request/s. */
  private async get(url: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) })
      if (res.status !== 429 || attempt >= 1) return res
      await new Promise(r => setTimeout(r, 1200))
    }
  }

  /** Wallet balance in nanoTON (read-only). */
  async balance(address: string): Promise<bigint> {
    const q = new URLSearchParams({ address })
    const res = await this.get(`${this.base}/walletStates?${q}`, 8000)
    if (!res.ok) throw new Error(`toncenter HTTP ${res.status}`)
    const json = (await res.json()) as { wallets?: Array<{ balance?: string }> }
    return BigInt(json.wallets?.[0]?.balance ?? '0')
  }

  async recentIncoming(address: string, limit = 50): Promise<IncomingTransfer[]> {
    const q = new URLSearchParams({ account: address, limit: String(limit), offset: '0', sort: 'desc' })
    const res = await this.get(`${this.base}/transactions?${q}`, 10_000)
    if (!res.ok) throw new Error(`toncenter HTTP ${res.status}`)
    const json = (await res.json()) as { transactions?: V3Tx[] }
    const out: IncomingTransfer[] = []
    for (const tx of json.transactions ?? []) {
      const m = tx.in_msg
      if (!m?.source || !m.value) continue
      const decoded = m.message_content?.decoded
      out.push({
        hash: tx.hash,
        lt: tx.lt,
        from: m.source,
        nano: BigInt(m.value),
        comment: (decoded?.type ?? decoded?.['@type']) === 'text_comment' ? (decoded?.comment ?? '') : '',
        at: tx.now,
      })
    }
    return out
  }
}
