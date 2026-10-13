// 나이스 탭(모든 프레임)에서 동작하는 content script (isolated world).
// 팝업/서비스 워커의 명령을 MAIN world 엔진(neis-main.js, window.__sgbNeis)에 window.postMessage로 넘기고 답을 돌려줍니다.
// 학생 이름이나 셀 내용을 저장하거나 밖으로 보내지 않습니다.
;(() => {
  'use strict'
  if (globalThis.__sgbContentLoaded) return
  globalThis.__sgbContentLoaded = true

  const TIMEOUT = { detect: 10000, scan: 10000, fill: 10 * 60 * 1000, stop: 3000, ping: 500 }
  const pending = new Map() // nonce -> { resolve, timer, progress }
  let injectAsked = false

  const newNonce = () => {
    const a = new Uint32Array(4)
    crypto.getRandomValues(a)
    return 'sgb-' + Array.from(a, (n) => n.toString(36)).join('')
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const d = event.data
    if (!d || typeof d !== 'object') return
    if (typeof d.__sgbReply === 'string' && pending.has(d.__sgbReply)) {
      const p = pending.get(d.__sgbReply)
      pending.delete(d.__sgbReply)
      clearTimeout(p.timer)
      p.resolve(d.result)
    } else if (typeof d.__sgbProgress === 'string' && pending.has(d.__sgbProgress)) {
      const p = pending.get(d.__sgbProgress)
      if (p.progress) {
        const { __sgbProgress: _n, ...rest } = d
        p.progress(rest)
      }
    }
  })

  /** 엔진에 명령을 보냅니다. 시간 안에 답이 없으면 { error:'timeout' } */
  function callEngine(cmd, args, ms, progress) {
    return new Promise((resolve) => {
      const nonce = newNonce()
      const timer = setTimeout(() => {
        pending.delete(nonce)
        resolve({ error: 'timeout', cmd })
      }, ms)
      pending.set(nonce, { resolve, timer, progress })
      window.postMessage({ __sgb: nonce, cmd, args: args ?? null }, '*')
    })
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function enginePresent(ms = TIMEOUT.ping) {
    const r = await callEngine('ping', null, ms)
    return !!(r && r.ok)
  }

  /** MAIN world 엔진이 없으면 넣습니다: 1) 서비스 워커의 scripting.executeScript(world:'MAIN') 2) <script src> */
  async function ensureEngine() {
    if (await enginePresent()) return true
    if (!injectAsked) {
      injectAsked = true
      try {
        await chrome.runtime.sendMessage({ type: 'inject-main' })
      } catch {
        // 무시하고 다음 방법
      }
      if (await enginePresent(800)) return true
    }
    try {
      const s = document.createElement('script')
      s.src = chrome.runtime.getURL('src/neis-main.js')
      s.async = false
      ;(document.head || document.documentElement).appendChild(s)
      await new Promise((r) => {
        s.onload = r
        s.onerror = r
        setTimeout(r, 1500)
      })
      s.remove()
    } catch {
      // 무시
    }
    await sleep(50)
    return enginePresent(800)
  }

  async function handle(msg) {
    const cmd = msg.cmd
    if (cmd === 'ping') return { ok: true, frame: location.href.slice(0, 80) }
    if (!['detect', 'scan', 'fill', 'stop'].includes(cmd)) return { error: 'unknown-command' }
    if (cmd === 'stop') {
      if (!(await enginePresent())) return { ok: true, engine: false }
      return callEngine('stop', null, TIMEOUT.stop)
    }
    if (!(await ensureEngine())) return { error: 'engine-missing' }
    if (cmd === 'fill') {
      const result = await callEngine('fill', msg.args, TIMEOUT.fill, (p) => {
        chrome.runtime.sendMessage({ type: 'progress', ...p }).catch(() => {})
      })
      chrome.runtime.sendMessage({ type: 'fill-done', result }).catch(() => {})
      return result
    }
    return callEngine(cmd, msg.args, TIMEOUT[cmd])
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof msg.cmd !== 'string') return false
    handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e && e.message ? e.message : e) }))
    return true
  })
})()
