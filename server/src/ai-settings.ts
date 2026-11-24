import { z } from 'zod'
import { type AiProvider, type AiService, type LlmConfig, PROVIDERS } from './ai.js'

/**
 * Which model the user picked on the phone. Stored on the user's own Glance
 * server (DATA_DIR/ai.json, mode 0600, like the Telegram session). The API key
 * is never sent back to any client: reads only show its last 4 characters.
 *
 * - off:    no AI. Glance is a plain Telegram client (rules, keyword search).
 * - server: the model set in the server's .env (LLM_BASE_URL, e.g. Ollama).
 * - others: the user's own key for ChatGPT, Claude, Gemini, OpenRouter or any
 *           OpenAI-compatible endpoint.
 */
export interface AiSettingsData {
  provider: 'off' | 'server' | AiProvider
  apiKey: string
  model: string
  baseUrl: string
}

export const DEFAULT_AI_SETTINGS: AiSettingsData = { provider: 'server', apiKey: '', model: '', baseUrl: '' }

/** What the phone may see. */
export interface PublicAiSettings {
  provider: AiSettingsData['provider']
  model: string
  baseUrl: string
  hasKey: boolean
  keyHint: string
  /** The model actually in use right now, or null for rules only. */
  active: { provider: string; model: string } | null
  /** The model from the server's .env, if any. */
  serverModel: string | null
  providers: Array<{ id: AiProvider; label: string; model: string; keyHint: string; needsKey: boolean; needsUrl: boolean }>
}

export const AiSettingsBody = z.object({
  provider: z.enum(['off', 'server', 'openai', 'anthropic', 'gemini', 'openrouter', 'custom']),
  /** Omitted = keep the saved key (same provider only). Empty string = remove it. */
  apiKey: z.string().max(400).optional(),
  model: z.string().max(120).optional(),
  baseUrl: z.string().max(300).optional(),
})

const needsKey = (p: AiSettingsData['provider']) => p === 'openai' || p === 'anthropic' || p === 'gemini' || p === 'openrouter'

/** Model config for the AI service, or null for rules only. */
export function resolveLlm(s: AiSettingsData, server: LlmConfig | null): LlmConfig | null {
  if (s.provider === 'off') return null
  if (s.provider === 'server') return server
  const preset = PROVIDERS[s.provider]
  const baseUrl = s.provider === 'custom' ? s.baseUrl : preset.baseUrl
  const model = s.model.trim() || preset.model
  if (!model || (needsKey(s.provider) && !s.apiKey) || (s.provider === 'custom' && !baseUrl)) return null
  // Cloud models answer in a few seconds; give interactive features a little longer than for local ones.
  return { provider: s.provider, baseUrl, model, apiKey: s.apiKey, timeoutMs: 30_000, fastMs: 9000 }
}

/**
 * Apply a change from the phone. Throws a message for the user when the
 * settings can't work (missing key, bad URL).
 */
export function mergeAiSettings(current: AiSettingsData, body: z.infer<typeof AiSettingsBody>): AiSettingsData {
  const sameProvider = body.provider === current.provider
  const next: AiSettingsData = {
    provider: body.provider,
    apiKey: body.apiKey !== undefined ? body.apiKey.trim() : sameProvider ? current.apiKey : '',
    model: (body.model ?? (sameProvider ? current.model : '')).trim(),
    baseUrl: (body.baseUrl ?? (sameProvider ? current.baseUrl : '')).trim().replace(/\/+$/, ''),
  }
  if (next.provider === 'off' || next.provider === 'server') return { ...next, apiKey: '', model: '', baseUrl: '' }
  if (needsKey(next.provider) && !next.apiKey) throw new Error(`Paste your ${PROVIDERS[next.provider].label} API key`)
  if (next.provider === 'custom') {
    if (!/^https?:\/\/[^\s/]+/i.test(next.baseUrl)) throw new Error('Enter the base URL, e.g. http://127.0.0.1:11434/v1')
    if (!next.model) throw new Error('Enter the model name')
  }
  return next
}

export function publicAiSettings(s: AiSettingsData, ai: AiService, server: LlmConfig | null): PublicAiSettings {
  return {
    provider: s.provider,
    model: s.model,
    baseUrl: s.baseUrl,
    hasKey: Boolean(s.apiKey),
    keyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '',
    active: ai.enabled ? { provider: ai.provider ?? 'custom', model: ai.model ?? '' } : null,
    serverModel: server?.model ?? null,
    providers: (Object.keys(PROVIDERS) as AiProvider[]).map(id => ({
      id, label: PROVIDERS[id].label, model: PROVIDERS[id].model, keyHint: PROVIDERS[id].keyHint, needsKey: needsKey(id), needsUrl: id === 'custom',
    })),
  }
}
