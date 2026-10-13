// 팝업: 데이터 확인 · 나이스 화면 인식 · 자동 입력. 학생 이름은 다루지 않습니다(데이터에 없음).
'use strict'

const $ = (id) => document.getElementById(id)
const KIND_LABEL = { subject: '교과 평어', behavior: '행동특성', creative: '창체' }
const KIND_TINT = { subject: 'lv-1', behavior: 'lv-0', creative: 'lv-2' }
const SCREEN_LABEL = {
  교과평가: '교과평가',
  학기말종합의견: '학기말종합의견',
  행동특성: '행동특성 및 종합의견',
  학생부자료기록: '학생부자료기록 (창체)',
  동아리활동관리: '동아리활동관리',
  진로활동관리: '진로활동관리',
}
const SCREEN_SLUG = {
  교과평가: 'subject-eval',
  학기말종합의견: 'semester-opinion',
  행동특성: 'behavior',
  학생부자료기록: 'creative-record',
  동아리활동관리: 'club',
  진로활동관리: 'career',
}
const ERR = {
  'content-missing': '나이스 탭과 연결하지 못했습니다. 나이스 탭을 새로고침(F5)한 뒤 다시 열어 주세요.',
  'no-response': '나이스 탭이 응답하지 않습니다. 새로고침(F5)한 뒤 다시 시도하세요.',
  'engine-missing': '입력 엔진을 화면에 넣지 못했습니다. 새로고침(F5) 후 다시 시도하세요.',
  timeout: '응답 시간이 지났습니다. 화면이 다 열렸는지 확인하고 다시 시도하세요.',
  'grid-not-found': '입력할 표를 찾지 못했습니다. 나이스에서 "조회"를 누른 뒤 다시 시도하세요.',
  'unknown-screen': '화면을 알아보지 못했습니다. "화면 지정"에서 직접 고르세요.',
  busy: '이미 입력 중입니다.',
  'bad-job': '입력 데이터 모양이 올바르지 않습니다.',
  'mixed-classes': '여러 반이 섞인 명단입니다. 반을 하나만 조회한 뒤 다시 실행하세요.',
  'subject-mismatch': '나이스 화면에서 고른 과목과 데이터 과목이 다릅니다. 과목을 맞춘 뒤 다시 실행하세요.',
}
/** 오류 → { text, raw } (모르는 오류는 일반 안내 + 원문을 작게) */
function errInfo(e) {
  const s = String(e || '')
  if (ERR[s]) return { text: ERR[s], raw: '' }
  if (s.startsWith('timeout')) return { text: ERR.timeout, raw: '' }
  if (/Could not establish connection|Receiving end does not exist/i.test(s)) return { text: ERR['content-missing'], raw: '' }
  return { text: '알 수 없는 오류가 났습니다. 나이스 탭을 새로고침한 뒤 다시 시도하세요.', raw: s.slice(0, 200) }
}
function putErr(node, e) {
  const { text, raw } = errInfo(e)
  node.textContent = text
  if (raw) {
    const small = document.createElement('span')
    small.className = 'raw'
    small.textContent = ' (' + raw + ')'
    node.append(small)
  }
  return node
}

// ---------- 사전 검사 (src/lib/validate.ts 규칙의 가벼운 복사본) ----------
const FORBIDDEN = /[^가-힣a-zA-Z0-9 .,()·]/
const SURNAMES = '김이박최정강조윤장임한오서신권황안송전홍'
const NAME_STOP = ['전체', '이번', '고학년', '신입', '한국', '전학', '오늘', '한결같', '이야기', '정확성', '전체적', '안정감', '이해력', '장단점', '한글', '홍보', '장애', '이웃', '한국어', '한국인', '한글날', '오늘날', '홍보물', '한반도', '강수량', '최솟값', '최댓값', '전자석', '전동기', '전라도', '장애물', '신호등', '오각형', '이등변', '강아지', '한라산', '안내문', '서술형', '전통적', '정다면']
const NAME_HARD = new RegExp(`(?:^|[\\s,.(])([${SURNAMES}][가-힣]{1,2})\\s?(?:학생|어린이|군|양)(?=[\\s,.)이은는가의을를과와에]|$)`, 'g')
const splitSentences = (t) => t.split(/(?<=[.。])\s+|(?<=[.。])$/).map((s) => s.trim()).filter(Boolean)
const normSentence = (s) => s.replace(/\s+/g, '').replace(/[.,]/g, '')

