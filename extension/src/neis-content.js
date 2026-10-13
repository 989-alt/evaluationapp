// 나이스 탭(모든 프레임)에서 동작하는 content script (isolated world).
// 팝업/서비스 워커의 명령을 MAIN world 엔진(neis-main.js, window.__sgbNeis)에 window.postMessage로 넘기고 답을 돌려줍니다.
// 학생 이름이나 셀 내용을 저장하거나 밖으로 보내지 않습니다.
;(() => {
  'use strict'
  if (globalThis.__sgbContentLoaded) return
  globalThis.__sgbContentLoaded = true

  // neis-main.js의 VERSION과 같아야 합니다. 확장을 업데이트한 뒤 새로고침하지 않은 나이스 탭에는 예전 엔진이 남아 있으므로 막습니다
  const ENGINE_VERSION = '0.2.0'
  const TIMEOUT = { detect: 10000, scan: 10000, inspect: 15000, fill: 10 * 60 * 1000, stop: 3000, ping: 500 }
  const pending = new Map() // nonce -> { resolve, timer, progress }

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
      if (p.progress) p.progress(d)
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

  // ---------- 페이지에서 온 값 정리 (페이지 스크립트가 같은 창에 메시지를 보낼 수 있으므로) ----------
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const ints = (v) => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x)).slice(0, 200) : [])
  const short = (v, n) => String(v ?? '').slice(0, n)
  const STRATEGIES = ['cpr-known', 'cpr', 'dom']
  const strategy = (v) => (STRATEGIES.includes(v) ? v : null)
  const strs = (v, n, cap) => (Array.isArray(v) ? v.slice(0, cap).map((x) => short(x, n)) : [])
  const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  /** 앱 id (예: edu/sw/els/sdl/ce/els_sdlce04_m00$2) — 경로 모양 글자만 */
  const appIdStr = (v) => (typeof v === 'string' && /^[\w/$.-]{1,100}$/.test(v) ? v : null)
  function cleanUnmatched(v) {
    return Array.isArray(v)
      ? v
          .filter((u) => u && Number.isInteger(u.student))
          .slice(0, 200)
          .map((u) => ({ student: u.student, code: short(u.code, 100) }))
      : []
  }

  function cleanProgress(d) {
    return {
      phase: short(d.phase, 20),
      done: num(d.done),
      total: num(d.total),
      current: Number.isInteger(d.current) ? d.current : null,
      type: 'progress',
    }
  }

  /** detect 답: 알려진 필드만 (팝업·서비스 워커가 쓰는 것) */
  function cleanDetect(d) {
    if (!d || typeof d !== 'object') return { error: 'no-result' }
    if (d.error) return { error: short(d.error, 100) }
    return {
      screen: short(d.screen, 20),
      detectedScreen: short(d.detectedScreen, 20),
      forced: d.forced === true,
      running: d.running === true,
      ready: d.ready === true,
      strategy: strategy(d.strategy),
      knownApp: d.knownApp === true,
      activeApp: appIdStr(d.activeApp),
      datasetRows: numOrNull(d.datasetRows),
      warnings: strs(d.warnings, 60, 10),
      rows: num(d.rows),
      cpr: d.cpr === true,
      cprVersion: d.cprVersion == null ? null : short(d.cprVersion, 40),
      apps: num(d.apps),
      titleScreen: d.titleScreen == null ? null : short(d.titleScreen, 20),
      titles: strs(d.titles, 40, 10),
      grids: Array.isArray(d.grids)
        ? d.grids.slice(0, 20).map((g) => ({
            source: short(g && g.source, 20),
            appId: g && g.appId != null ? short(g.appId, 100) : null,
            ctrlId: g && g.ctrlId != null ? short(g.ctrlId, 100) : null,
            rows: num(g && g.rows),
            columns: Array.isArray(g && g.columns)
              ? g.columns.slice(0, 60).map((c) => ({
                  header: short(c && c.header, 60),
                  name: c && c.name != null ? short(c.name, 100) : null,
                  role: c && c.role != null ? short(c.role, 20) : null,
                }))
              : [],
          }))
        : [],
      path: short(d.path, 200),
    }
  }

  function cleanResult(r) {
    if (!r || typeof r !== 'object') return { error: 'no-result' }
    const out = {
      screen: short(r.screen, 20),
      strategy: strategy(r.strategy),
      activeApp: appIdStr(r.activeApp),
      filled: num(r.filled),
      rows: num(r.rows),
      cells: num(r.cells),
      skipped: num(r.skipped),
      autoFilled: num(r.autoFilled),
      verifyFailed: num(r.verifyFailed),
      failed: num(r.failed),
      confirmed: num(r.confirmed),
      missing: ints(r.missing),
      ambiguous: ints(r.ambiguous),
      unmatchedStandards: cleanUnmatched(r.unmatchedStandards),
      notes: Array.isArray(r.notes) ? r.notes.slice(0, 20).map((x) => short(x, 300)) : [],
      saved: r.saved === true,
      aborted: r.aborted === true,
    }
    if (r.error) out.error = short(r.error, 100)
    return out
  }

  /** 인식 검사 답: 숫자·번호·짧은 글자만 */
  function cleanInspect(r) {
    if (!r || typeof r !== 'object') return { error: 'no-result' }
    const intMap = (v) => {
      if (!v || typeof v !== 'object') return null
      const out = {}
      for (const [k, n] of Object.entries(v).slice(0, 200)) if (/^\d{1,4}$/.test(k) && Number.isInteger(n)) out[k] = n
      return out
    }
    const codes = (v) => {
      if (!v || typeof v !== 'object') return null
      const out = {}
      for (const [k, c] of Object.entries(v).slice(0, 20)) out[short(k, 20)] = short(c, 40)
      return out
    }
    const out = {
      screen: short(r.screen, 20),
      strategy: strategy(r.strategy),
      knownApp: r.knownApp === true,
      activeApp: appIdStr(r.activeApp),
      datasetRows: numOrNull(r.datasetRows),
      knownApps: Array.isArray(r.knownApps)
        ? r.knownApps.slice(0, 20).map((k) => ({
            id: appIdStr(k && k.id),
            screen: short(k && k.screen, 20),
            visible: k && typeof k.visible === 'boolean' ? k.visible : null,
            rows: num(k && k.rows),
          }))
        : [],
      studentsFound: num(r.studentsFound),
      studentsMissing: ints(r.studentsMissing),
      ambiguous: ints(r.ambiguous),
      standardsPerStudent: intMap(r.standardsPerStudent),
      unmatchedStandards: cleanUnmatched(r.unmatchedStandards),
      tasks: num(r.tasks),
      cells: num(r.cells),
      levelCodes: codes(r.levelCodes),
      resultAutoFill: typeof r.resultAutoFill === 'boolean' ? r.resultAutoFill : null,
      warnings: strs(r.warnings, 60, 20),
      notes: strs(r.notes, 300, 20),
    }
    if (r.error) out.error = short(r.error, 100)
    return out
  }

  /** 엔진 상태: 'ok' | 'old'(예전 버전) | null(없음) */
  async function enginePresent(ms = TIMEOUT.ping) {
    const r = await callEngine('ping', null, ms)
    if (!(r && r.ok)) return null
    return r.version === ENGINE_VERSION ? 'ok' : 'old'
  }

  /** MAIN world 엔진이 없으면 서비스 워커에 넣어 달라고 합니다 (scripting.executeScript, world:'MAIN') */
  async function ensureEngine() {
    const now = await enginePresent()
    if (now) return now
    try {
      await chrome.runtime.sendMessage({ type: 'inject-main' })
    } catch {
      // 아래에서 엔진 없음으로 처리
    }
    return enginePresent(800)
  }

  async function handle(msg) {
    const cmd = msg.cmd
    if (cmd === 'ping') return { ok: true, frame: location.href.slice(0, 80) }
    if (!['detect', 'scan', 'fill', 'inspect', 'stop'].includes(cmd)) return { error: 'unknown-command' }
    if (cmd === 'stop') {
      if (!(await enginePresent())) return { ok: true, engine: false }
      return callEngine('stop', null, TIMEOUT.stop)
    }
    const engine = await ensureEngine()
    if (!engine) return { error: 'engine-missing' }
    if (engine === 'old') return { error: 'engine-outdated' }
    if (cmd === 'fill') {
      const result = cleanResult(
        await callEngine('fill', msg.args, TIMEOUT.fill, (p) => {
          chrome.runtime.sendMessage(cleanProgress(p)).catch(() => {})
        }),
      )
      chrome.runtime.sendMessage({ result, type: 'fill-done' }).catch(() => {})
      return result
    }
    if (cmd === 'detect') return cleanDetect(await callEngine('detect', msg.args, TIMEOUT.detect))
    if (cmd === 'inspect') return cleanInspect(await callEngine('inspect', msg.args, TIMEOUT.inspect))
    return callEngine(cmd, msg.args, TIMEOUT[cmd])
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof msg.cmd !== 'string') return false
    handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e && e.message ? e.message : e) }))
    return true
  })
})()
