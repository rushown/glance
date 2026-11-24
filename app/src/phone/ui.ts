import type { Controller, ControllerState } from '../glasses/controller'
import type { Api } from '../lib/api'
import { type Glasses, H, type MirrorFrame, W } from '../lib/glasses'
import { fitBytes, forGlasses } from '../lib/text'
import type { AiSettings, ChatSummary, PaymentRequest, Settings, Status, WalletInfo } from '../lib/types'

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const PROVIDER_NAMES: Record<string, string> = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', openrouter: 'OpenRouter' }

const short = (addr: string) => (addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr)

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export interface PhoneDeps {
  glasses: Glasses
  controller: Controller
  api: Api
  saveConfig: (baseUrl: string, token: string) => Promise<void>
}

type Tab = 'payments' | 'focus' | 'setup'

const EXAMPLES = [
  'What did I miss?',
  "What's the office wifi password?",
  'Note: gym locker 4417',
  'Brief me on Ali',
  'Tell Ali I booked Al Fanar for 8pm',
  'Split 240 dirhams with Ali and Sara for dinner',
  'Who paid?',
]

/**
 * Companion UI shown in the Even App (phone) or a desktop browser:
 * live glasses mirror + touchpad, command line, payments, focus chats, setup.
 */
export function mountPhoneUi(root: HTMLElement, d: PhoneDeps) {
  root.innerHTML = `
  <div class="app">
    <header class="masthead">
      <div class="brand">
        <svg class="mark" viewBox="0 0 32 20" aria-hidden="true"><path d="M2 10c4-6 9-8 14-8s10 2 14 8c-4 6-9 8-14 8S6 16 2 10z" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="16" cy="10" r="3.4" fill="currentColor"/></svg>
        <div>
          <h1>Glance</h1>
          <p>Telegram, heads-up</p>
        </div>
      </div>
      <p class="conn" id="conn"><span class="dot"></span><span id="conn-text">Starting</span></p>
    </header>

    <aside class="demo-banner" id="demo-banner" role="note" hidden>
      <span class="demo-tag">Demo</span>
      <p><b>This is a demo.</b> It runs entirely in your browser with sample chats and rule-based replies. No Telegram account, no real money.
      To try the AI features, add your own ChatGPT, Claude, Gemini or OpenRouter key under <button type="button" class="link" id="demo-setup">Setup</button> (it stays in this tab). For the real thing, connect your own Glance server there.</p>
    </aside>

    <div class="cols">
      <section class="stage" aria-label="Glasses">
        <figure class="lens">
          <div class="hud" id="hud" role="img" aria-label="Live mirror of the glasses display"></div>
          <figcaption><span id="lens-src">Mirror</span><span class="mono">576 × 288</span></figcaption>
        </figure>

        <div class="pad" role="group" aria-label="Glasses touchpad">
          <button data-in="up" aria-label="Swipe up"><svg viewBox="0 0 16 16"><path d="M3 10l5-5 5 5" /></svg></button>
          <button data-in="down" aria-label="Swipe down"><svg viewBox="0 0 16 16"><path d="M3 6l5 5 5-5" /></svg></button>
          <button data-in="tap" class="wide">Tap</button>
          <button data-in="double" class="wide">Double tap</button>
          <button id="talk" class="talk"><span class="rec"></span><span id="talk-label">Talk</span></button>
        </div>
        <p class="keys" id="keys"></p>

        <form id="cmd" class="cmd" autocomplete="off">
          <label for="cmd-text">Say it or type it</label>
          <div class="cmd-row">
            <input id="cmd-text" placeholder="Split 240 dirhams with Ali and Sara" enterkeyhint="go" />
            <button class="go" type="submit" aria-label="Run command"><svg viewBox="0 0 16 16"><path d="M3 8h9M8 4l4 4-4 4" /></svg></button>
          </div>
          <ul class="examples" id="examples">${EXAMPLES.map(e => `<li><button type="button">${esc(e)}</button></li>`).join('')}</ul>
          <p class="heard" id="heard" aria-live="polite"></p>
        </form>
      </section>

      <section class="panel">
        <nav class="tabs" role="tablist">
          <button role="tab" data-tab="payments" aria-selected="true">Payments</button>
          <button role="tab" data-tab="focus">Focus chats</button>
          <button role="tab" data-tab="setup">Setup <span class="todo" id="todo"></span></button>
        </nav>

        <div class="view" data-view="payments">
          <div class="wallet" id="wallet-view">
            <p class="eyebrow">Wallet</p>
            <p class="balance"><span id="bal" class="bal">—</span> <span class="unit">TON</span></p>
            <p class="addr" id="addr">No wallet connected</p>
          </div>
          <div class="list-head"><h2>Requests</h2><button id="pay-refresh" class="link">Check chain</button></div>
          <ul id="payments" class="rows"></ul>
        </div>

        <div class="view" data-view="focus" hidden>
          <p class="lede">Pick the chats that may reach your glasses. Everything else stays on your phone. With nothing picked, Glance shows all chats, ranked by urgency.</p>
          <div class="list-head"><h2 id="focus-count">All chats</h2><button id="focus-clear" class="link" hidden>Show all</button></div>
          <ul id="chats" class="rows checks"></ul>
        </div>

        <div class="view" data-view="setup" hidden>
          <ol class="steps">
            <li class="step" id="step-server">
              <div class="step-head"><span class="num">1</span><h3>Server</h3><span class="state" id="server-state"></span></div>
              <form id="server" class="fields">
                <input name="url" type="url" placeholder="https://glance.example.com (empty = web demo)" spellcheck="false" aria-label="Server URL" />
                <input name="token" type="password" placeholder="Access token (APP_TOKEN)" aria-label="Access token" />
                <button class="primary">Connect</button>
              </form>
              <p class="note" id="server-info"></p>
            </li>
            <li class="step" id="step-tg">
              <div class="step-head"><span class="num">2</span><h3>Telegram</h3><span class="state" id="tg-state"></span></div>
              <p class="note" id="tg-status"></p>
              <form id="tg-phone" class="fields inline" hidden><input name="phone" type="tel" placeholder="+971 50 123 4567" autocomplete="tel" aria-label="Phone number" /><button class="primary">Send code</button></form>
              <form id="tg-code" class="fields inline" hidden><input name="code" inputmode="numeric" placeholder="Code from Telegram" autocomplete="one-time-code" aria-label="Login code" /><button class="primary">Verify</button></form>
              <form id="tg-pass" class="fields inline" hidden><input name="password" type="password" placeholder="Two-step verification password" autocomplete="current-password" aria-label="2FA password" /><button class="primary">Unlock</button></form>
              <button id="tg-logout" class="link danger" hidden>Log out of Telegram</button>
            </li>
            <li class="step" id="step-wallet">
              <div class="step-head"><span class="num">3</span><h3>TON wallet</h3><span class="state" id="wallet-state"></span></div>
              <p class="note">Where bill-split payments land. Each request carries a unique code, so Glance can spot the transfer on-chain and tell you who paid.</p>
              <form id="wallet" class="fields">
                <input name="wallet" placeholder="UQ… or 0Q… address" spellcheck="false" aria-label="TON address" />
                <div class="fields inline">
                  <label class="cur">Currency <input name="fiat" maxlength="3" placeholder="USD" aria-label="Default currency" /></label>
                  <button class="primary">Save</button>
                </div>
              </form>
            </li>
            <li class="step" id="step-ai">
              <div class="step-head"><span class="num">4</span><h3>AI assistant <span class="sub">optional</span></h3><span class="state" id="ai-state"></span></div>
              <ul class="ai-modes">
                <li><b>Without AI</b> Glance is a plain Telegram client: rule-based replies, keyword search of your Saved Messages, latest messages as briefs.</li>
                <li><b>With AI</b> it writes reply drafts, ranks your inbox, summarizes, and answers questions from your notes in a sentence.</li>
              </ul>
              <form id="ai" class="fields" autocomplete="off">
                <select name="provider" aria-label="AI provider"></select>
                <input name="key" type="password" placeholder="API key" spellcheck="false" aria-label="API key" autocomplete="off" />
                <input name="model" placeholder="Model" spellcheck="false" aria-label="Model name" />
                <input name="url" type="url" placeholder="Base URL, e.g. http://127.0.0.1:11434/v1" spellcheck="false" aria-label="Base URL" />
                <button class="primary">Save and test</button>
              </form>
              <p class="note" id="ai-note"></p>
              <p class="ai-result" id="ai-result" aria-live="polite"></p>
            </li>
          </ol>
          <dl class="specs" id="specs"></dl>
        </div>
      </section>
    </div>

    <footer class="foot">Nothing is sent from your glasses until you confirm it there.</footer>
  </div>
  <div id="snack" class="snack" role="status" aria-live="polite"></div>`

  const hud = $(root, '#hud')
  let status: Status | null = null
  let settings: Settings | null = null
  let screen: ControllerState['screen'] = 'boot'

  // ── Glasses mirror ───────────────────────────────────────────────────
  const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(3)}%`
  const drawHud = (f: MirrorFrame) => {
    const parts: string[] = []
    for (const t of f.page.texts) {
      const dim = t.brightness !== undefined && t.brightness < 3
      parts.push(
        `<div class="hud-box${t.border ? ' framed' : ''}${dim ? ' dim' : ''}" style="left:${pct(t.x, W)};top:${pct(t.y, H)};width:${pct(t.w, W)};height:${pct(t.h, H)}">${esc(forGlasses(t.content))}</div>`,
      )
    }
    if (f.page.list) {
      const l = f.page.list
      const items = l.items.map((it, i) => `<div class="hud-item${i === f.selected ? ' sel' : ''}">${esc(fitBytes(forGlasses(it), 63))}</div>`).join('')
      parts.push(`<div class="hud-box framed hud-list" style="left:${pct(l.x, W)};top:${pct(l.y, H)};width:${pct(l.w, W)};height:${pct(l.h, H)}">${items}</div>`)
    }
    hud.innerHTML = parts.join('')
    const sel = hud.querySelector<HTMLElement>('.hud-item.sel')
    const list = sel?.parentElement
    if (sel && list) {
      // Keep the selection in view like the glasses do, without scrolling the page.
      if (sel.offsetTop < list.scrollTop) list.scrollTop = sel.offsetTop
      else if (sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = sel.offsetTop + sel.offsetHeight - list.clientHeight
    }
  }
  d.glasses.onMirror(drawHud)

  $(root, '#lens-src').textContent = d.glasses.emulated ? 'Emulator' : 'Live from your G2'
  $(root, '#keys').innerHTML = d.glasses.emulated
    ? '<kbd>↑</kbd><kbd>↓</kbd> swipe <kbd>Enter</kbd> tap <kbd>Esc</kbd> double tap <kbd>Space</kbd> talk'
    : 'These buttons act like the touchpad on the temple.'

  // ── Touchpad ─────────────────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>('[data-in]').forEach(b =>
    b.addEventListener('click', () => d.glasses.inject({ kind: b.dataset.in as 'tap' | 'double' | 'up' | 'down' })),
  )
  const talk = () => (screen === 'listening' ? d.glasses.inject({ kind: 'tap' }) : d.controller.startVoice())
  $(root, '#talk').addEventListener('click', talk)
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const map: Record<string, 'tap' | 'double' | 'up' | 'down'> = { Enter: 'tap', Escape: 'double', Backspace: 'double', ArrowUp: 'up', ArrowDown: 'down' }
    if (e.key === ' ') { e.preventDefault(); talk(); return }
    const k = map[e.key]
    if (k) { e.preventDefault(); d.glasses.inject({ kind: k }) }
  })

  // ── Command line ─────────────────────────────────────────────────────
  const cmdInput = $<HTMLInputElement>(root, '#cmd-text')
  $(root, '#cmd').addEventListener('submit', e => {
    e.preventDefault()
    const text = cmdInput.value.trim()
    if (!text) return
    void d.controller.runText(text)
    cmdInput.value = ''
  })
  root.querySelectorAll<HTMLButtonElement>('#examples button').forEach(b =>
    b.addEventListener('click', () => void d.controller.runText(b.textContent ?? '')),
  )

  // ── Tabs ─────────────────────────────────────────────────────────────
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')]
  const views = [...root.querySelectorAll<HTMLElement>('[data-view]')]
  const showTab = (t: Tab) => {
    for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === t))
    for (const v of views) v.hidden = v.dataset.view !== t
    if (t === 'focus') void loadChats()
    try { localStorage.setItem('glance.tab', t) } catch { /* private mode */ }
  }
  for (const b of tabs) b.addEventListener('click', () => showTab(b.dataset.tab as Tab))
  $(root, '#demo-setup').addEventListener('click', () => {
    showTab('setup')
    $(root, '#step-server').scrollIntoView({ behavior: 'smooth', block: 'center' })
  })

  // ── Snackbar + guarded actions ───────────────────────────────────────
  const snack = $(root, '#snack')
  let snackTimer: ReturnType<typeof setTimeout> | undefined
  const notify = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    snack.textContent = msg
    snack.className = `snack show ${kind}`
    clearTimeout(snackTimer)
    snackTimer = setTimeout(() => (snack.className = 'snack'), 3500)
  }
  const guard = async (btn: HTMLButtonElement | null, fn: () => Promise<void>) => {
    if (btn) btn.disabled = true
    try { await fn() } catch (err) { notify((err as Error).message, 'err') } finally { if (btn) btn.disabled = false }
  }

  // ── Setup: step states ───────────────────────────────────────────────
  const setState = (id: string, done: boolean, text: string) => {
    const el = $(root, `#${id}`)
    el.textContent = text
    el.className = `state${done ? ' done' : ''}`
    el.closest('.step')!.classList.toggle('done', done)
  }
  const renderSetup = () => {
    const tg = status?.telegram
    $(root, '#demo-banner').hidden = !d.api.demo
    setState('server-state', Boolean(status), d.api.demo ? 'Web demo' : status ? 'Connected' : d.api.configured ? 'Unreachable' : 'Not set')
    setState('tg-state', tg?.state === 'ready', !tg ? '—' : tg.mode === 'mock' ? 'Demo account' : tg.state === 'ready' ? 'Signed in' : 'Sign in')
    setState('wallet-state', Boolean(settings?.walletAddress), settings?.walletAddress ? short(settings.walletAddress) : 'Not set')
    setState('ai-state', Boolean(status?.ai), status?.ai ? esc(status.ai) : 'Off')
    const open = [!status, tg?.state !== 'ready', !settings?.walletAddress].filter(Boolean).length
    $(root, '#todo').textContent = open ? String(open) : ''
    $(root, '#specs').innerHTML = status
      ? `<div><dt>AI</dt><dd>${status.ai ? `${esc(status.ai)}${status.aiProvider && status.aiProvider !== 'custom' ? ` · ${esc(PROVIDER_NAMES[status.aiProvider] ?? status.aiProvider)}` : ''}` : 'Off (Telegram only)'}</dd></div>
         <div><dt>Voice</dt><dd>${status.stt ? esc(status.stt) : 'Off (set STT_BASE_URL)'}</dd></div>
         <div><dt>TON</dt><dd>${status.ton.network}</dd></div>
         <div><dt>Server</dt><dd class="mono">v${esc(status.version)}</dd></div>`
      : ''
  }

  // ── Telegram login ───────────────────────────────────────────────────
  const tgForms = { phone: $(root, '#tg-phone'), code: $(root, '#tg-code'), pass: $(root, '#tg-pass') }
  const tgLogout = $<HTMLButtonElement>(root, '#tg-logout')
  const renderTg = (t: Status['telegram'] | undefined) => {
    const line = $(root, '#tg-status')
    for (const f of Object.values(tgForms)) f.hidden = true
    tgLogout.hidden = true
    if (!t) { line.textContent = 'Connect the server first.'; return }
    if (t.mode === 'mock' && d.api.demo) {
      line.innerHTML = 'Web demo with sample chats. Connect your own Glance server above to sign in with your Telegram account.'
      return
    }
    if (t.mode === 'mock') {
      line.innerHTML = 'Running on built-in demo chats. Set <code>TELEGRAM_MODE=live</code> with your API ID and hash on the server to use your own account.'
      return
    }
    const labels: Record<string, string> = {
      ready: `Signed in as <b>${esc(t.me ?? '')}</b>. Glance reads your chats through your own server, and only sends what you confirm on the glasses.`,
      needs_login: 'Sign in with the phone number of your Telegram account.',
      awaiting_code: 'Telegram sent a login code to your other devices. Enter it here.',
      awaiting_password: `Your account has two-step verification${t.passwordHint ? ` (hint: ${esc(t.passwordHint)})` : ''}.`,
      connecting: 'Connecting to Telegram…',
      error: `Could not connect: ${esc(t.error ?? 'unknown error')}`,
    }
    line.innerHTML = labels[t.state] ?? esc(t.state)
    if (t.state === 'needs_login' || t.state === 'error') tgForms.phone.hidden = false
    if (t.state === 'awaiting_code') tgForms.code.hidden = false
    if (t.state === 'awaiting_password') tgForms.pass.hidden = false
    if (t.state === 'ready') tgLogout.hidden = false
  }
  const tgSubmit = (form: HTMLElement, field: string, call: (v: string) => Promise<Status['telegram']>) =>
    form.addEventListener('submit', e => {
      e.preventDefault()
      const input = form.querySelector<HTMLInputElement>(`[name=${field}]`)!
      void guard(form.querySelector('button'), async () => {
        const t = await call(input.value.trim())
        input.value = ''
        if (status) status.telegram = t
        renderTg(t)
        renderSetup()
        if (t.state === 'ready') { notify('Telegram connected'); await d.controller.boot() }
      })
    })
  tgSubmit(tgForms.phone, 'phone', v => d.api.tgRequestCode(v))
  tgSubmit(tgForms.code, 'code', v => d.api.tgCode(v))
  tgSubmit(tgForms.pass, 'password', v => d.api.tgPassword(v))
  tgLogout.addEventListener('click', () => {
    if (!confirm('Log out of Telegram on the Glance server?')) return
    void guard(tgLogout, async () => { renderTg(await d.api.tgLogout()); await d.controller.boot(); await refreshAll() })
  })

  // ── Wallet settings ──────────────────────────────────────────────────
  const walletForm = $<HTMLFormElement>(root, '#wallet')
  const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement
  walletForm.addEventListener('submit', e => {
    e.preventDefault()
    const fd = new FormData(walletForm)
    void guard(walletForm.querySelector('button'), async () => {
      settings = await d.api.saveSettings({ walletAddress: String(fd.get('wallet') ?? ''), defaultFiat: String(fd.get('fiat') || '') || undefined })
      field(walletForm, 'wallet').value = settings.walletAddress
      renderSetup()
      await loadWallet()
      notify(settings.walletAddress ? 'Wallet saved' : 'Wallet removed')
    })
  })

  // ── AI assistant ─────────────────────────────────────────────────────
  const aiForm = $<HTMLFormElement>(root, '#ai')
  const aiSel = aiForm.elements.namedItem('provider') as HTMLSelectElement
  const aiKey = field(aiForm, 'key')
  const aiModel = field(aiForm, 'model')
  const aiUrl = field(aiForm, 'url')
  const aiResult = $(root, '#ai-result')
  let ai: AiSettings | null = null
  const renderAiFields = () => {
    const p = ai?.providers.find(x => x.id === aiSel.value)
    const saved = ai?.provider === aiSel.value
    aiKey.hidden = !p
    aiModel.hidden = !p
    aiUrl.hidden = !p?.needsUrl
    if (p) {
      aiKey.placeholder = saved && ai?.hasKey ? `Saved key ${ai.keyHint} (leave empty to keep)` : p.needsKey ? `API key (${p.keyHint})` : 'API key (optional)'
      aiModel.placeholder = p.model ? `Model (default ${p.model})` : 'Model name'
      if (!saved) { aiModel.value = ''; aiUrl.value = '' }
    }
    const notes: Record<string, string> = {
      off: 'Glance works fully without AI.',
      server: `Uses the model on your Glance server${ai?.serverModel ? ` (${esc(ai.serverModel)})` : ''}. Free and private.`,
      custom: 'Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM, Groq…',
    }
    $(root, '#ai-note').innerHTML = notes[aiSel.value]
      ?? (d.api.demo
        ? 'Web demo: your key stays in this browser tab only (gone on reload) and goes only to the provider you picked. Usage is billed to your own account.'
        : 'Your key is stored only on your Glance server and is never shown again or sent to the glasses. Usage is billed to your own account. <b>Privacy:</b> with a cloud provider, snippets of your chats (including what your contacts wrote) and your notes are sent to that provider to write drafts and answers. Use focus chats to limit which chats the AI reads, or pick this server\'s model to keep everything on your server.')
  }
  const renderAi = () => {
    if (!ai) return
    const opts = [
      `<option value="off">Off (Telegram only)</option>`,
      ai.serverModel ? `<option value="server">This server's model (${esc(ai.serverModel)})</option>` : '',
      ...ai.providers.map(p => `<option value="${p.id}">${esc(p.label)}</option>`),
    ]
    aiSel.innerHTML = opts.join('')
    aiSel.value = ai.provider === 'server' && !ai.serverModel ? 'off' : ai.provider
    aiKey.value = ''
    aiModel.value = ai.model
    aiUrl.value = ai.baseUrl
    renderAiFields()
  }
  const loadAi = async () => {
    $(root, '#step-ai').hidden = !d.api.configured
    if (!d.api.configured) return
    try {
      ai = await d.api.aiSettings()
      renderAi()
    } catch {
      // Older servers have no /api/ai: hide the step rather than show an error.
      $(root, '#step-ai').hidden = true
    }
  }
  aiSel.addEventListener('change', () => { aiResult.textContent = ''; renderAiFields() })
  aiForm.addEventListener('submit', e => {
    e.preventDefault()
    aiResult.className = 'ai-result'
    aiResult.textContent = aiSel.value === 'off' ? '' : 'Testing…'
    void guard(aiForm.querySelector('button'), async () => {
      try {
        ai = await d.api.saveAi({
          provider: aiSel.value as AiSettings['provider'],
          ...(aiKey.value.trim() ? { apiKey: aiKey.value.trim() } : {}),
          model: aiModel.value.trim(),
          baseUrl: aiUrl.value.trim(),
        })
      } catch (err) {
        aiResult.textContent = ''
        throw err
      }
      renderAi()
      const t = ai.test
      aiResult.className = `ai-result ${!t || t.ok ? 'ok' : 'err'}`
      aiResult.textContent = !ai.active ? 'AI is off. Glance runs on Telegram alone.'
        : t?.ok ? `Working: ${ai.active.model} answered in ${(t.ms / 1000).toFixed(1)} s.`
          : `Saved, but the test failed: ${t?.error ?? 'unknown error'}`
      status = await d.api.status()
      renderSetup()
      notify(ai.active ? `AI: ${ai.active.model}` : 'AI turned off', t && !t.ok ? 'err' : 'ok')
    })
  })

  // ── Server config ────────────────────────────────────────────────────
  const serverForm = $<HTMLFormElement>(root, '#server')
  field(serverForm, 'url').value = d.api.config.baseUrl
  field(serverForm, 'token').value = d.api.config.token
  serverForm.addEventListener('submit', e => {
    e.preventDefault()
    const fd = new FormData(serverForm)
    void guard(serverForm.querySelector('button'), async () => {
      await d.saveConfig(String(fd.get('url') ?? ''), String(fd.get('token') ?? ''))
      await d.controller.boot()
      await refreshAll()
      notify(status ? 'Connected' : 'Saved, but the server did not answer', status ? 'ok' : 'err')
    })
  })

  // ── Payments ─────────────────────────────────────────────────────────
  const payList = $(root, '#payments')
  const renderPayments = (reqs: PaymentRequest[]) => {
    const visible = reqs.filter(r => r.status !== 'cancelled').slice(0, 20)
    if (!visible.length) {
      payList.innerHTML = '<li class="empty">No requests yet. Try <q>split 240 dirhams with Ali and Sara for dinner</q>.</li>'
      return
    }
    const demo = status?.telegram.mode === 'mock'
    payList.innerHTML = visible
      .map(r => {
        const fiat = r.fiat && r.fiatAmount !== null ? `<span class="sub">${r.fiatAmount} ${esc(r.fiat)}</span>` : ''
        const when = r.status === 'paid' && r.paidAt ? ago(r.paidAt) : `asked ${ago(r.createdAt)}`
        const actions = r.status === 'paid'
          ? r.txUrl ? `<a class="link" href="${esc(r.txUrl)}" target="_blank" rel="noopener">View transfer</a>` : ''
          : `${demo ? `<button class="link" data-paid="${r.id}">Simulate payment</button>` : ''}<button class="link danger" data-cancel="${r.id}">Cancel</button>`
        return `<li class="pay ${r.status}">
          <div class="who"><b>${esc(r.name)}</b><span class="sub">${esc(r.note || 'Payment request')} · <span class="mono">${esc(r.code)}</span></span></div>
          <div class="amt"><span class="fig">${esc(r.ton)}</span> TON${fiat}</div>
          <div class="meta"><span class="status">${r.status === 'paid' ? 'Paid' : 'Waiting'}</span><span class="sub">${when}</span></div>
          <div class="acts">${actions}</div>
        </li>`
      })
      .join('')
  }
  payList.addEventListener('click', e => {
    const t = e.target as HTMLElement
    const paid = t.closest<HTMLButtonElement>('[data-paid]')
    const cancel = t.closest<HTMLButtonElement>('[data-cancel]')
    if (paid) void guard(paid, async () => { await d.api.demoPaid(paid.dataset.paid!); await loadPayments() })
    if (cancel) void guard(cancel, async () => { await d.api.cancelPayment(cancel.dataset.cancel!); await loadPayments() })
  })
  const loadPayments = async () => {
    if (!d.api.configured) return
    try { renderPayments((await d.api.payments()).requests) } catch { /* surfaced by the connection line */ }
  }
  const renderWallet = (w: WalletInfo | null) => {
    $(root, '#bal').textContent = w?.balanceTon ?? '—'
    $(root, '#addr').innerHTML = w?.address
      ? `<a href="${esc(w.explorer ?? '#')}" target="_blank" rel="noopener" class="mono">${esc(short(w.address))}</a> · ${w.network}`
      : 'No wallet connected. <button class="link" data-goto="setup">Add one</button>'
  }
  const loadWallet = async () => {
    if (!d.api.configured) return renderWallet(null)
    try { renderWallet(await d.api.wallet()) } catch { renderWallet(null) }
  }
  root.addEventListener('click', e => {
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]')
    if (go) showTab(go.dataset.goto as Tab)
  })
  $(root, '#pay-refresh').addEventListener('click', e =>
    void guard(e.currentTarget as HTMLButtonElement, async () => {
      const { matched } = await d.api.pollPayments()
      await Promise.all([loadPayments(), loadWallet()])
      notify(matched ? `${matched} new payment${matched > 1 ? 's' : ''} found` : 'No new payments on-chain')
    }),
  )

  // ── Focus chats ──────────────────────────────────────────────────────
  const chatList = $(root, '#chats')
  let chats: ChatSummary[] = []
  const KIND: Record<ChatSummary['kind'], string> = { user: 'Person', group: 'Group', channel: 'Channel', bot: 'Bot' }
  const renderChats = () => {
    const picked = chats.filter(c => c.focused).length
    $(root, '#focus-count').textContent = picked ? `${picked} of ${chats.length} chats on your glasses` : `All ${chats.length} chats on your glasses`
    $(root, '#focus-clear').hidden = !picked
    chatList.innerHTML = chats.length
      ? chats
        .map(c => `<li><label><input type="checkbox" data-chat="${esc(c.id)}"${c.focused ? ' checked' : ''} />
            <span class="who"><b>${esc(c.title)}</b><span class="sub">${KIND[c.kind]}${c.muted ? ' · muted' : ''}${c.unread ? ` · ${c.unread} unread` : ''}</span></span></label></li>`)
        .join('')
      : '<li class="empty">No chats yet.</li>'
  }
  const saveFocus = (ids: string[]) =>
    guard(null, async () => {
      settings = await d.api.saveSettings({ focusChatIds: ids })
      chats = chats.map(c => ({ ...c, focused: settings!.focusChatIds.includes(c.id) }))
      renderChats()
      await d.controller.boot()
    })
  chatList.addEventListener('change', e => {
    const box = e.target as HTMLInputElement
    if (!box.dataset.chat) return
    const ids = new Set(chats.filter(c => c.focused).map(c => c.id))
    if (box.checked) ids.add(box.dataset.chat)
    else ids.delete(box.dataset.chat)
    void saveFocus([...ids])
  })
  $(root, '#focus-clear').addEventListener('click', () => void saveFocus([]))
  const loadChats = async () => {
    if (!status || status.telegram.state !== 'ready') {
      chatList.innerHTML = '<li class="empty">Connect Telegram to pick chats.</li>'
      return
    }
    try {
      chats = (await d.api.chats()).chats
      renderChats()
    } catch (err) {
      chatList.innerHTML = `<li class="empty">${esc((err as Error).message)}</li>`
    }
  }

  // ── Status ───────────────────────────────────────────────────────────
  const refreshAll = async () => {
    if (!d.api.configured) {
      status = null
      settings = null
      renderTg(undefined)
      renderSetup()
      renderWallet(null)
      return
    }
    try {
      status = await d.api.status()
      settings = await d.api.settings()
      renderTg(status.telegram)
      field(walletForm, 'wallet').value = settings.walletAddress
      field(walletForm, 'fiat').value = settings.defaultFiat
      $(root, '#server-info').textContent = ''
      await Promise.all([loadPayments(), loadWallet(), loadAi()])
    } catch (err) {
      status = null
      renderTg(undefined)
      $(root, '#server-info').textContent = (err as Error).message
    }
    renderSetup()
  }

  const conn = $(root, '#conn')
  d.controller.onState((s: ControllerState) => {
    screen = s.screen
    const ready = s.status?.telegram.state === 'ready'
    const [text, tone] = !s.status
      ? ['Not connected', 'err']
      : !s.online ? ['Reconnecting', 'warn']
        : !ready ? ['Setup needed', 'warn']
          : s.status.telegram.mode === 'mock' ? [`Demo data · ${s.status.ton.network}`, 'ok'] : [`Live · ${s.status.ton.network}`, 'ok']
    $(root, '#conn-text').textContent = text
    conn.dataset.tone = tone
    $(root, '#heard').textContent = s.lastTranscript ? `Heard: “${s.lastTranscript}”` : ''
    $(root, '#talk-label').textContent = s.screen === 'listening' ? 'Done' : 'Talk'
    $(root, '#talk').classList.toggle('live', s.screen === 'listening')
    if (s.status) {
      status = { ...s.status, telegram: s.status.telegram }
      renderTg(s.status.telegram)
      renderSetup()
    }
    if (s.screen === 'info' || s.screen === 'inbox') void loadPayments()
  })

  void refreshAll().then(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem('glance.tab') } catch { /* private mode */ }
    const needsSetup = !status || status.telegram.state !== 'ready'
    showTab(needsSetup ? 'setup' : ((saved as Tab | null) ?? 'payments'))
  })
  setInterval(() => void loadPayments(), 15_000)
  setInterval(() => void loadWallet(), 60_000)
}
