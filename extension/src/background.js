// 서비스 워커: 데이터 보관(chrome.storage.local), 배지, 팝업 ↔ 나이스 탭 메시지 중계.
// 네트워크 요청은 하지 않습니다.
'use strict'

const APP_URLS = ['https://989-alt.github.io/evaluationapp/*', 'http://localhost/*', 'http://127.0.0.1/*']
/** 웹앱 주소인지 (GitHub Pages는 /evaluationapp/ 아래만, 개발용 localhost·127.0.0.1은 모든 포트) */
function isAppUrl(url) {
  try {
    const u = new URL(url)
    if (u.origin === 'https://989-alt.github.io') return u.pathname.startsWith('/evaluationapp/')
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}
const SCAN_MAX_BYTES = 300 * 1024
const TIMEOUT = { ping: 1500, detect: 15000, scan: 15000, fill: 11 * 60 * 1000, stop: 3000 }
const KINDS = ['subject', 'behavior', 'creative']

// ---------- 데이터 ----------
function cleanPayloads(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const p of list.slice(0, 100)) {
    if (!p || !KINDS.includes(p.kind) || !Array.isArray(p.rows)) continue
    const rows = p.rows
      .filter((r) => r && Number.isInteger(r.student) && typeof r.text === 'string')
      .map((r) => {
        const row = { student: r.student, text: r.text }
        if (Array.isArray(r.standards))
          row.standards = r.standards
            .filter((s) => s && typeof s.code === 'string')
            .map((s) => ({ code: s.code, level: String(s.level ?? ''), criterion: String(s.criterion ?? '') }))
        return row
      })
    const q = { version: 1, createdAt: Number(p.createdAt) || Date.now(), kind: p.kind, rows }
    if (typeof p.subject === 'string' && p.subject) q.subject = p.subject
    out.push(q)
  }
  return out
}

async function setBadge(n) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#FF5A1F' })
    await chrome.action.setBadgeText({ text: n ? String(n) : '' })
  } catch {
    // 무시
  }
}

async function storePayloads(payloads, source) {
  await chrome.storage.local.set({ payloads, importedAt: Date.now(), source })
  await setBadge(payloads.length)
}

async function getState() {
  const s = await chrome.storage.local.get(['payloads', 'importedAt', 'source', 'lastRun'])
  return { payloads: s.payloads ?? [], importedAt: s.importedAt ?? null, source: s.source ?? null, lastRun: s.lastRun ?? null }
}

// ---------- 나이스 탭 ----------
const chosenFrame = new Map() // tabId -> frameId (서비스 워커가 다시 뜨면 session 저장소에서 복원)

async function rememberFrame(tabId, frameId) {
  chosenFrame.set(tabId, frameId)
  try {
    await chrome.storage.session.set({ ['frame:' + tabId]: frameId })
  } catch {
    // 무시
  }
}
async function recallFrame(tabId) {
  if (chosenFrame.has(tabId)) return chosenFrame.get(tabId)
  try {
    const k = 'frame:' + tabId
    const s = await chrome.storage.session.get(k)
    if (typeof s[k] === 'number') return s[k]
  } catch {
    // 무시
  }
  return null
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))])
}

async function sendToFrame(tabId, frameId, msg, ms) {
  return withTimeout(chrome.tabs.sendMessage(tabId, msg, { frameId }), ms, msg.cmd)
}

/** 탭의 프레임 목록 (frameId, 주소). content script가 없는 프레임도 포함 */
async function listFrames(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    })
    return res.map((r) => ({ frameId: r.frameId, href: String(r.result || '') }))
  } catch {
    return [{ frameId: 0, href: '' }]
  }
}

/** content script가 없으면(확장 설치 전에 열린 탭 등) 넣어 줍니다 */
async function ensureContent(tabId) {
  try {
    await sendToFrame(tabId, 0, { cmd: 'ping' }, TIMEOUT.ping)
    return true
  } catch {
    // 아래에서 주입
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/neis-content.js'] })
    return true
  } catch {
    return false
  }
}

