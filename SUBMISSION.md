# Glance: DoraHacks "Heads Up: Even Realities" submission

**Track:** 01 · Messaging & News (Telegram). Also entered for the **Best Telegram integration** special prize.

## Problem

People check Telegram dozens of times a day. Most of those checks need one line ("who needs me?") or one short answer ("yes, on it"), yet each one means pulling out a phone. Money between friends is worse: someone pays the bill, then spends the week chasing transfers in chats.

## Who it's for

Anyone who lives in Telegram: founders and teams on work groups, crypto communities, and friends who split bills. It's especially useful in the moments when a phone is awkward to use: meetings, walking, driving, dinner.

## How it works

- **Glasses (Even Hub app, TypeScript):** a triaged inbox (urgent first, one line per chat) and chat history you can swipe. Tapping a chat shows 2–3 **AI reply drafts**: pick one and tap Send, three taps in total. Hold to say a reply or a command ("tell Ali I booked the table", "what's new in my channels?", "split 240 dirhams with Ali and Sara"). Nothing is sent until you confirm on the glasses.
- **Phone (same web app in the Even App):** a live mirror of the glasses, **focus chats** (pick the chats that may reach your glasses), Telegram login, wallet, and payment status.
- **Server (self-hosted, Node):** your own Telegram account over MTProto (gramjs). Free, open-source AI runs on the same server: an open LLM (Qwen 2.5 via Ollama, constrained to a JSON schema) for triage, drafts, free-form commands and digests, with rules as an instant fallback, and Whisper (faster-whisper) for speech-to-text. A TON chain watcher matches each payment by its unique comment code and pushes **PAID** to the glasses.
- **Money safety:** testnet by default, payment links use the wallet-agnostic `ton://transfer` standard (Gram Wallet or any TON wallet), no custody, read-only balance.

## Links

- Repository: see README for setup. Demo mode needs no accounts: `npm run dev` in `server/` and `app/`.
- Demo video: _add link_
- Packaged build: `app/glance.ehpk` (`npm run pack`)

## Feature requests

See README → "Feature requests" (Even Hub SDK font and limits API, background glances, scoped Telegram OAuth, Gram Wallet payment-request links, incoming-transfer webhooks).
