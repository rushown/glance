import { OsEventTypeList, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import { Controller } from '../src/glasses/controller'
import { Glasses } from '../src/lib/glasses'
import type { Api } from '../src/lib/api'
import type { InboxItem } from '../src/lib/types'

type Container = Record<string, any>
const pages: Container[] = []
const textUpdates: Container[] = []
const calls: string[] = []
let emit: (e: any) => void = () => {}

const fakeBridge = {
  onEvenHubEvent: (cb: (e: any) => void) => { emit = cb; return () => {} },
  createStartUpPageContainer: async (c: Container) => { calls.push('create'); pages.push(c); return 0 },
  rebuildPageContainer: async (c: Container) => { calls.push('rebuild'); pages.push(c); return true },
  textContainerUpgrade: async (c: Container) => { textUpdates.push(c); return true },
  audioControl: async (on: boolean) => { calls.push(`mic:${on}`); return true },
  shutDownPageContainer: async (m: number) => { calls.push(`exit:${m}`); return true },
  getLocalStorage: async () => '',
  setLocalStorage: async () => true,
}

const chats: InboxItem[] = Array.from({ length: 25 }, (_, i) => ({
  id: String(1000 + i), title: `Friend Number ${i} With A Long Name`, kind: 'user', unread: i % 3, lastFrom: 'x',
  lastText: 'A message that is quite long and goes on and on '.repeat(3), lastDate: 1000 - i, priority: i === 0 ? 'urgent' : 'normal', summary: 'Needs a reply about dinner plans tonight at eight',
}))

const fakeApi = {
  configured: true,
  config: { baseUrl: 'http://x', token: 't' },
  status: async () => ({ version: '1', telegram: { mode: 'mock', state: 'ready' }, ai: 'qwen2.5:3b', stt: 'fake', ton: { network: 'testnet', wallet: 'w' }, defaultFiat: 'AED' }),
  events: () => () => {},
  inbox: async () => ({ chats: chats.slice(0, 17) }),
  messages: async (id: string) => ({ chat: { ...chats[0]!, id }, messages: Array.from({ length: 14 }, (_, i) => ({ id: i, chatId: id, from: 'Ali Hassan', out: i % 2 === 0, text: `Message ${i} `.repeat(8), date: i })) }),
  markRead: async () => ({ ok: true }),
  drafts: async (id: string) => ({ plans: [
    { id: 'd1', kind: 'send', title: 'Reply', body: 'Yes, on it', targets: [{ chatId: id, title: 'x' }] },
    { id: 'd2', kind: 'send', title: 'Reply', body: 'Can’t right now 🙏 sorry, will call you after the meeting ends today', targets: [{ chatId: id, title: 'x' }] },
  ] }),
  voice: async () => ({ transcript: 'Split 240 with Ali', result: { type: 'confirm', plan: { id: 'p1', kind: 'payment_request', title: 'Split bill', body: '240 AED / 2\nAli Hassan: 120 AED (31.80 TON)', targets: [] } } }),
  execute: async () => ({ title: 'Requests sent', body: '31.80 TON requested from Ali Hassan' }),
} as unknown as Api

const tick = () => new Promise(r => setTimeout(r, 20))
const loud = () => { const b = new Uint8Array(3200); const v = new DataView(b.buffer); for (let i = 0; i < 1600; i++) v.setInt16(i * 2, Math.round(Math.sin(i / 3) * 12000), true); return b }

function checkPage(c: Container) {
  const v = validateEvenHubPageContainer(c as any)
  expect(v.valid, JSON.stringify(v)).toBe(true)
  const all = [...(c.textObject ?? []), ...(c.listObject ?? [])]
  expect(c.containerTotalNum).toBe(all.length)
  expect(all.filter((x: Container) => x.isEventCapture === 1)).toHaveLength(1)
  expect(new Set(all.map((x: Container) => x.containerID)).size).toBe(all.length)
  for (const x of all) {
    expect(x.containerName.length).toBeLessThanOrEqual(16)
    expect(x.xPosition + x.width).toBeLessThanOrEqual(576)
    expect(x.yPosition + x.height).toBeLessThanOrEqual(288)
  }
  for (const t of c.textObject ?? []) expect(t.content.length).toBeLessThanOrEqual(1000)
  for (const l of c.listObject ?? []) {
    expect(l.itemContainer.itemCount).toBe(l.itemContainer.itemName.length)
    expect(l.itemContainer.itemCount).toBeLessThanOrEqual(20)
    for (const n of l.itemContainer.itemName) expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(63)
  }
}

describe('controller on a (fake) G2', () => {
  it('renders only valid pages through inbox → chat → voice → confirm → done', async () => {
    const g = new (Glasses as any)(fakeBridge) as Glasses
    const c = new Controller(g, fakeApi)
    await c.start()
    expect(calls[0]).toBe('create') // created exactly once …
    expect(pages.at(-1)!.listObject[0].itemContainer.itemName[0]).toContain('Speak')

    // tap 2nd list item (first chat); index 0 is omitted by protobuf, so send 1
    emit({ listEvent: { containerName: 'inbox', currentSelectItemIndex: 1 } })
    await tick()
    expect(pages.at(-1)!.textObject[0].content).toContain('Friend Number 0')

    // swipe up pages back through history without a rebuild
    const before = pages.length
    emit({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
    await tick()
    expect(pages.length).toBe(before)
    expect(textUpdates.some(t => t.containerName === 'body')).toBe(true)

    // single tap (eventType omitted) on chat → AI drafts + "speak a reply"
    emit({ sysEvent: {} })
    await tick()
    const reply = pages.at(-1)!.listObject[0].itemContainer.itemName as string[]
    expect(reply[0]).toBe('Yes, on it')
    expect(reply[1]).not.toMatch(/🙏/) // no emoji on the glasses font
    expect(reply.at(-1)).toContain('Speak a reply')
    emit({ listEvent: { containerName: 'reply', currentSelectItemIndex: reply.length - 1 } })
    await tick()
    expect(calls).toContain('mic:true')
    expect(pages.at(-1)!.textObject[0].content).toContain('Reply to')
    emit({ audioEvent: { audioPcm: loud() } })
    emit({ sysEvent: {} }) // tap = done
    await tick()
    expect(calls).toContain('mic:false')
    expect(pages.at(-1)!.listObject[0].itemContainer.itemName).toEqual(['Send requests', 'Cancel'])

    // first item selected: currentSelectItemIndex omitted (protobuf zero)
    emit({ listEvent: { containerName: 'choice' } })
    await tick()
    expect(pages.at(-1)!.textObject[0].content).toBe('Requests sent')

    // double tap on inbox shows the system exit dialog
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }) // info → back to the chat
    await tick()
    expect(pages.at(-1)!.textObject[0].content).toContain('Friend Number 0')
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }) // chat → inbox
    await tick()
    expect(calls).not.toContain('exit:1')
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await tick()
    expect(calls.filter(x => x === 'create')).toHaveLength(1) // … and only rebuilt after that
    expect(calls).toContain('exit:1')

    for (const p of pages) checkPage(p)
    for (const t of textUpdates) expect(t.content.length).toBeLessThanOrEqual(2000)
    c.dispose()
  })

  it('approves an AI-drafted reply in three taps', async () => {
    pages.length = 0
    const executed: string[] = []
    const api = { ...fakeApi, execute: async (id: string) => { executed.push(id); return { title: 'Sent', body: 'Sent to x' } } } as unknown as Api
    const g = new (Glasses as any)(fakeBridge) as Glasses
    const c = new Controller(g, api)
    await c.start()
    emit({ listEvent: { containerName: 'inbox', currentSelectItemIndex: 1 } }) // open chat
    await tick()
    emit({ sysEvent: {} }) // tap → drafts
    await tick()
    emit({ listEvent: { containerName: 'reply' } }) // first draft (index omitted)
    await tick()
    expect(pages.at(-1)!.textObject[1].content).toContain('Yes, on it')
    expect(executed).toEqual([]) // nothing sent before confirmation
    emit({ listEvent: { containerName: 'choice' } }) // Send
    await tick()
    expect(executed).toEqual(['d1'])
    for (const p of pages) checkPage(p)
    c.dispose()
  })
})
