import { randomBytes } from 'node:crypto'
import type { EventHub } from './lib/events.js'
import type { Logger } from './lib/logger.js'
import type { JsonStore } from './lib/store.js'
import { nanoToTon, type TonCenter } from './ton.js'
import { unref } from './lib/timers.js'

export type PaymentStatus = 'pending' | 'paid' | 'cancelled'

export interface PaymentRequest {
  id: string
  code: string
  chatId: string
  name: string
  nano: string
  fiatAmount: number | null
  fiat: string | null
  note: string
  address: string
  link: string
  status: PaymentStatus
  createdAt: number
  paidAt?: number
  txHash?: string
}

export interface PaymentsData {
  requests: PaymentRequest[]
  seenTx: string[]
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function newCode(): string {
  const bytes = randomBytes(5)
  return `GL-${[...bytes].map(b => ALPHABET[b % ALPHABET.length]).join('')}`
}

/**
 * Ledger of outgoing payment requests plus a poller that matches incoming
 * on-chain transfers (by unique comment code + amount) and marks them paid.
 */
export class PaymentService {
  private timer?: NodeJS.Timeout
  private polling = false

  constructor(
    private readonly store: JsonStore<PaymentsData>,
    private readonly ton: TonCenter,
    private readonly hub: EventHub,
    private readonly log: Logger,
    private readonly pollMs: number,
  ) {}

  list(): PaymentRequest[] {
    return [...this.store.get().requests].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string) {
    return this.store.get().requests.find(r => r.id === id)
  }

  async add(reqs: PaymentRequest[]) {
    await this.store.update(d => { d.requests.push(...reqs) })
  }

  async cancel(id: string) {
    let found: PaymentRequest | undefined
    await this.store.update(d => {
      const r = d.requests.find(x => x.id === id && x.status === 'pending')
      if (r) { r.status = 'cancelled'; found = { ...r } }
    })
    return found
  }

  async markPaid(id: string, txHash: string) {
    let paid: PaymentRequest | undefined
    await this.store.update(d => {
      const r = d.requests.find(x => x.id === id)
      if (r && r.status === 'pending') {
        r.status = 'paid'
        r.paidAt = Math.floor(Date.now() / 1000)
        r.txHash = txHash
        d.seenTx.push(txHash)
        if (d.seenTx.length > 500) d.seenTx.splice(0, d.seenTx.length - 500)
        paid = { ...r }
      }
    })
    if (paid) {
      this.log.info({ id, code: paid.code, txHash }, 'payment received')
      this.hub.publish({ type: 'payment', requestId: paid.id, from: paid.name, amountTon: nanoToTon(paid.nano), note: paid.note })
    }
    return paid
  }

  start() {
    this.timer = setInterval(() => void this.poll(), this.pollMs)
    unref(this.timer)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** One reconciliation pass. Exposed for tests and manual refresh. */
  async poll(): Promise<number> {
    if (this.polling) return 0
    const pending = this.store.get().requests.filter(r => r.status === 'pending')
    if (!pending.length) return 0
    this.polling = true
    let matched = 0
    try {
      const byAddress = new Map<string, PaymentRequest[]>()
      for (const r of pending) byAddress.set(r.address, [...(byAddress.get(r.address) ?? []), r])
      const seen = new Set(this.store.get().seenTx)
      for (const [address, reqs] of byAddress) {
        const transfers = await this.ton.recentIncoming(address)
        for (const req of reqs) {
          const tx = transfers.find(
            t => !seen.has(t.hash) && t.comment.toUpperCase().includes(req.code) && t.nano * 100n >= BigInt(req.nano) * 98n,
          )
          if (tx) {
            seen.add(tx.hash)
            await this.markPaid(req.id, tx.hash)
            matched++
          }
        }
      }
    } catch (err) {
      this.log.warn({ err }, 'payment poll failed')
    } finally {
      this.polling = false
    }
    return matched
  }
}
