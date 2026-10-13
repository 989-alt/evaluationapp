// 웹앱(AI 생기부 보조 생성기) 탭에서 동작하는 content script (isolated world).
// localStorage['saenggibu-neis']만 읽습니다. API 키가 든 앱 본체 저장소('saenggibu-v2')는 절대 읽지 않습니다.
;(() => {
  'use strict'
  if (globalThis.__sgbBridgeLoaded) return
  globalThis.__sgbBridgeLoaded = true

  const KEY = 'saenggibu-neis'
  const KINDS = ['subject', 'behavior', 'creative']
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined)

  /** 알려진 필드만 남깁니다. 모양이 맞지 않으면 null */
  function cleanPayload(p) {
    if (!p || typeof p !== 'object') return null
    if (!KINDS.includes(p.kind) || !Array.isArray(p.rows)) return null
    const rows = []
    for (const r of p.rows) {
      if (!r || typeof r !== 'object') continue
      const student = Number(r.student)
      if (!Number.isInteger(student) || student < 1 || student > 999) continue
      if (typeof r.text !== 'string') continue
      const row = { student, text: r.text.slice(0, 20000) }
      if (Array.isArray(r.standards)) {
        row.standards = r.standards
          .filter((s) => s && typeof s === 'object' && typeof s.code === 'string')
          .slice(0, 100)
          .map((s) => ({ code: str(s.code, 100), level: str(s.level, 20) ?? '', criterion: str(s.criterion, 5000) ?? '' }))
      }
      rows.push(row)
      if (rows.length >= 200) break
    }
    const out = { version: 1, createdAt: Number.isFinite(p.createdAt) ? p.createdAt : Date.now(), kind: p.kind, rows }
    const subject = str(p.subject, 100)
    if (subject) out.subject = subject
    return out
  }

  function cleanList(payloads) {
    if (!Array.isArray(payloads)) return null
    return payloads.slice(0, 100).map(cleanPayload).filter(Boolean)
  }

  /** localStorage에서 읽습니다. 키가 없거나 모양이 다르면 null */
  function readStorage() {
    let raw
    try {
      raw = localStorage.getItem(KEY)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const data = JSON.parse(raw)
      if (!data || data.version !== 1) return null
      return cleanList(data.payloads)
    } catch {
      return null
    }
  }

  async function send(payloads) {
    if (!payloads) return { ok: false, reason: 'no-data' }
    try {
      await chrome.runtime.sendMessage({ type: 'payloads', payloads, source: location.origin })
      return { ok: true, count: payloads.length }
    } catch {
      // 확장이 다시 로드된 경우 등. 다음 이벤트에서 다시 시도합니다
      return { ok: false, reason: 'send-failed' }
    }
  }

  // 1) 처음 열릴 때
  send(readStorage())

  // 2) 웹앱이 같은 탭에서 바로 알려 줄 때 (src/store/index.ts의 mirrorNeis)
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const d = event.data
    if (!d || typeof d !== 'object' || d.type !== 'saenggibu-neis') return
    send(cleanList(d.payloads) ?? readStorage())
  })

  // 3) 다른 탭에서 바뀌었을 때
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) send(readStorage())
  })

  // 4) 팝업의 "웹앱에서 다시 가져오기"
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'reread') return false
    send(readStorage()).then(sendResponse)
    return true
  })
})()
