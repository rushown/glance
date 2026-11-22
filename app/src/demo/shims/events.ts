// Minimal stand-in for node:events, enough for the server modules the web demo reuses.
type Listener = (...args: any[]) => void

export class EventEmitter {
  private listeners = new Map<string | symbol, Set<Listener>>()
  setMaxListeners(_n: number) { return this }
  on(event: string | symbol, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
    return this
  }
  addListener(event: string | symbol, fn: Listener) { return this.on(event, fn) }
  off(event: string | symbol, fn: Listener) {
    this.listeners.get(event)?.delete(fn)
    return this
  }
  removeListener(event: string | symbol, fn: Listener) { return this.off(event, fn) }
  once(event: string | symbol, fn: Listener) {
    const wrap: Listener = (...args) => { this.off(event, wrap); fn(...args) }
    return this.on(event, wrap)
  }
  emit(event: string | symbol, ...args: unknown[]) {
    const set = this.listeners.get(event)
    if (!set?.size) return false
    for (const fn of [...set]) fn(...args)
    return true
  }
  removeAllListeners(event?: string | symbol) {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }
}
export default EventEmitter