function preflight(p) {
  const c = { empty: 0, name: 0, chars: 0, duplicate: 0 }
  const sets = p.rows.map((r) => new Set(splitSentences(String(r.text || '').trim()).map(normSentence)))
  p.rows.forEach((row, i) => {
    const t = String(row.text || '').trim()
    if (!t) {
      c.empty++
      return
    }
    const names = [...t.matchAll(NAME_HARD)].map((m) => m[1]).filter((w) => !NAME_STOP.includes(w))
    if (names.length) c.name++
    if (FORBIDDEN.test(t)) c.chars++
    let dup = false
    for (let j = 0; j < sets.length && !dup; j++) if (j !== i) for (const s of sets[i]) if (sets[j].has(s)) dup = true
    if (dup) c.duplicate++
  })
  return c
}

// ---------- 상태 ----------
const qs = new URLSearchParams(location.search)
let state = { payloads: [], importedAt: null, source: null, lastRun: null }
let tab = null
let tabKind = 'none' // 'neis' | 'gokr' | 'none'
let detected = null
let running = false
let monitoring = false // 팝업을 다시 열었을 때 이미 진행 중인 입력을 지켜보는 중
let lastDone = null // content script가 직접 알려 준 마지막 결과 (서비스 워커 응답이 끊겼을 때 대비)

function send(msg, ms = 15000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e && e.message ? e.message : e) })),
    new Promise((r) => setTimeout(() => r({ error: 'timeout' }), ms)),
  ])
}
const neis = (cmd, args, ms) => send({ type: 'neis-command', tabId: tab.id, cmd, args }, ms)

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fileStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function setMsg(id, text, isErr) {
  const m = $(id)
  m.textContent = text || ''
  m.classList.toggle('err', !!isErr)
}
function setErr(id, e) {
  const m = $(id)
  putErr(m, e)
  m.classList.add('err')
}

// ---------- 데이터 카드 ----------
function payloadTitle(p) {
  return `${KIND_LABEL[p.kind] || p.kind}${p.subject ? ' · ' + p.subject : ''}`
}

function renderData() {
  const list = $('payloads')
  list.textContent = ''
  const ps = state.payloads || []
  $('data-count').textContent = `${ps.length}개`
  $('data-empty').hidden = ps.length > 0
  ps.forEach((p) => {
    const li = el('li')
    const head = el('div', 'head')
    head.append(el('span', 'pill ' + (KIND_TINT[p.kind] || ''), KIND_LABEL[p.kind] || p.kind))
    head.append(el('span', 'title', p.subject || '—'))
    head.append(el('span', 'muted small', `${p.rows.length}명 · ${fmtDate(p.createdAt)}`))
    li.append(head)
    const c = preflight(p)
    const chips = el('div', 'chips')
    const chip = (label, n, always) => {
      if (!always && !n) return
      chips.append(el('span', 'pill ' + (n ? (label === '이름 의심' || label === '허용 외 문자' ? 'lv-3' : 'lv-2') : 'lv-0'), n ? `${label} ${n}` : `✓ ${label}`))
    }
    chip('빈 문장', c.empty, false)
    chip('이름 의심', c.name, true)
    chip('허용 외 문자', c.chars, true)
    chip('중복 문장', c.duplicate, true)
    li.append(chips)
    list.append(li)
  })
  $('data-meta').textContent = state.importedAt ? `가져온 때 ${fmtDate(state.importedAt)}${state.source ? ' · ' + state.source : ''}` : ''
  $('btn-clear').disabled = !ps.length
}

async function loadState() {
  const s = await send({ type: 'get-state' })
  if (s && !s.error) state = s
  renderData()
}

