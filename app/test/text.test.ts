import { describe, expect, it } from 'vitest'
import { clip, fitBytes, forGlasses, formatChatLines, inboxLabel, levelBar, paginate, utf8Len, wrap } from '../src/lib/text'
import { Recorder, rmsOf } from '../src/lib/recorder'

describe('text layout', () => {
  it('wraps on word boundaries and splits very long words', () => {
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(wrap('x'.repeat(10), 4)).toEqual(['xxxx', 'xxxx', 'xx'])
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })
  it('paginates and never returns zero pages', () => {
    expect(paginate('', 3)).toEqual([''])
    expect(paginate('1\n2\n3\n4', 3)).toEqual(['1\n2\n3', '4'])
  })
  it('keeps list labels within the 63-byte G2 protocol limit', () => {
    const label = inboxLabel({ id: '1', title: 'A very long group title that goes on', kind: 'group', unread: 120, lastFrom: '', lastText: '', lastDate: 0, priority: 'urgent', summary: 'Something extremely long that will not fit on the glasses at all' })
    expect(utf8Len(label)).toBeLessThanOrEqual(63)
    expect(label.startsWith('●')).toBe(true)
    expect(label).toContain(' 99+ ')
    const cjk = inboxLabel({ id: '2', title: '日本語のグループ', kind: 'group', unread: 1, lastFrom: '', lastText: '', lastDate: 0, priority: 'normal', summary: 'これはとても長いメッセージです。これはとても長いメッセージです。' })
    expect(utf8Len(cjk)).toBeLessThanOrEqual(63)
  })
  it('fits by bytes without splitting characters', () => {
    expect(fitBytes('abc', 3)).toBe('abc')
    const out = fitBytes('●●●●●●', 10)
    expect(utf8Len(out)).toBeLessThanOrEqual(10)
    expect(out.endsWith('…')).toBe(true)
  })
  it('strips emoji the G2 font cannot draw', () => {
    expect(forGlasses('Crypto Deals 🔥')).toBe('Crypto Deals')
    expect(forGlasses('Crypto Deals 🔥: 100x gem')).toBe('Crypto Deals: 100x gem')
    expect(forGlasses('  indented 😀 line')).toBe('  indented line')
    expect(forGlasses('ok 👍🏽 thanks')).toBe('ok thanks')
    expect(forGlasses('family 👨‍👩‍👧 dinner')).toBe('family dinner')
    expect(forGlasses('love ❤️')).toBe('love ❤')
    expect(forGlasses('● ○ ▶ ■ — 5€')).toBe('● ○ ▶ ■ — 5€')
  })
  it('groups chat lines by sender with indented continuations', () => {
    const m = (from: string, text: string, out = false) => ({ id: 0, chatId: '1', from, out, text, date: 0 })
    const lines = formatChatLines([m('Jake Smith', 'one'), m('Jake Smith', 'two'), m('You', 'three', true)], 20)
    expect(lines).toEqual(['Jake: one', '  two', '', 'You: three'])
    expect(formatChatLines([m('A', 'word '.repeat(10))], 20).slice(1).every(l => l.startsWith('  '))).toBe(true)
  })
  it('clips with an ellipsis', () => {
    expect(clip('hello   world', 8)).toBe('hello w…')
  })
  it('renders a fixed-width level bar', () => {
    expect(levelBar(0, 8)).toBe('────────')
    expect(levelBar(1, 8)).toBe('████████')
  })
})

describe('recorder VAD', () => {
  const tone = (n: number, amp: number) => {
    const b = new Uint8Array(n * 2)
    const v = new DataView(b.buffer)
    for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin(i / 3) * amp), true)
    return b
  }
  it('measures rms', () => {
    expect(rmsOf(new Uint8Array(100))).toBe(0)
    expect(rmsOf(tone(1000, 16000))).toBeGreaterThan(0.3)
  })
  it('detects speech and concatenates audio', () => {
    const r = new Recorder()
    r.start()
    expect(r.push(tone(1600, 12000))).toBe('continue')
    expect(r.speechDetected).toBe(true)
    r.push(tone(1600, 0))
    expect(r.pcm().byteLength).toBe(6400)
    expect(r.seconds).toBeCloseTo(0.2)
  })
  it('stops at the 30 s cap', () => {
    const r = new Recorder()
    r.start()
    let res = 'continue'
    for (let i = 0; i < 31 && res === 'continue'; i++) res = r.push(tone(16000, 12000))
    expect(res).toBe('stop')
  })
})
