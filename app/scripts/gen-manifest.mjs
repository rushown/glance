// Generates app.json for `evenhub pack`. The network whitelist must list the
// exact server origin (no wildcards), so it is derived from VITE_SERVER_URL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

function envFrom(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
  )
}

const env = { ...envFrom('.env'), ...envFrom('.env.production'), ...envFrom('.env.production.local'), ...process.env }
const url = env.VITE_SERVER_URL
if (!url) {
  console.error('VITE_SERVER_URL is required (set it in app/.env.production), e.g. https://glance.example.com')
  process.exit(1)
}
let origin
try { origin = new URL(url).origin } catch { console.error(`Invalid VITE_SERVER_URL: ${url}`); process.exit(1) }
if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(origin)) {
  console.error('VITE_SERVER_URL must use https:// for production builds')
  process.exit(1)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = {
  package_id: env.GLANCE_PACKAGE_ID || 'com.glance.tgton',
  edition: '202601',
  name: 'Glance',
  version: pkg.version,
  min_sdk_version: '0.0.16',
  entrypoint: 'index.html',
  permissions: [
    { name: 'network', desc: 'Connects to your Glance server for Telegram messages, voice commands and TON payment requests.', whitelist: [origin] },
    { name: 'g2-microphone', desc: 'Voice commands and dictated replies, only while you are actively recording.' },
  ],
  supported_languages: ['en'],
}
writeFileSync('app.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`app.json written (whitelist: ${origin})`)
