import { EventEmitter } from 'node:events'

export type HubEvent =
  | { type: 'message'; chatId: string; chatTitle: string; from: string; text: string; urgent: boolean }
  | { type: 'payment'; requestId: string; from: string; amountTon: string; note: string }
  | { type: 'telegram'; status: string }
  | { type: 'ping' }

/** In-process pub/sub that fans server events out to SSE clients. */
export class EventHub {
  private readonly emitter = new EventEmitter()
  constructor() {
    this.emitter.setMaxListeners(100)
  }
  publish(event: HubEvent): void {
    this.emitter.emit('event', event)
  }
  subscribe(fn: (event: HubEvent) => void): () => void {
    this.emitter.on('event', fn)
    return () => this.emitter.off('event', fn)
  }
}