async function frameCall(tabId, frameId, cmd, args) {
  try {
    const r = await sendToFrame(tabId, frameId, { cmd, args }, TIMEOUT[cmd] ?? 12000)
    return r ?? { error: 'no-response' }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) }
  }
}

/** 프레임 고르기 점수: 입력할 표가 있으면(ready) 가장 높게, 화면을 몰라도 표 개수로 */
function screenScore(d) {
  if (!d || d.error) return 0
  return (d.ready ? 100 : 0) + (d.screen && d.screen !== 'unknown' ? 10 : 0) + Math.min(9, d.grids?.length ?? 0) + (d.cpr ? 5 : 0) + 1
}

async function detect(tabId, args) {
  const ok = await ensureContent(tabId)
  const frames = await listFrames(tabId)
  const results = await Promise.all(frames.map(async (f) => ({ frameId: f.frameId, d: await frameCall(tabId, f.frameId, 'detect', args) })))
  const answered = results.filter((r) => r.d && !r.d.error)
  if (!answered.length) {
    const err = results.find((r) => r.d?.error)?.d?.error ?? (ok ? 'no-response' : 'content-missing')
    return { screen: 'unknown', error: err, frames: frames.length }
  }
  answered.sort((a, b) => screenScore(b.d) - screenScore(a.d))
  const best = answered[0]
  await rememberFrame(tabId, best.frameId)
  return { ...best.d, frameId: best.frameId, frames: frames.length, framesAnswered: answered.length }
}

async function scan(tabId) {
  await ensureContent(tabId)
  const frames = await listFrames(tabId)
  const per = Math.max(24 * 1024, Math.floor((SCAN_MAX_BYTES - 4096) / Math.max(1, frames.length)))
  const results = await Promise.all(frames.map(async (f) => ({ frameId: f.frameId, scan: await frameCall(tabId, f.frameId, 'scan', { maxBytes: per }) })))
  let list = results.filter((r) => r.scan && !r.scan.error)
  const out = {
    kind: 'sgb-neis-scan',
    version: 1,
    extVersion: chrome.runtime.getManifest().version,
    createdAt: new Date().toISOString(),
    frames: list,
    framesWithoutEngine: results.length - list.length,
  }
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length
  // 화면을 알아본 프레임·표가 많은 프레임을 앞에 둡니다. 상한을 넘으면 뒤(표가 없는 프레임)부터 뺍니다
  list.sort((a, b) => screenScore(b.scan.detect) - screenScore(a.scan.detect) || (b.scan.grids?.length ?? 0) - (a.scan.grids?.length ?? 0))
  out.frames = list
  if (size() > SCAN_MAX_BYTES) {
    list = list.filter((r) => (r.scan.grids?.length ?? 0) > 0)
    out.frames = list
    out.truncated = true
  }
  while (size() > SCAN_MAX_BYTES && out.frames.length > 1) out.frames = out.frames.slice(0, -1)
  const best = out.frames.slice().sort((a, b) => screenScore(b.scan.detect) - screenScore(a.scan.detect))[0]
  out.screen = best?.scan?.detect?.screen ?? 'unknown'
  return out
}

