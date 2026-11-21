import { describe, expect, it } from 'vitest'
import { heuristicIntent, heuristicTriage, truncate } from '../src/ai.js'
import { pcmLevel, pcmToWav } from '../src/stt.js'
import { matchChats, type Chat } from '../src/telegram/types.js'
import { explorerUrl, friendlyAddress, nanoToTon, parseAddress, paymentLink, roundTon, tonToNano } from '../src/ton.js'
import { newCode } from '../src/payments.js'

const chat = (id: string, title: string, kind: Chat['kind'] = 'user'): Chat => ({ id, title, kind, unread: 0, lastFrom: '', lastText: '', lastDate: 0 })
const chats = [chat('1', 'Ali Hassan'), chat('2', 'Sara Khan'), chat('3', 'Product Team', 'group'), chat('4', 'Alina Petrova')]
const ctx = { chats, defaultFiat: 'AED' }

describe('spoken commands (rules)', () => {
  it('understands "tell X …" without "that", using the chat list', () => {
    expect(heuristicIntent('Tell Sara I saved her a seat.', ctx)).toMatchObject({ action: 'send_message', recipient_names: ['Sara'], message_text: 'I saved her a seat' })
    expect(heuristicIntent('message product team the build is green', ctx)).toMatchObject({ action: 'send_message', recipient_names: ['product team'], message_text: 'The build is green' })
    expect(heuristicIntent('tell me a joke', ctx).action).toBe('unknown')
    expect(heuristicIntent('let sara know im running about ten minutes late', ctx)).toMatchObject({ action: 'send_message', recipient_names: ['sara'], message_text: "I'm running about ten minutes late" })
    expect(heuristicIntent('Let Ali know that I dont have the keys', ctx).message_text).toBe("I don't have the keys")
  })
  it('accepts one-letter spelling variants from speech-to-text', () => {
    expect(heuristicIntent('Tell Sarah I saved her a seat.', ctx)).toMatchObject({ action: 'send_message', recipient_names: ['Sarah'], message_text: 'I saved her a seat' })
    expect(matchChats(chats, 'Sarah')[0]!.chat.title).toBe('Sara Khan')
  })
  it('treats gram(s) as TON (Toncoin was renamed Gram)', () => {
    expect(heuristicIntent('split 240 grams with Ali and Sara for dinner', ctx)).toMatchObject({ action: 'split_bill', amount: 240, currency: 'TON' })
  })
})

describe('matchChats', () => {
  it('prefers exact first-name matches', () => {
    expect(matchChats(chats, 'Ali')[0]!.chat.id).toBe('1')
    expect(matchChats(chats, 'sara')[0]!.chat.id).toBe('2')
    expect(matchChats(chats, 'the product team')[0]!.chat.id).toBe('3')
  })
  it('tolerates speech-to-text typos', () => {
    expect(matchChats(chats, 'Sarah')[0]!.chat.id).toBe('2')
  })
  it('returns nothing for unknown names', () => {
    expect(matchChats(chats, 'Zebediah')).toHaveLength(0)
  })
})

describe('heuristicIntent', () => {
  it('parses bill splits with currency words', () => {
    const i = heuristicIntent('Split 240 dirhams with Ali and Sara for dinner', ctx)
    expect(i).toMatchObject({ action: 'split_bill', amount: 240, currency: 'AED', recipient_names: ['ali', 'sara'], include_self: true, note: 'dinner' })
  })
  it('parses direct messages', () => {
    const i = heuristicIntent('Tell Ali that I booked the table for 8', ctx)
    expect(i).toMatchObject({ action: 'send_message', recipient_names: ['Ali'], message_text: 'I booked the table for 8' })
  })
  it('treats dictation as a reply when a chat is open', () => {
    const i = heuristicIntent('on my way', { ...ctx, currentChat: { id: '1', title: 'Ali Hassan', recent: [] } })
    expect(i).toMatchObject({ action: 'reply', message_text: 'On my way' })
  })
  it('recognizes summaries and payments', () => {
    expect(heuristicIntent('what did I miss', ctx).action).toBe('summarize')
    expect(heuristicIntent('who paid', ctx).action).toBe('check_payments')
  })
  it('asks for clarification otherwise', () => {
    expect(heuristicIntent('banana', ctx).action).toBe('unknown')
  })
})

describe('heuristicTriage', () => {
  it('flags blockers in groups as urgent and channels as low', () => {
    expect(heuristicTriage({ ...chat('3', 'Team', 'group'), lastText: '@you blocking release' }).priority).toBe('urgent')
    expect(heuristicTriage({ ...chat('5', 'News', 'channel'), lastText: 'buy now?' }).priority).toBe('low')
  })
})

describe('audio', () => {
  it('wraps pcm in a valid wav header', () => {
    const wav = pcmToWav(Buffer.alloc(3200))
    expect(wav.length).toBe(3244)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16000)
  })
  it('measures level', () => {
    const loud = Buffer.alloc(200)
    for (let i = 0; i < 100; i++) loud.writeInt16LE(i % 2 ? 16000 : -16000, i * 2)
    expect(pcmLevel(Buffer.alloc(200))).toBe(0)
    expect(pcmLevel(loud)).toBeGreaterThan(0.4)
  })
})

describe('ton', () => {
  const raw = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'
  it('rounds up to cents and converts nano', () => {
    expect(roundTon(1.231)).toBe('1.24')
    expect(tonToNano('1.24')).toBe(1_240_000_000n)
    expect(nanoToTon(1_240_000_000n)).toBe('1.24')
    expect(nanoToTon(5_000_000_000n)).toBe('5')
  })
  it('formats addresses and links', () => {
    const a = friendlyAddress(parseAddress(raw), 'testnet')
    expect(a.startsWith('0Q')).toBe(true)
    expect(paymentLink(a, 1_000_000_000n, 'GL-ABCDE dinner')).toBe(`ton://transfer/${a}?amount=1000000000&text=GL-ABCDE%20dinner`)
    const b64 = Buffer.alloc(32, 0xab).toString('base64')
    expect(explorerUrl('testnet', 'tx', b64)).toBe(`https://testnet.tonviewer.com/transaction/${'ab'.repeat(32)}`)
    expect(explorerUrl('mainnet', 'address', a)).toBe(`https://tonviewer.com/${a}`)
  })
  it('rejects invalid addresses', () => {
    expect(() => parseAddress('nope')).toThrow(/Invalid TON address/)
  })
  it('generates unambiguous codes', () => {
    expect(newCode()).toMatch(/^GL-[A-HJ-NP-Z2-9]{5}$/)
  })
  it('truncates with ellipsis', () => {
    expect(truncate('hello world', 6)).toBe('hello…')
  })
})
