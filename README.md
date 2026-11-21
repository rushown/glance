# Glance: Telegram on your Even G2

**Read, reply and split the bill without taking your phone out.**

Glance is an Even Hub app for Even Realities G2 glasses. It turns your real Telegram account into a heads-up inbox ranked by urgency. You can reply with one tap by approving an AI-drafted reply, or say your own. All AI is **free and open source, running on your own server**: an open LLM through Ollama and Whisper for speech. No paid AI API is needed. It also lets you split a bill with friends in TON in one sentence: each friend gets a payment link in Telegram, Glance watches the chain, and **PAID** appears on your glasses when the money arrives.

> **Track:** 01 · Messaging & News (Telegram), also entered for **Best Telegram integration**.
> TON payments go through standard `ton://` links that open Gram Wallet or any TON wallet, on **testnet** by default. Glance never holds funds.

> "Split 240 dirhams with Ali and Sara for dinner" → glasses show *80 AED (23.36 TON) each* → tap **Send requests** → Ali and Sara each get a payment link in Telegram → seconds after they pay: **■ PAID · Sara sent 23.36 TON**.

---

## What it does

| On the glasses | How |
|---|---|
| **Triaged inbox**: urgent first, one-line summary per chat | Rules rank chats instantly. An open LLM refines the ranking and writes a one-line summary in the background |
| **Read a chat**, swipe through history | Paginated text, flicker-free updates |
| **One-tap AI replies**: tap a chat, pick a draft | The open LLM drafts 2–3 replies as soon as the chat opens. If the model is slow, rule-based drafts appear first. Pick one, then confirm **Send** |
| **Reply by voice**: hold, speak, pause | Glasses mic → open-source Whisper → command parser (rules first, LLM for free-form speech) → you confirm |
| **Focus chats**: only the chats you pick | Pick chats on the phone. The glasses inbox and live alerts then show only those |
| **Channel digest** | The LLM summarizes new posts in your channels and crypto communities and skips promo spam |
| **Wallet balance** ("what's my balance?") | Read-only TON balance from toncenter, testnet by default |
| **Message anyone**: "Tell Ali I booked the table" | Fuzzy contact matching that tolerates speech-to-text typos |
| **Split a bill / request money** in any currency | Live TON exchange rate → unique payment code per friend → `ton://transfer` link (Gram Wallet or any TON wallet) sent via Telegram |
| **Payment received** alerts | Server matches incoming on-chain transfers by comment code and amount → live push to the glasses |
| **"What did I miss?"** | LLM digest of unread conversations |
| Live notifications | New urgent messages flash in the header |

**Safety rules:** nothing is ever sent without an explicit confirmation on the glasses. Plans are stored on the server and can be used only once, so a double-tap can't send twice and the client can't change recipients or amounts.

## Architecture

```
 Even G2 glasses ──BLE──> Even App (phone WebView)              Glance server (Node 22)
 576×288 HUD, mic,        app/ : glasses UI + phone UI  ─HTTPS─> server/
 touchpad / R1 ring       • state machine, VAD recorder  <─SSE── • Telegram user client (MTProto, gramjs)
                          • HUD mirror + emulator               • open LLM (Ollama): triage, drafts, digests
                                                                • Whisper speech-to-text (speaches)
                                                                • TON: rates, payment links, chain watcher
                                                                        │
                                              Telegram ◄────────────────┤
                                              toncenter / tonapi ◄──────┘
```