async function runCommand(tabId, cmd, args) {
  if (cmd === 'detect') return detect(tabId, args)
  if (cmd === 'scan') return scan(tabId)
  if (cmd === 'stop') {
    const frames = await listFrames(tabId)
    await Promise.all(frames.map((f) => frameCall(tabId, f.frameId, 'stop')))
    return { ok: true }
  }
  if (cmd === 'fill') {
    const startedAt = Date.now()
    let frameId = await recallFrame(tabId)
    if (frameId == null) {
      const d = await detect(tabId, { screen: args && args.screen })
      if (d.error || d.frameId == null) return { error: d.error || 'no-screen' }
      frameId = d.frameId
    }
    let result = await frameCall(tabId, frameId, 'fill', args)
    if (result && /Could not establish connection|Receiving end does not exist|No frame/i.test(String(result.error || ''))) {
      // 화면이 바뀌어 기억한 프레임이 없어진 경우: 다시 인식하고 한 번 더
      const d = await detect(tabId, { screen: args && args.screen })
      if (!d.error && d.frameId != null) result = await frameCall(tabId, d.frameId, 'fill', args)
    }
    // 시간 초과 같은 오류가 content script의 정상 결과(fill-done)를 덮어쓰지 않게 합니다
    const prev = (await chrome.storage.local.get('lastRun')).lastRun
    if (!result.error || !prev || prev.at < startedAt) await chrome.storage.local.set({ lastRun: { at: Date.now(), tabId, result } })
    return result
  }
  if (cmd === 'ping') return frameCall(tabId, 0, 'ping')
  return { error: 'unknown-command' }
}

// ---------- 메시지 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false
  // 팝업 등 확장 페이지에서 온 메시지인지 (content script는 웹 페이지 주소를 가짐)
  const fromExtPage = sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))
  const reply = (p) => {
    p.then(sendResponse, (e) => sendResponse({ error: String(e && e.message ? e.message : e) }))
    return true
  }

  switch (msg.type) {
    case 'payloads': {
      // 웹앱 탭의 app-bridge.js에서만 받습니다
      if (!sender.tab || !isAppUrl(sender.url || '')) return false
      const origin = new URL(sender.url).origin
      const payloads = cleanPayloads(msg.payloads)
      if (!payloads) return false
      return reply(storePayloads(payloads, origin).then(() => ({ ok: true, count: payloads.length })))
    }
    case 'get-state':
      if (!fromExtPage) return false
      return reply(getState())
    case 'clear':
      if (!fromExtPage) return false
      return reply(
        chrome.storage.local.remove(['payloads', 'importedAt', 'source', 'lastRun']).then(async () => {
          await setBadge(0)
          return { ok: true }
        }),
      )
    case 'reread':
      if (!fromExtPage) return false
      return reply(
        (async () => {
          const tabs = await chrome.tabs.query({ url: APP_URLS })
          let ok = 0
          for (const t of tabs) {
            try {
              const r = await withTimeout(chrome.tabs.sendMessage(t.id, { type: 'reread' }), 3000, 'reread')
              if (r && r.ok) ok++
            } catch {
              // 이 탭에는 bridge가 없음
            }
          }
          return { tabs: tabs.length, ok, state: await getState() }
        })(),
      )
    case 'inject-main': {
      // 나이스 탭의 neis-content.js가 엔진(MAIN world)을 요청
      const tabId = sender.tab?.id
      if (tabId == null) return false
      const target = typeof sender.frameId === 'number' ? { tabId, frameIds: [sender.frameId] } : { tabId, allFrames: true }
      return reply(
        chrome.scripting
          .executeScript({ target, world: 'MAIN', files: ['src/neis-main.js'] })
          .then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e && e.message ? e.message : e) })),
      )
    }
    case 'neis-command':
      if (!fromExtPage) return false
      if (typeof msg.tabId !== 'number' || typeof msg.cmd !== 'string') return false
      return reply(runCommand(msg.tabId, msg.cmd, msg.args))
    case 'fill-done':
      // 팝업이 닫혀 있어도 마지막 결과를 남깁니다
      if (!sender.tab) return false
      chrome.storage.local.set({ lastRun: { at: Date.now(), tabId: sender.tab.id, result: msg.result } })
      return false
    case 'progress':
      return false // 팝업이 직접 받습니다
    default:
      return false
  }
})

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get('payloads')
  await setBadge(Array.isArray(s.payloads) ? s.payloads.length : 0)
})
chrome.runtime.onStartup?.addListener(async () => {
  const s = await chrome.storage.local.get('payloads')
  await setBadge(Array.isArray(s.payloads) ? s.payloads.length : 0)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  chosenFrame.delete(tabId)
  chrome.storage.session?.remove('frame:' + tabId).catch(() => {})
})