let clearArmed = false
$('btn-clear').addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true
    $('btn-clear').textContent = '한 번 더 누르면 삭제'
    $('btn-clear').classList.add('danger')
    setTimeout(() => {
      clearArmed = false
      $('btn-clear').textContent = '삭제'
      $('btn-clear').classList.remove('danger')
    }, 3000)
    return
  }
  clearArmed = false
  $('btn-clear').textContent = '삭제'
  $('btn-clear').classList.remove('danger')
  await send({ type: 'clear' })
  await loadState()
  renderFill()
  setMsg('data-msg', '확장에 보관한 데이터를 지웠습니다. (웹앱의 데이터는 그대로입니다)')
})

$('btn-reread').addEventListener('click', async () => {
  setMsg('data-msg', '웹앱 탭에서 읽는 중…')
  const r = await send({ type: 'reread' }, 10000)
  if (r.error) return setErr('data-msg', r.error)
  if (!r.tabs) return setMsg('data-msg', '열린 웹앱 탭이 없습니다. 웹앱(989-alt.github.io/evaluationapp)을 연 다음 다시 누르세요.', true)
  if (!r.ok) return setMsg('data-msg', '웹앱 탭에서 데이터를 찾지 못했습니다. 웹앱에서 "나이스로 보내기"를 눌렀는지 확인하세요. 탭을 새로고침해야 할 수도 있습니다.', true)
  state = r.state || state
  renderData()
  renderFill()
  setMsg('data-msg', `가져왔습니다 · 데이터 ${state.payloads.length}개`)
})

// ---------- 화면 카드 ----------
function effectiveScreen() {
  return $('screen-override').value || (detected && detected.screen !== 'unknown' ? detected.screen : null)
}

function renderScreen() {
  const name = $('screen-name')
  const status = $('screen-status')
  const detail = $('screen-detail')
  detail.textContent = ''
  const enabled = tabKind === 'neis' || tabKind === 'gokr-ok'
  $('btn-detect').disabled = !enabled
  $('btn-scan').disabled = !enabled
  $('btn-permit').hidden = tabKind !== 'gokr'
  if (!enabled) {
    name.textContent = '나이스 탭에서 열어 주세요'
    name.classList.remove('ok')
    status.textContent =
      tabKind === 'gokr'
        ? '이 사이트는 나이스 주소(neis.go.kr)가 아닙니다. 나이스 화면이 맞다면 "이 사이트 권한 허용"을 누르세요.'
        : '나이스에 로그인하고 입력할 화면을 조회한 다음, 그 탭에서 확장 아이콘을 누르세요.'
    return
  }
  if (!detected) {
    name.textContent = '확인 중…'
    name.classList.remove('ok')
    status.textContent = ''
    return
  }
  if (detected.error) {
    name.textContent = '연결 안 됨'
    name.classList.remove('ok')
    putErr(status, detected.error)
    return
  }
  const s = detected.screen
  name.textContent = s && s !== 'unknown' ? SCREEN_LABEL[s] || s : '알 수 없는 화면'
  name.classList.toggle('ok', s && s !== 'unknown')
  if (detected.forced) name.textContent += ' (지정)'
  if (detected.running) status.textContent = '입력이 진행 중입니다.'
  else if (detected.ready) status.textContent = `입력할 표를 찾았습니다 · ${detected.rows}행`
  else if (s && s !== 'unknown') status.textContent = '입력할 표가 없습니다. 나이스에서 조회를 누른 뒤 "화면 다시 인식"을 누르세요.'
  else status.textContent = '이 화면을 알아보지 못했습니다. 아래 "화면 지정"에서 고르거나 화면 구조를 수집해 보내 주세요.'
  const parts = []
  parts.push(detected.cpr ? `cpr 감지${detected.cprVersion ? ' (' + detected.cprVersion + ')' : ''} · 앱 ${detected.apps}개` : 'cpr 없음')
  parts.push(`표 ${Array.isArray(detected.grids) ? detected.grids.length : 0}개`)
  if (detected.ready) parts.push(`${detected.strategy === 'cpr' ? 'cpr' : '화면(DOM)'} 방식`)
  if (detected.frames > 1) parts.push(`프레임 ${detected.frames}개`)
  detail.textContent = '자세히 · ' + parts.join(' · ')
}

