// Minimal stand-in for node:crypto, backed by Web Crypto, for the web demo.
import { Buffer } from 'buffer'

export const randomBytes = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)))
export const randomUUID = () => crypto.randomUUID()
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
export default { randomBytes, randomUUID, timingSafeEqual }
