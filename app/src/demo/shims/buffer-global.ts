// @ton/core expects Node's global Buffer. Imported first by the demo backend.
import { Buffer } from 'buffer'

const g = globalThis as { Buffer?: unknown }
g.Buffer ??= Buffer
