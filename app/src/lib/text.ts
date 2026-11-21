import type { InboxItem, Message } from './types'

const enc = new TextEncoder()
export const utf8Len = (s: string) => enc.encode(s).length

/** Trim to at most `max` UTF-8 bytes (G2 protocol limits are in bytes), never splitting a character. */
export function fitBytes(s: string, max: number): string {
  if (utf8Len(s) <= max) return s
  const chars = Array.from(s)
  let out = ''
  let bytes = 0
  const ell = utf8Len('…')
  for (const ch of chars) {
    const b = utf8Len(ch)
    if (bytes + b + ell > max) break
    out += ch
    bytes += b
  }
  return `${out.trimEnd()}…`
}

/**
 * Make text safe for the G2 font. The firmware font has no emoji: they render
 * as nothing (or an outline), so drop supplementary-plane symbols, variation
 * selectors and joiners, and tidy the spaces they leave behind.
 */
export function forGlasses(s: string): string {
  return s
    .replace(/([ \t]*)(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)/gu, (_m, sp: string, e: string) => (e.codePointAt(0)! > 0xffff ? '' : sp + e.replace(/[\uFE0F\u200D]/g, '')))
    .replace(/[\uFE0E\uFE0F\u200D\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ') // gaps left by removed emoji (keeps leading indentation)
    .replace(/ +$/gm, '')
}

export function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : `${clean.slice(0, Math.max(0, n - 1)).trimEnd()}…`
}

/**
 * Approximate characters per line in a full-width G2 text container.
 * Measured in the Even Hub simulator: ~9.4 px/char average in 566 px; 52 leaves room for wide glyphs.
 */
export const LINE_CHARS = 52

/** Hard-wrap text to an approximate glasses line width (font is proportional). */
export function wrap(text: string, width = LINE_CHARS): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if (word.length > width) {
        if (line) { out.push(line); line = '' }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width))
        continue
      }
      if ((line ? line.length + 1 : 0) + word.length > width) { out.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) out.push(line)
  }
  return out
}

/** Split text into pages of at most `lines` wrapped lines. Always >= 1 page. */
export function paginate(text: string, lines = 8, width = LINE_CHARS): string[] {
  return pageLines(wrap(text, width), lines)
}

export function pageLines(all: string[], lines: number): string[] {
  const pages: string[] = []
  for (let i = 0; i < all.length; i += lines) pages.push(all.slice(i, i + lines).join('\n'))
  return pages.length ? pages : ['']
}

/** List items are capped at 63 UTF-8 bytes by the G2 protocol. */
export const ITEM_BYTES = 63

export function inboxLabel(c: InboxItem): string {
  const mark = c.priority === 'urgent' ? '●' : c.unread > 0 ? '○' : '  '
  const count = c.unread > 0 ? ` ${c.unread > 99 ? '99+' : c.unread}` : ''
  const title = clip(forGlasses(c.title).trim(), 18)
  return fitBytes(`${mark} ${title}${count} · ${forGlasses(c.summary || c.lastText).trim()}`, ITEM_BYTES)
}

/**
 * Chat history as display lines: the sender name appears once per run of
 * messages, continuation lines are indented so message boundaries stay visible.
 */
export function formatChatLines(messages: Message[], width = LINE_CHARS, kind?: InboxItem['kind']): string[] {
  const lines: string[] = []
  if (kind === 'channel') {
    // Broadcast posts: no sender prefix, a blank line between posts.
    for (const m of messages) {
      if (lines.length) lines.push('')
      lines.push(...wrap(forGlasses(m.text).trim() || '[empty]', width))
    }
    return lines
  }
  let prev = ''
  for (const m of messages) {
    const who = m.out ? 'You' : clip(m.from.split(' ')[0] || m.from, 12)
    const text = forGlasses(m.text).trim() || '[empty]'
    if (who === prev) {
      lines.push(...wrap(text, width - 2).map(l => `  ${l}`))
    } else {
      if (lines.length) lines.push('')
      lines.push(...wrap(`${who}: ${text}`, width).map((l, i) => (i === 0 ? l : `  ${l}`)))
    }
    prev = who
  }
  return lines
}

export function formatChat(messages: Message[]): string {
  return formatChatLines(messages).join('\n')
}

export function clock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function levelBar(level: number, width = 16): string {
  const n = Math.max(0, Math.min(width, Math.round(Math.min(1, level * 6) * width)))
  return '█'.repeat(n) + '─'.repeat(width - n)
}