- **app/**: Even Hub plugin (TypeScript + Vite, `@evenrealities/even_hub_sdk` 0.0.16). It serializes every BLE call with a timeout, mirrors every frame to the phone, and runs a full **emulator** in a desktop browser (keyboard + browser mic).
- **server/**: Fastify API, single-tenant (your own server for your own Telegram account). API keys and the Telegram session never leave it.

## Quick start: demo mode (no accounts needed, ~2 minutes)

```bash
# 1. Server with built-in demo chats
cd server && npm install
cp .env.example .env          # set APP_TOKEN to any long random string
#   TELEGRAM_MODE=mock, and optionally TON_WALLET_ADDRESS=<any TON address>
npm run dev

# 2. App (in another terminal)
cd app && npm install
VITE_SERVER_URL=http://localhost:8787 VITE_APP_TOKEN=<same APP_TOKEN> npm run dev
# open http://localhost:5173 (emulator), or: npm run simulate (official Even simulator)
```

In the emulator, **↑ ↓** scroll, **Enter** taps, **Esc** double-taps and **Space** talks. You can also use the "Try a command" box. In demo mode, friends reply and "pay" automatically about 10 s after you send a request.

## Production setup

1. **Telegram**: create an app at <https://my.telegram.org> → set `TELEGRAM_MODE=live`, `TG_API_ID` and `TG_API_HASH`. Log in from the phone UI (phone → code → 2FA), or run `npm run tg:login` on the server.
2. **AI (free, open source):** `docker compose up` starts **Ollama** with `qwen2.5:3b`, and nothing else is needed. Any OpenAI-compatible endpoint works through `LLM_BASE_URL` / `LLM_MODEL` (llama.cpp server, vLLM, LM Studio, or Groq's free tier for speed). Leave `LLM_BASE_URL` empty to run on rules only.
3. **Voice (free, open source):** `docker compose up` starts **speaches** (faster-whisper, `Systran/faster-whisper-small`) with no key. Alternatives: whisper.cpp server, or Groq `whisper-large-v3-turbo`. The G2 has no speaker, so Glance needs no text-to-speech.
4. **TON**: set `TON_NETWORK=mainnet` and `TON_WALLET_ADDRESS` (or paste the address in the phone UI). `TONCENTER_API_KEY` is optional and raises rate limits.
5. **Deploy the server** somewhere with HTTPS:
   ```bash
   docker compose up -d --build     # uses server/.env, persists data in a volume
   ```
6. **Package the glasses app**:
   ```bash
   cd app && cp .env.example .env.production   # set VITE_SERVER_URL=https://your-server
   npm run pack                                # → glance.ehpk (network whitelist = your origin)
   npx evenhub login && npx evenhub create glance.ehpk --name Glance --tagline "Telegram + TON, heads-up"
   ```
   Install it as a private build on your glasses, then submit for review in the Even Hub portal.

### Where to host (and why not Vercel)

| Part | Vercel? | Use instead |
|---|---|---|
| `app/` (static) | ✅ Works, handy as a browser demo for judges | Inside the Even App it is packaged as `.ehpk` anyway |
| `server/` | ❌ Needs a permanent Telegram connection, a live update stream, a background chain watcher, and disk storage for the session. Serverless functions are short-lived with no persistent disk | **Railway, Fly.io, Render** or any VPS with the included Dockerfile (needs a persistent volume at `/data`) |

## Controls on the glasses

| Screen | Tap | Swipe | Double-tap | Long-press |
|---|---|---|---|---|
| Inbox | open item / **▶ Speak** / digests / payments | scroll list | exit dialog | talk |
| Chat | AI reply drafts | older / newer | back | talk (reply by voice) |
| Reply drafts | pick a draft, or **● Speak a reply** | move | back to chat | talk |
| Listening | done (also auto-stops after a pause) | | cancel | release = done |
| Confirm | **Send** / Cancel | | cancel | |

A typical reply takes three taps: open the chat, pick a draft, tap **Send**. Nothing is sent before the last tap.

## Security & reliability

- Bearer-token auth with constant-time comparison. The token is redacted from logs, and the only route that accepts it in the URL is the live-update stream, because EventSource can't send headers.
- Rate limits: global, voice, and login (5 attempts / 5 min). Every input is validated with zod. Body size is capped (60 s of audio).
- Telegram session and data files are written atomically with mode 0600. The container runs as non-root with a healthcheck.
- Exchange rates: tonapi → CoinGecko → last known rate (<24 h, kept across restarts).
- Payment matching is idempotent: a transaction is never counted twice, underpayments (<98%) are rejected, and each request has its own code.
- Glasses: every BLE call is serialized and time-limited. The startup page is created exactly once. Stale network responses can't overwrite newer screens.
- Glasses text is checked against the real firmware limits we measured in the official simulator. List items stay within 63 **bytes**, so a multibyte symbol like `●` can't push one over and break the whole page. Emoji are stripped because the G2 font has no glyphs for them. Lines wrap at the width the font actually fits.
- Telegram (live): one `getDialogs` call serves all lookups for a few seconds, which avoids `FLOOD_WAIT` errors. Archived chats are hidden. Glance runs on your own server with your own session, and messages are never stored beyond the session file.

## Tests

```bash
cd server && npm test     # 31 tests: API end-to-end, split → on-chain match, drafts, focus chats, channel digest, balance
cd app && npm test        # 13 tests: every glasses page validated with the SDK's own validator, 63-byte limits, emoji, VAD

# Official simulator, scriptable (screenshots of the real 576×288 framebuffer):
cd app && npx evenhub-simulator http://localhost:5173 --automation-port 9898
curl -X POST 127.0.0.1:9898/api/input -d '{"action":"click"}' -H 'content-type: application/json'
curl 127.0.0.1:9898/api/screenshot/glasses -o glasses.png
```

## Demo-video script (under 3 minutes, Even Hub simulator)

Record the simulator window next to the phone UI (`npm run simulate` + `http://localhost:5173`).

1. **0:00 Problem (15 s).** "I check Telegram 80 times a day. Most of the time I need one line, not my phone."
2. **0:15 Inbox (25 s).** The glasses open on a triaged inbox: urgent first, with one line per chat. A new message flashes in the header.
3. **0:40 Read and write (35 s).** Tap *Product Team* → tap → three AI drafts → pick "Yes, on it" → **Send**. Then hold, say *"Tell Ali I booked Al Fanar for 8"*, and confirm.
4. **1:15 Focus and digest (25 s).** On the phone, tick only *Product Team* and *Ali*: the inbox shrinks to those chats. Then *Channel digest*: two lines of news, with the promo channel skipped.
5. **1:40 Money (40 s).** *"Split 240 dirhams with Ali and Sara for dinner"* → AED and TON per person → **Send requests**. Show Ali's Telegram message with the `ton://` link (testnet). He pays → **■ PAID · Ali sent 23.36 TON** on the glasses, with the testnet transaction open in tonviewer.
6. **2:20 Safety and setup (20 s).** Nothing is sent without a tap. The server is self-hosted with your own Telegram session, the demo runs on testnet, and Glance holds no funds.
7. **2:40 Close.** *"Telegram where your eyes already are."*

## Prior work and hackathon rules

- A first prototype of Glance (server, glasses controller and phone UI) was written on **Nov 19–21, 2026, before build week (Nov 23)**, as allowed by the rules ("say in your README what existed before Nov 23"). Every commit dated before Nov 23 is that pre-existing work. Everything after it was built during the hackathon, commit by commit.
- Open-source libraries used: gramjs (Telegram MTProto), Fastify, zod, @ton/core, Even Hub SDK, CLI and simulator. Open models: Qwen 2.5 via Ollama, Whisper via speaches / faster-whisper.
- Only apps listed in the entered track are used: **Telegram**. The AI is self-hosted open source (Ollama + Whisper), not a third-party app. Payments use the wallet-agnostic `ton://` standard, so they open Gram Wallet.
- Money safety: testnet by default, read-only balance, and no custody. Glance only asks friends to pay *your own* wallet. No API keys are in the repo (`.env` files are git-ignored).

## Feature requests (for the teams behind the APIs)

1. **Even Hub SDK:** publish the firmware font's glyph coverage and a text-measuring call. List items are limited in *bytes*, and emoji silently render as nothing. Today you only discover both from simulator warnings.
2. **Even Hub:** let a backgrounded app post a one-line glance (for example "Ali: can you book a table?") that opens the app when tapped.
3. **Telegram:** a scoped OAuth grant for third-party clients ("read chats + send after confirmation") instead of a full MTProto user session.
4. **Gram Wallet:** an `https://t.me/...` payment-request link (address, amount, comment) that every Telegram client renders as tappable and that opens straight into Gram Wallet.
5. **Gram Wallet / TON:** a webhook for incoming transfers to an address, so payment detection doesn't need polling.

## License

MIT
