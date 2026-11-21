import { z } from 'zod'

const bool = z
  .string()
  .optional()
  .transform(v => v === '1' || v?.toLowerCase() === 'true')

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    HOST: z.string().default('0.0.0.0'),
    APP_TOKEN: z.string().min(16, 'APP_TOKEN must be at least 16 characters'),
    CORS_ORIGINS: z.string().default('*'),
    DATA_DIR: z.string().default('./data'),
    LOG_LEVEL: z.string().default('info'),

    // Any OpenAI-compatible chat endpoint serving an open model. Empty = rules only.
    LLM_BASE_URL: z.string().optional().default(''),
    LLM_MODEL: z.string().default('qwen2.5:3b'),
    LLM_API_KEY: z.string().optional().default(''),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45_000),
    LLM_FAST_MS: z.coerce.number().int().min(500).default(6000),

    // whisper = any OpenAI-compatible /audio/transcriptions server (speaches/faster-whisper, whisper.cpp, Groq...)
    STT_PROVIDER: z.enum(['whisper', 'openai', 'deepgram', 'none']).default('whisper'),
    STT_API_KEY: z.string().optional().default(''),
    STT_BASE_URL: z.string().url().default('http://127.0.0.1:8000/v1'),
    STT_MODEL: z.string().default('Systran/faster-whisper-small'),
    STT_LANGUAGE: z.string().default('en'),

    TELEGRAM_MODE: z.enum(['live', 'mock']).default('mock'),
    TG_API_ID: z.coerce.number().int().optional(),
    TG_API_HASH: z.string().optional().default(''),

    TON_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
    TON_WALLET_ADDRESS: z.string().optional().default(''),
    TONCENTER_API_KEY: z.string().optional().default(''),
    DEFAULT_FIAT: z.string().length(3).default('USD'),
    PAYMENT_POLL_MS: z.coerce.number().int().min(2000).default(8000),

    PRETTY_LOGS: bool,
  })
  .superRefine((c, ctx) => {
    if (c.TELEGRAM_MODE === 'live' && (!c.TG_API_ID || !c.TG_API_HASH)) {
      ctx.addIssue({ code: 'custom', message: 'TELEGRAM_MODE=live requires TG_API_ID and TG_API_HASH' })
    }
  })

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${msg}`)
  }
  return parsed.data
}
