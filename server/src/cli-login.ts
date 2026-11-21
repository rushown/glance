// Log the server into Telegram from a terminal (alternative to the phone UI):
//   npm run tg:login
import { createInterface } from 'node:readline/promises'
import { pino } from 'pino'
import { loadConfig } from './config.js'
import type { Logger } from './lib/logger.js'
import { JsonStore } from './lib/store.js'
import { LiveTelegram, type SessionData } from './telegram/live.js'

const cfg = loadConfig({ ...process.env, TELEGRAM_MODE: 'live' })
const store = await new JsonStore<SessionData>(cfg.DATA_DIR, 'session', { telegramSession: '' }).load()
const tg = new LiveTelegram(cfg.TG_API_ID!, cfg.TG_API_HASH, store, pino({ level: 'warn' }) as unknown as Logger)
const rl = createInterface({ input: process.stdin, output: process.stdout })
await tg.start()
if (tg.status().state === 'ready') {
  console.log(`Already logged in as ${tg.status().me}`)
} else {
  await tg.requestCode((await rl.question('Phone number (international format): ')).trim())
  await tg.submitCode((await rl.question('Login code: ')).trim())
  if (tg.status().state === 'awaiting_password') {
    const hint = tg.status().passwordHint
    await tg.submitPassword(await rl.question(`2FA password${hint ? ` (hint: ${hint})` : ''}: `))
  }
  console.log(tg.status().state === 'ready' ? `Logged in as ${tg.status().me}. Session saved to ${cfg.DATA_DIR}.` : `Login incomplete: ${tg.status().state}`)
}
rl.close()
await store.flush()
await tg.stop()
process.exit(0)