async function runDetect() {
  detected = null
  renderScreen()
  setMsg('screen-msg', '')
  detected = await neis('detect', { screen: $('screen-override').value || undefined }, 20000)
  if (detected && detected.running && !running) {
    // 팝업을 닫았다 다시 연 경우: 진행 중인 입력을 이어서 보여 주고 중지할 수 있게 합니다
    running = true
    monitoring = true
    showProgress({ done: 0, total: 0 })
    $('progress-text').textContent = '입력 중… (진행 상황을 기다리는 중)'
  }
  renderScreen()
  renderFill()
}

$('btn-detect').addEventListener('click', runDetect)
$('screen-override').addEventListener('change', runDetect)

$('btn-scan').addEventListener('click', async () => {
  $('btn-scan').disabled = true
  setMsg('screen-msg', '화면 구조를 수집하는 중…')
  const r = await neis('scan', null, 20000)
  $('btn-scan').disabled = false
  if (r.error) return setErr('screen-msg', r.error)
  const json = JSON.stringify(r, null, 1)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // 파일 이름은 영문만 씁니다 (한글 이름은 일부 크롬에서 "download"로 바뀜)
  a.download = `sgb-neis-scan-${SCREEN_SLUG[r.screen] || 'unknown'}-${fileStamp()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  setMsg('screen-msg', `내려받았습니다 (${Math.round(json.length / 1024)} KB). 학생 이름과 입력 내용은 들어 있지 않습니다. 이 파일을 개발자에게 보내 주세요.`)
})

$('btn-permit').addEventListener('click', async () => {
  try {
    const origin = new URL(tab.url).origin
    const ok = await chrome.permissions.request({ origins: [origin + '/*'] })
    if (ok) {
      tabKind = 'gokr-ok'
      renderScreen()
      runDetect()
    }
  } catch (e) {
    setErr('screen-msg', e && e.message)
  }
})

// ---------- 입력 카드 ----------
function payloadsFor(screen) {
  const ps = state.payloads || []
  const idx = ps.map((p, i) => [p, i])
  switch (screen) {
    case '교과평가':
    case '학기말종합의견':
      return idx.filter(([p]) => p.kind === 'subject')
    case '행동특성':
      return idx.filter(([p]) => p.kind === 'behavior')
    case '학생부자료기록':
      return idx.filter(([p]) => p.kind === 'creative' && p.subject !== '동아리')
    case '동아리활동관리':
      return idx.filter(([p]) => p.kind === 'creative' && p.subject === '동아리')
    case '진로활동관리':
      return idx.filter(([p]) => p.kind === 'creative' && p.subject === '진로')
    default:
      return []
  }
}

let lastPayloadChoice = null
const HINT = {
  교과평가: '성취기준 코드로 행을 찾아 단계(콤보)와 평가결과를 넣습니다. 끝나면 저장 → 학기말종합의견 화면으로 가세요.',
  학기말종합의견: '교과를 고른 뒤 번호순으로 학기말 종합의견 칸에 넣습니다.',
  행동특성: '번호순으로 행동특성 및 종합의견 칸에 넣습니다.',
  학생부자료기록: '영역 구분이 맞는 행(자율·자치활동 또는 진로활동)의 특기사항에 넣습니다. 진로는 "동아리특기사항가져오기" 다음에 하세요.',
  동아리활동관리:
    '부서를 고르고 조회한 뒤 번호순으로 특기사항을 넣습니다. 번호는 담임 반의 출석번호입니다. 여러 반이 섞인 명단이면 입력하지 않으니 반을 하나만 조회하세요.',
  진로활동관리: '번호순으로 특기사항을 넣습니다.',
}

function renderFill() {
  const screen = effectiveScreen()
  const sel = $('fill-payload')
  const prev = sel.value
  sel.textContent = ''
  const list = screen ? payloadsFor(screen) : []
  // 교과·창체는 고르게 합니다 (다른 과목/영역이 들어가 저장되는 것을 막기 위해)
  const mustChoose = ['교과평가', '학기말종합의견', '학생부자료기록'].includes(screen)
  if (mustChoose && list.length) {
    const o = el('option', null, screen === '학생부자료기록' ? '데이터를 고르세요' : '과목을 고르세요')
    o.value = ''
    sel.append(o)
  }
  for (const [p, i] of list) {
    const o = el('option', null, `${payloadTitle(p)} · ${p.rows.length}명`)
    o.value = String(i)
    sel.append(o)
  }
  if (list.some(([, i]) => String(i) === prev)) sel.value = prev
  else sel.value = mustChoose ? '' : sel.options[0] ? sel.options[0].value : ''
  $('area-row').hidden = screen !== '학생부자료기록'
  if (screen === '학생부자료기록' && sel.value !== lastPayloadChoice) {
    // 데이터를 새로 고르면 영역을 데이터의 영역(자율/진로)으로 맞춥니다. 기타는 직접 고르게 합니다
    const p = sel.value === '' ? null : state.payloads[Number(sel.value)]
    $('fill-area').value = p && (p.subject === '자율' || p.subject === '진로') ? p.subject : ''
  }
  lastPayloadChoice = sel.value
  let hint = screen ? HINT[screen] || '' : '먼저 나이스 화면을 인식하세요.'
  if (screen && !list.length) hint = '이 화면에 맞는 데이터가 없습니다. 웹앱에서 "나이스로 보내기"를 누른 뒤 "다시 가져오기"를 누르세요.'
  $('fill-hint').textContent = hint
  const chosen = sel.value !== '' && (screen !== '학생부자료기록' || $('fill-area').value !== '')
  const can = !running && !!screen && list.length > 0 && chosen && (tabKind === 'neis' || tabKind === 'gokr-ok') && !(detected && detected.error)
  $('btn-fill').disabled = !can
  $('btn-preview').disabled = !can
  $('btn-stop').disabled = !running
}

$('fill-payload').addEventListener('change', renderFill)
$('fill-area').addEventListener('change', renderFill)

function showProgress(p) {
  $('progress').hidden = false
  const total = Number(p.total) || 0
  const done = Number(p.done) || 0
  $('bar-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
  $('progress-text').textContent =
    p.phase === 'done' ? `${done} / ${total}행 처리` : `${done} / ${total}행${p.current != null ? ' · ' + p.current + '번' : ''}`
}

function showResult(r) {
  const log = $('log')
  log.textContent = ''
  if (!r || typeof r !== 'object') return
  const arr = (v) => (Array.isArray(v) ? v : [])
  const notes = arr(r.notes).map(String)
  if (r.error && !r.filled) {
    log.append(putErr(el('p', 'bad'), r.error))
    for (const n of notes) log.append(el('p', null, n))
    return
  }
  log.append(el('p', 'ok', `${r.filled}명 입력 · 칸 ${r.cells ?? 0}개 · ${r.strategy === 'cpr' ? 'cpr' : '화면(DOM)'} 방식`))
  log.append(el('p', null, r.saved ? `저장을 눌렀습니다${r.confirmed ? ' · 확인 ' + r.confirmed + '번' : ''}` : '저장은 누르지 않았습니다'))
  const missing = arr(r.missing)
  const ambiguous = arr(r.ambiguous)
  if (missing.length) log.append(el('p', 'bad', `못 찾은 번호: ${missing.join(', ')}`))
  if (ambiguous.length) log.append(el('p', 'bad', `여러 곳에 있어 건너뛴 번호: ${ambiguous.join(', ')}`))
  const unmatched = arr(r.unmatchedStandards).filter((u) => u && typeof u === 'object')
  if (unmatched.length) {
    const by = new Map()
    for (const u of unmatched) by.set(String(u.code), (by.get(String(u.code)) || []).concat(u.student))
    for (const [code, ss] of by) log.append(el('p', 'bad', `성취기준 ${code} 행 없음: ${ss.join(', ')}번`))
  }
  if (r.aborted) log.append(el('p', 'bad', '중지됨'))
  for (const n of notes) log.append(el('p', 'muted', n))
}

let preflightArmed = null // 사전 검사 오류가 있을 때 한 번 더 눌러야 시작 (삭제와 같은 방식)
async function startFill(save, btn) {
  const screen = effectiveScreen()
  if ($('fill-payload').value === '') return
  const p = state.payloads[Number($('fill-payload').value)]
  if (!screen || !p) return
  const c = preflight(p)
  if ((c.name || c.chars) && preflightArmed !== btn) {
    preflightArmed = btn
    setMsg('fill-msg', `사전 검사 오류가 있습니다 (이름 의심 ${c.name}, 허용 외 문자 ${c.chars}). 웹앱에서 고친 뒤 다시 보내는 것을 권합니다. 그래도 입력하려면 한 번 더 누르세요.`, true)
    btn.classList.add('armed')
    setTimeout(() => {
      if (preflightArmed === btn) preflightArmed = null
      btn.classList.remove('armed')
      setMsg('fill-msg', '')
    }, 4000)
    return
  }
  preflightArmed = null
  btn.classList.remove('armed')
  setMsg('fill-msg', '')
  const mode = document.querySelector('input[name=mode]:checked').value
  const job = {
    screen,
    area: screen === '학생부자료기록' ? $('fill-area').value : undefined,
    subject: p.kind === 'subject' ? p.subject : undefined,
    mode,
    save: !!save,
    delayMs: 400,
    rows: p.rows.map((r) => ({ student: r.student, text: r.text, standards: r.standards })),
  }
  running = true
  lastDone = null
  renderFill()
  $('log').textContent = ''
  showProgress({ done: 0, total: 0 })
  $('progress-text').textContent = '시작하는 중…'
  const r = await neis('fill', job, 11 * 60 * 1000)
  running = false
  renderFill()
  showResult(r && r.error && lastDone ? lastDone : r)
}

$('btn-fill').addEventListener('click', () => startFill($('fill-save').checked, $('btn-fill')))
$('btn-preview').addEventListener('click', () => startFill(false, $('btn-preview')))
$('btn-stop').addEventListener('click', async () => {
  await neis('stop', null, 5000)
  $('progress-text').textContent = '중지 요청함…'
})

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab || (tab && sender.tab.id !== tab.id)) return
  if (msg.type === 'progress') showProgress(msg)
  else if (msg.type === 'fill-done') {
    lastDone = msg.result
    if (monitoring) {
      monitoring = false
      running = false
      renderFill()
    }
    if (!running) showResult(msg.result)
  }
})

// 웹앱에서 데이터가 새로 들어오면 데이터 카드를 바로 고칩니다
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.payloads) return
  loadState().then(renderFill)
})

// ---------- 시작 ----------
function classifyTab(t) {
  try {
    const u = new URL(t.url || '')
    if (u.protocol !== 'https:') return 'none'
    if (u.hostname === 'neis.go.kr' || u.hostname.endsWith('.neis.go.kr')) return 'neis'
    if (u.hostname.endsWith('.go.kr')) return 'gokr'
  } catch {
    // 무시
  }
  return 'none'
}

async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version + ' · 서버와 통신하지 않습니다'
  await loadState()
  // 테스트용: popup.html?tabId=N 으로 대상 탭을 지정
  const forced = Number(qs.get('tabId'))
  try {
    tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  } catch {
    tab = null
  }
  tabKind = tab ? classifyTab(tab) : 'none'
  if (tabKind === 'gokr') {
    try {
      if (await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] })) tabKind = 'gokr-ok'
    } catch {
      // 무시
    }
  }
  renderScreen()
  renderFill()
  if (state.lastRun && tab && state.lastRun.tabId === tab.id && Date.now() - state.lastRun.at < 30 * 60 * 1000) showResult(state.lastRun.result)
  if (tabKind === 'neis' || tabKind === 'gokr-ok') await runDetect()
}

init()
