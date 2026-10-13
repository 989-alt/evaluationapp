// 나이스 화면에서 동작하는 엔진 (MAIN world). window.__sgbNeis = { detect, scan, fill, inspect, stop }
// - 실제 나이스 화면(KNOWN_SCREENS: 앱 id·데이터 열 이름을 실제 구조 수집으로 확인)은 지금 보이는 앱의 데이터셋에 바로 씁니다.
// - 그 밖에는 cpr(eXBuilder6) 그리드 API로, 없거나 열을 못 찾으면 화면(DOM)에서 직접 입력합니다.
// - 성명(이름) 열은 읽지도 내보내지도 않습니다. 네트워크 요청과 eval은 쓰지 않습니다.
// - content script(neis-content.js)와 window.postMessage({__sgb:nonce, cmd, args})로 통신합니다.
;(() => {
  'use strict'
  if (window.__sgbNeis && window.__sgbNeis.version) return

  const VERSION = '0.3.0'
  const SCREENS = ['교과평가', '학기말종합의견', '행동특성', '학생부자료기록', '자율활동관리', '동아리활동관리', '진로활동관리']
  const SINGLE_ROW = ['학기말종합의견', '행동특성', '자율활동관리', '동아리활동관리', '진로활동관리']
  /**
   * 창체 데이터(웹앱 영역 이름) → 넣을 수 있는 화면. 학생부자료기록은 세 화면의 글이 합쳐지는 화면이라 넣지 않습니다.
   * 동아리 문장은 자율활동관리 칸의 동아리 구간("(부서명(학년-반)) …")에 이어쓸 수도 있습니다
   */
  const CREATIVE_SCREENS = { 자율: ['자율활동관리'], 진로: ['진로활동관리'], 동아리: ['동아리활동관리', '자율활동관리'] }
  /** 자동 입력 대상이 아닌 화면 (인식·확인만) */
  const NOT_TARGET = { 학생부자료기록: '학생부자료기록은 자율활동관리·동아리활동관리·진로활동관리에서 쓴 내용이 합쳐지는 화면이라 자동 입력 대상이 아닙니다' }
  const SCAN_MAX = 300 * 1024

  // ---------- 공통 ----------
  const norm = (s) => String(s ?? '').replace(/\s+/g, '')
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const isFn = (o, k) => {
    try {
      return !!o && typeof o[k] === 'function'
    } catch {
      return false
    }
  }
  const call = (o, k, ...a) => {
    try {
      return isFn(o, k) ? o[k](...a) : undefined
    } catch {
      return undefined
    }
  }
  const prop = (o, k) => {
    try {
      return o == null ? undefined : o[k]
    } catch {
      return undefined
    }
  }
  const asStr = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
  const toArray = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v
    try {
      return Array.from(v)
    } catch {
      return []
    }
  }

  // 개인정보 열 (실제 나이스 데이터셋 열 이름). 읽지도, 표본으로 남기지도, 내보내지도 않습니다.
  // stdntInfo는 학기말종합의견 번호용으로 "숫자만 있는 값"일 때만 씁니다(원문은 남기지 않음)
  const PERSONAL = new Set(['stuFlnm', 'stdntNm', 'stuBrdt', 'stdntInfo', 'sameFlnm', 'stuInvlNo', 'userId', 'stuHopMteCn', 'stuHopMteCnOri', 'sxdsScCd', 'clubActDptNm'])
  const DIGIT_COLS = ['stdntInfo', 'stdntCn']
  const DIGITS_ONLY = /^[\d\s/-]+$/

  const NAME_HEADERS = ['성명', '이름', '학생명', '학생이름', '학생성명', '성명(이름)']
  const isNameHeader = (h) => {
    const n = norm(h)
    return NAME_HEADERS.includes(n) || n.startsWith('성명')
  }

  /** 머리글 → 역할. 성명 열은 'name'으로만 표시하고 절대 읽지 않습니다 */
  function roleOf(header) {
    const h = norm(header)
    if (!h) return null
    if (isNameHeader(h)) return 'name'
    if (/^(학생)?(반\/)?번호$/.test(h) || h === '반번호' || h === '출석번호') return 'number'
    if (h.includes('성취기준')) return 'standard'
    if (h === '단계' || h === '성취수준' || h === '평가단계' || h === '성취단계') return 'level'
    if (h.includes('평가결과')) return 'result'
    if (h.includes('학기말종합의견')) return 'semester'
    if (h.includes('행동특성')) return 'behavior'
    if (h.includes('영역구분')) return 'area'
    if (h.includes('특기사항') && !h.includes('가져오기')) return 'note'
    if (h === '종합의견') return 'opinion'
    if (h === '반') return 'class'
    if (h === '학년') return 'grade'
    if (h === '영역') return 'area2'
    return null
  }

  function rolesOf(headers) {
    const roles = {}
    headers.forEach((h, i) => {
      const r = roleOf(h)
      if (r && roles[r] === undefined) roles[r] = i
    })
    if (roles.area === undefined && roles.area2 !== undefined) roles.area = roles.area2
    return roles
  }

  function visible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }

  const normCode = (s) => String(s ?? '').replace(/[[\]()\s]/g, '')
  /** 성취기준 칸 글자에 코드가 들어 있는지. "6국05-01"이 "6국05-011"에 걸리지 않게 뒤 글자를 확인합니다 */
  function hasCode(cellText, code) {
    const c = normCode(code)
    if (!c) return false
    const t = normCode(cellText)
    let i = t.indexOf(c)
    while (i >= 0) {
      const next = t.charAt(i + c.length)
      if (!/[0-9]/.test(next)) return true
      i = t.indexOf(c, i + 1)
    }
    return false
  }

  /**
   * 학생부자료기록 영역 구분 일치 ("자율"은 "자율동아리"와 구분).
   * 실제 나이스는 자율·자치활동과 동아리활동이 한 행("자율·자치활동 동아리활동", actScNm은 오타 "자울활동 동아리활동")입니다
   */
  function areaMatches(text, area) {
    const t = norm(text)
    if (!t) return false
    if (area === '자율') return (t.includes('자치') || t.includes('자율') || t.includes('자울')) && !t.includes('자율동아리')
    if (area === '진로') return t.includes('진로')
    if (area === '동아리') return t.includes('동아리') && !t.includes('자율동아리')
    return t.includes(norm(area))
  }

  const CODE_RE = /\d+[가-힣]+\d+-\d+/
  /** 성취기준 글자 비교용: 대괄호 코드([6국05-01]) · 띄어쓰기 · 문장부호를 뺌 */
  const normStdText = (s) => String(s ?? '').replace(/\[[^\]]*\]/g, '').replace(/[\s.,·:;'"“”‘’()]/g, '')
  /** 성취기준 본문이 같은지 (한쪽이 다른 쪽을 포함해도 같음, 너무 짧으면 비교하지 않음) */
  function sameStdText(a, b) {
    const x = normStdText(a)
    const y = normStdText(b)
    if (x.length < 8 || y.length < 8) return false
    return x === y || x.includes(y) || y.includes(x)
  }
  /** 영역 이름이 같은지 ("문학" ↔ "문학", "듣기·말하기" ↔ "듣기말하기") */
  function sameArea(a, b) {
    const x = normStdText(a)
    const y = normStdText(b)
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x))
  }

  /** 성취기준 칸의 코드 (예: "6국05-01"). 코드가 없으면 앞 40자 */
  function rowStdKey(text) {
    const t = normCode(text)
    const m = t.match(/\d+[가-힣]+\d+-\d+/)
    return m ? m[0] : t.slice(0, 40)
  }

  const lastInt = (text) => {
    const m = String(text ?? '').match(/\d+/g)
    return m ? Number(m[m.length - 1]) : null
  }

  // ---------- cpr (eXBuilder6) ----------
  function cprPlatform() {
    try {
      return window.cpr?.core?.Platform?.INSTANCE ?? null
    } catch {
      return null
    }
  }
  function cprVersion() {
    try {
      const c = window.cpr
      if (!c) return null
      const P = cprPlatform()
      const v = c.VERSION ?? c.version ?? c.core?.VERSION ?? c.core?.Platform?.VERSION ?? prop(P, 'version') ?? call(P, 'getVersion')
      return typeof v === 'string' || typeof v === 'number' ? String(v) : null
    } catch {
      return null
    }
  }

  const embedParent = new WeakMap() // 끼워 넣은 앱 → 바깥 앱
  function cprApps() {
    const P = cprPlatform()
    if (!P) return []
    const seen = new Set()
    const out = []
    const add = (a) => {
      if (a && typeof a === 'object' && !seen.has(a)) {
        seen.add(a)
        out.push(a)
      }
    }
    for (const fn of ['getAllRunningAppInstances', 'getAppInstances', 'getRunningAppInstances']) toArray(call(P, fn)).forEach(add)
    // 화면 안에 끼워 넣은 앱(embedded app / UDC)
    for (let i = 0; i < out.length && i < 200; i++) {
      for (const c of appControls(out[i])) {
        const inner = call(c, 'getEmbeddedAppInstance') ?? prop(c, 'appInstance') ?? call(c, 'getAppInstance')
        if (inner && inner !== out[i] && isFn(inner, 'getContainer')) {
          if (!embedParent.has(inner)) embedParent.set(inner, out[i])
          add(inner)
        }
      }
    }
    return out
  }

  const appId = (app) => asStr(prop(app, 'id')) || asStr(prop(prop(app, 'app'), 'id')) || asStr(call(app, 'getId'))
  const appTitle = (app) => asStr(prop(app, 'title')) || asStr(prop(prop(app, 'app'), 'title')) || asStr(call(app, 'getTitle'))

  function appControls(app) {
    const cont = call(app, 'getContainer')
    let list = toArray(call(cont, 'getAllRecursiveChildren'))
    if (!list.length) list = toArray(call(app, 'getAllRecursiveChildren'))
    if (!list.length) list = toArray(call(cont, 'getChildren'))
    return list.filter((c) => c && typeof c === 'object')
  }

  const ctrlType = (c) => asStr(prop(c, 'type')) || asStr(call(c, 'getType'))
  const ctrlId = (c) => asStr(prop(c, 'id')) || asStr(call(c, 'getId')) || asStr(prop(c, 'uuid'))
  const isGridCtrl = (c) => ctrlType(c) === 'grid' || (isFn(c, 'getCellValue') && isFn(c, 'getRowCount'))

  function cprDataSet(grid) {
    return prop(grid, 'dataSet') ?? call(grid, 'getDataSet') ?? prop(grid, 'dataset') ?? null
  }

  function cellCount(part) {
    // eXBuilder6 1.0.6135: cellCount는 메서드가 아니라 속성 (1차 구조 수집에서 getCellCount 실패)
    for (const k of ['cellCount', 'columnCount']) {
      const n = prop(part, k)
      if (typeof n === 'number') return n
    }
    for (const k of ['getCellCount', 'getColumnCount', 'getCellsCount']) {
      const n = call(part, k)
      if (typeof n === 'number') return n
    }
    const cells = prop(part, 'cells') ?? call(part, 'getCells')
    return Array.isArray(cells) ? cells.length : 0
  }
  function cellAt(part, i) {
    return call(part, 'getColumn', i) ?? call(part, 'getCell', i) ?? toArray(prop(part, 'cells') ?? call(part, 'getCells'))[i] ?? null
  }

  /** 그리드 머리글 [{label, column, colIndex}] — API가 없으면 빈 배열 */
  function cprHeaderInfo(grid) {
    const detailCols = new Map() // colIndex -> {column, control}
    const detail = prop(grid, 'detail')
    const dn = cellCount(detail)
    for (let i = 0; i < dn && i < 200; i++) {
      const c = cellAt(detail, i)
      if (!c) continue
      const column = asStr(prop(c, 'columnName')) || asStr(call(c, 'getColumnName')) || asStr(prop(c, 'bindColumn'))
      const colIndex = prop(c, 'colIndex') ?? call(c, 'getColIndex') ?? i
      const control = prop(c, 'control') ?? call(c, 'getControl') ?? null
      detailCols.set(colIndex, { column, control })
    }
    const header = prop(grid, 'header')
    const hn = cellCount(header)
    const out = []
    for (let i = 0; i < hn && i < 200; i++) {
      const c = cellAt(header, i)
      if (!c) continue
      const label = oneLine(asStr(prop(c, 'text')) || asStr(call(c, 'getText')) || asStr(prop(c, 'value')) || asStr(call(c, 'getValue')))
      const colIndex = prop(c, 'colIndex') ?? call(c, 'getColIndex') ?? i
      const colSpan = prop(c, 'colSpan') ?? 1
      let column = asStr(prop(c, 'targetColumnName')) || asStr(call(c, 'getTargetColumnName')) || asStr(prop(c, 'sortColumnName'))
      const d = detailCols.get(colIndex)
      if (!column && d && colSpan === 1) column = d.column
      out.push({ label, column, colIndex, control: d ? d.control : null })
    }
    return out
  }

  function cprColumnNames(grid) {
    const ds = cprDataSet(grid)
    return toArray(call(ds, 'getColumnNames') ?? call(grid, 'getColumnNames')).map(asStr).filter(Boolean)
  }

  function makeCprGrid(app, grid) {
    const info = cprHeaderInfo(grid)
    const ds = cprDataSet(grid)
    const headers = info.map((h) => h.label)
    const roles = {} // role -> {column, control}
    info.forEach((h) => {
      const r = roleOf(h.label)
      if (r && !roles[r] && h.column) roles[r] = { column: h.column, control: h.control }
    })
    if (!roles.area && roles.area2) roles.area = roles.area2
    const rowCount = () => {
      const n = call(grid, 'getRowCount') ?? call(ds, 'getRowCount')
      return typeof n === 'number' ? n : 0
    }
    const raw = (r, role) => {
      if (role === 'name' || !roles[role]) return ''
      const col = roles[role].column
      // 개인정보 열은 읽지 않습니다. stdntInfo/stdntCn은 숫자만 있는 값일 때만 씁니다
      if (PERSONAL.has(col) && !DIGIT_COLS.includes(col)) return ''
      const v = call(grid, 'getCellValue', r, col) ?? call(ds, 'getValue', r, col)
      const s = v == null ? '' : String(v)
      if (DIGIT_COLS.includes(col)) return DIGITS_ONLY.test(s.trim()) ? s : ''
      return s
    }
    const comboItems = (role) => {
      const ctl = roles[role]?.control
      if (!ctl) return []
      let items = toArray(call(ctl, 'getItems'))
      if (!items.length) {
        const n = call(ctl, 'getItemCount')
        if (typeof n === 'number') for (let i = 0; i < n && i < 50; i++) items.push(call(ctl, 'getItem', i))
      }
      return items
        .filter(Boolean)
        .map((it) => ({ label: asStr(prop(it, 'label')) || asStr(call(it, 'getLabel')), value: asStr(prop(it, 'value')) || asStr(call(it, 'getValue')) }))
    }
    /** 단계는 콤보 항목에 있는 값만 (없으면 null: 글자를 그대로 넣어 짐작하지 않음) */
    const valueFor = (role, value) => {
      if (role !== 'level') return { value, alt: null }
      const items = comboItems(role)
      const hit = items.find((it) => norm(it.label) === norm(value)) || items.find((it) => norm(it.value) === norm(value))
      return hit && hit.value !== '' ? { value: hit.value, alt: hit.label } : null
    }
    const colNames = cprColumnNames(grid)
    const dsRead = (r, col) => {
      if (!colNames.includes(col) || PERSONAL.has(col)) return ''
      const v = isFn(ds, 'getValue') ? call(ds, 'getValue', r, col) : call(grid, 'getCellValue', r, col)
      return v == null ? '' : String(v)
    }
    return {
      source: 'cpr',
      appId: appId(app),
      id: ctrlId(grid),
      headers,
      headerColumns: info.map((h) => h.column || null),
      columns: colNames,
      roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.column])),
      has: (role) => !!roles[role],
      /** 단계 글자 → 콤보 코드 확인 (못 찾은 글자 목록) */
      prepareLevels(tasks) {
        const missing = new Set()
        for (const t of tasks) for (const c of t.cells) if (c.role === 'level' && !valueFor('level', c.value)) missing.add(oneLine(c.value))
        return [...missing]
      },
      /** 마감 열(ddlnYn/msDdlnYn)이 데이터셋에 있으면 확인 */
      closedRow: (r) => ['ddlnYn', 'msDdlnYn'].some((c) => norm(dsRead(r, c)).toUpperCase() === 'Y'),
      /** 과목 열(sbjtCdNm/sbjtNm)이 데이터셋에 있으면 행마다 같은 과목 하나 */
      subjectLabel() {
        const col = ['sbjtCdNm', 'sbjtNm'].find((c) => colNames.includes(c))
        if (!col) return null
        const set = new Set()
        const n = rowCount()
        for (let r = 0; r < n && r < 2000; r++) {
          const v = stripParen(dsRead(r, col))
          if (v) set.add(v)
          if (set.size > 1) return null
        }
        return set.size === 1 ? [...set][0] : null
      },
      rowCount,
      readNumber: (r) => lastInt(raw(r, 'number')),
      readText: (r, role) => raw(r, role),
      isEmpty: (r, role) => norm(raw(r, role)) === '',
      async write(r, role, value) {
        if (!roles[role] || role === 'name' || role === 'number' || PERSONAL.has(roles[role].column)) return false
        const col = roles[role].column
        const vf = valueFor(role, value)
        if (!vf) return false
        const v = vf.value
        if (isFn(grid, 'setCellValue')) call(grid, 'setCellValue', r, col, v)
        else if (isFn(ds, 'setValue')) call(ds, 'setValue', r, col, v)
        else return false
        return true
      },
      verify(r, role, value) {
        const got = norm(raw(r, role))
        const vf = valueFor(role, value)
        if (!vf) return false
        return got === norm(vf.value) || (vf.alt != null && got === norm(vf.alt)) || (role !== 'level' && got === norm(value))
      },
      finish() {
        call(grid, 'redraw')
      },
      editableRows() {
        const out = []
        const n = Math.min(3, rowCount())
        for (let r = 0; r < n; r++)
          out.push(
            info.map((h) => {
              const ctl = h.control
              if (!ctl) return false
              const ro = prop(ctl, 'readOnly') ?? call(ctl, 'isReadOnly')
              const en = prop(ctl, 'enabled') ?? call(ctl, 'isEnabled')
              return ro !== true && en !== false
            }),
          )
        return out
      },
    }
  }

  function cprGrids() {
    const out = []
    const apps = cprApps()
    for (const app of apps) {
      // 알려진 화면의 앱은 보이는 앱을 고른 뒤(resolveActive) 데이터셋 방식으로만 씁니다
      if (knownSpecOf(app)) continue
      for (const c of appControls(app)) {
        if (!isGridCtrl(c)) continue
        // 다른 MDI 탭에 숨어 있는 앱의 표는 쓰지 않습니다. 앱이 여럿이면 보이는 것이 확인된 표만
        const v = ctrlVisibility(c)
        if (v.visible === false || (apps.length > 1 && v.visible !== true)) continue
        try {
          out.push(makeCprGrid(app, c))
        } catch {
          // 이 그리드는 건너뜀
        }
      }
    }
    return out
  }

  // ---------- DOM ----------
  const EDITOR_SEL =
    'textarea, select, input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=image]):not([type=file]), [contenteditable="true"], [contenteditable=""]'
  const COMBO_SEL = '.cl-combobox, [role=combobox]'

  const editorIn = (cell) => (cell.matches?.(EDITOR_SEL) ? cell : cell.querySelector(EDITOR_SEL))
  const comboIn = (cell) => (cell.matches?.(COMBO_SEL) ? cell : cell.querySelector(COMBO_SEL))

  function selectedText(sel) {
    const o = sel.options[sel.selectedIndex]
    return o ? (o.value === '' ? '' : o.textContent) : ''
  }
  function editorValue(ed) {
    if (ed.tagName === 'SELECT') return selectedText(ed)
    if (ed.isContentEditable) return ed.textContent
    return ed.value
  }
  function cellValue(cell) {
    const ed = editorIn(cell)
    if (ed) return editorValue(ed)
    return cell.textContent
  }
  /** 셀 안 표시 글자 (편집 칸 제외) — 번호/성취기준/영역 칸에만 씁니다 */
  const cellText = (cell) => (cell ? cell.textContent : '')

  function fire(el, types) {
    for (const t of types) {
      const opts = { bubbles: true, cancelable: true, view: window }
      let ev
      if (t.startsWith('pointer') && typeof PointerEvent === 'function') ev = new PointerEvent(t, opts)
      else if (t.startsWith('mouse') || t === 'click' || t === 'dblclick') ev = new MouseEvent(t, opts)
      else if (t === 'focus' || t === 'blur') ev = new FocusEvent(t, { bubbles: false })
      else if (t === 'focusin' || t === 'focusout') ev = new FocusEvent(t, { bubbles: true })
      else ev = new Event(t, { bubbles: true })
      el.dispatchEvent(ev)
    }
  }
  const clickEl = (el) => fire(el, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    try {
      el.focus({ preventScroll: true })
    } catch {
      // 무시
    }
    fire(el, ['focusin'])
    if (desc && desc.set) desc.set.call(el, value)
    else el.value = value
    fire(el, ['input', 'change'])
    fire(el, ['focusout'])
    try {
      el.blur()
    } catch {
      // 무시
    }
  }

  function setSelect(sel, value) {
    const opts = Array.from(sel.options)
    const hit = opts.find((o) => norm(o.textContent) === norm(value)) || opts.find((o) => norm(o.value) === norm(value))
    if (!hit) return false
    sel.value = hit.value
    hit.selected = true
    fire(sel, ['input', 'change'])
    return true
  }

  /** div 콤보박스: 열고 글자가 같은 항목을 누릅니다 */
  async function pickCombo(combo, value) {
    clickEl(combo)
    const btn = combo.querySelector('[class*="button"], [class*="arrow"], [class*="trigger"]')
    if (btn) clickEl(btn)
    await sleep(150)
    const cands = Array.from(document.querySelectorAll('[role=option], [role=listbox] *, [class*="combobox-list"] *, [class*="listbox"] *, [class*="list-item"], li'))
      .filter((el) => !combo.contains(el) && visible(el) && norm(el.textContent) === norm(value))
      .filter((el) => !Array.from(el.children).some((c) => norm(c.textContent) === norm(value)))
    const hit = cands[cands.length - 1]
    if (!hit) {
      // 목록 닫기 (isTrusted가 아니므로 중지 감지에 걸리지 않음)
      ;(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return false
    }
    clickEl(hit)
    await sleep(80)
    return true
  }

  async function writeCell(cell, role, value) {
    if (role === 'level') {
      const sel = cell.querySelector('select')
      if (sel) return setSelect(sel, value)
      const combo = comboIn(cell)
      if (combo) {
        if (await pickCombo(combo, value)) return true
        const ed = editorIn(combo)
        if (ed && !ed.readOnly) {
          setNativeValue(ed, value)
          return true
        }
        return false
      }
    }
    let ed = editorIn(cell)
    if (!ed) {
      // 클릭해야 편집기가 나타나는 표
      fire(cell, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'])
      await sleep(80)
      ed = editorIn(cell)
      const a = document.activeElement
      if (!ed && a && a.matches && a.matches('textarea, input') && !a.readOnly) ed = a
    }
    if (!ed) return false
    if (ed.tagName === 'SELECT') return setSelect(ed, value)
    if (ed.isContentEditable) {
      ed.textContent = value
      fire(ed, ['input', 'change'])
      return true
    }
    if (ed.readOnly || ed.disabled) return false
    setNativeValue(ed, value)
    return true
  }

  // --- <table> ---
  function tableMatrix(trs) {
    const m = []
    trs.forEach((tr, r) => {
      m[r] = m[r] || []
      let c = 0
      for (const td of Array.from(tr.cells)) {
        while (m[r][c]) c++
        const rs = Math.max(1, td.rowSpan || 1)
        const cs = Math.max(1, td.colSpan || 1)
        for (let i = 0; i < rs && r + i < trs.length; i++)
          for (let j = 0; j < cs; j++) {
            m[r + i] = m[r + i] || []
            m[r + i][c + j] = { el: td, rowOrigin: i === 0 }
          }
        c += cs
      }
    })
    return m
  }

  function splitTable(table) {
    const all = Array.from(table.rows)
    let head = table.tHead ? Array.from(table.tHead.rows) : []
    let body = all.filter((tr) => !head.includes(tr) && !(tr.parentElement && tr.parentElement.tagName === 'TFOOT'))
    if (!head.length) {
      const lead = []
      for (const tr of body) {
        const cells = Array.from(tr.cells)
        if (cells.length && cells.every((c) => c.tagName === 'TH')) lead.push(tr)
        else break
      }
      head = lead
      body = body.slice(lead.length)
    }
    body = body.filter((tr) => Array.from(tr.cells).some((c) => c.tagName === 'TD'))
    return { head, body }
  }

  function headerLabels(headRows) {
    if (!headRows.length) return []
    const m = tableMatrix(headRows)
    const width = Math.max(...m.map((r) => r.length))
    const out = []
    for (let c = 0; c < width; c++) {
      let label = ''
      for (let r = m.length - 1; r >= 0; r--) {
        const cell = m[r][c]
        if (cell && oneLine(cell.el.textContent)) {
          label = oneLine(cell.el.textContent)
          break
        }
      }
      out.push(label)
    }
    return out
  }

  function makeDomGrid({ source, id, root, headers, headerRowEl, rows }) {
    // rows: [{el, cells: [{el, rowOrigin}] (column index aligned)}]
    const roles = rolesOf(headers)
    const cell = (r, role) => {
      const i = roles[role]
      if (i === undefined || role === 'name') return null
      return rows[r]?.cells[i]?.el ?? null
    }
    return {
      source,
      id,
      appId: null,
      root,
      headerRowEl,
      headers,
      headerColumns: headers.map(() => null),
      columns: [],
      roles,
      has: (role) => roles[role] !== undefined,
      rowCount: () => rows.length,
      readNumber(r) {
        const c = rows[r]?.cells[roles.number]
        if (!c) return null
        return lastInt(cellText(c.el))
      },
      readText: (r, role) => {
        const c = cell(r, role)
        return c ? cellText(c) : ''
      },
      /** 편집 칸의 지금 값 (이어쓰기에서 기존 글을 읽을 때) */
      readValue: (r, role) => {
        const c = cell(r, role)
        return c ? cellValue(c) : ''
      },
      isEmpty: (r, role) => {
        const c = cell(r, role)
        return !c || norm(cellValue(c)) === ''
      },
      async write(r, role, value) {
        const c = cell(r, role)
        if (!c) return false
        try {
          c.scrollIntoView({ block: 'nearest' })
        } catch {
          // 무시
        }
        return writeCell(c, role, value)
      },
      verify(r, role, value) {
        const c = cell(r, role)
        return !!c && norm(cellValue(c)) === norm(value)
      },
      finish() {},
      editableRows() {
        return rows.slice(0, 3).map((row) =>
          headers.map((h, i) => {
            const c = row.cells[i]
            if (!c) return false
            return !!(editorIn(c.el) || comboIn(c.el))
          }),
        )
      },
    }
  }

  function tableGrids() {
    const out = []
    const tables = Array.from(document.querySelectorAll('table')).filter(visible)
    const used = new Set()
    tables.forEach((table, ti) => {
      if (used.has(table)) return
      const { head, body } = splitTable(table)
      const headers = headerLabels(head)
      if (headers.length < 2) return
      let bodyRows = body
      // 머리글만 있는 표 + 바로 뒤의 본문 표(스크롤 그리드에서 흔한 구조)
      if (!bodyRows.length) {
        for (const next of tables.slice(ti + 1, ti + 4)) {
          if (used.has(next)) continue
          const nb = splitTable(next)
          if (nb.head.length) continue
          const m = tableMatrix(nb.body)
          if (m.length && Math.max(...m.map((r) => r.length)) === headers.length) {
            bodyRows = nb.body
            used.add(next)
            break
          }
        }
      }
      if (!bodyRows.length) return
      const m = tableMatrix(bodyRows)
      const rows = bodyRows.map((tr, r) => ({ el: tr, cells: (m[r] || []).slice(0, headers.length) }))
      used.add(table)
      out.push(makeDomGrid({ source: 'dom-table', id: table.id || 'table#' + ti, root: table, headers, headerRowEl: head[head.length - 1], rows }))
    })
    return out
  }

  // --- ARIA / div 그리드 (eXBuilder6 .cl-grid 등) ---
  const HEAD_CELL_SEL = '[role=columnheader], [class*="header"] [class*="cell"], th'
  const ROW_SEL = '[role=row], [class*="grid-row"], [class*="-row"]'
  const BODY_CELL_SEL = '[role=gridcell], [role=cell], [class*="cell"], td'

  const leaves = (els, sel) => els.filter((el) => !el.querySelector(sel))

  function alignCells(headerEls, cellEls) {
    const hr = headerEls.map((h) => h.getBoundingClientRect())
    const out = new Array(headerEls.length)
    const byIndex = cellEls.every((c) => c.hasAttribute('aria-colindex')) && headerEls.every((h) => h.hasAttribute('aria-colindex'))
    if (byIndex) {
      const hi = headerEls.map((h) => h.getAttribute('aria-colindex'))
      for (const c of cellEls) {
        const i = hi.indexOf(c.getAttribute('aria-colindex'))
        if (i >= 0 && !out[i]) out[i] = { el: c, rowOrigin: true }
      }
      return out
    }
    const geometric = hr.every((r) => r.width > 0)
    for (let k = 0; k < cellEls.length; k++) {
      const c = cellEls[k]
      let idx = -1
      if (geometric) {
        const r = c.getBoundingClientRect()
        const cx = r.left + r.width / 2
        let best = Infinity
        hr.forEach((h, i) => {
          if (cx >= h.left - 1 && cx <= h.right + 1 && h.width < best) {
            best = h.width
            idx = i
          }
        })
      } else if (k < headerEls.length) idx = k
      if (idx >= 0 && !out[idx]) out[idx] = { el: c, rowOrigin: true }
    }
    return out
  }

  function divGrids() {
    const out = []
    const roots = Array.from(document.querySelectorAll('[role=grid], [role=treegrid], [role=table]:not(table), .cl-grid')).filter(
      (el) => el.tagName !== 'TABLE' && visible(el),
    )
    const outer = roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)))
    outer.forEach((root, gi) => {
      if (root.querySelector('table') && !root.querySelector('[role=row], [class*="grid-row"]')) return // 표 방식에서 처리
      const headEls = leaves(Array.from(root.querySelectorAll(HEAD_CELL_SEL)), HEAD_CELL_SEL).filter(visible)
      if (headEls.length < 2) return
      const headers = headEls.map((h) => oneLine(h.textContent))
      const hr = headEls[0].closest('[role=row], [class*="row"]')
      const headerRowEl = hr && root.contains(hr) ? hr : headEls[0].parentElement
      const rowEls = Array.from(root.querySelectorAll(ROW_SEL)).filter(
        (el) => !headEls.some((h) => el.contains(h)) && !el.querySelector(ROW_SEL) && visible(el),
      )
      const rows = []
      for (const rowEl of rowEls) {
        const cells = leaves(Array.from(rowEl.querySelectorAll(BODY_CELL_SEL)), BODY_CELL_SEL)
        const top = cells.map((c) => c.closest('[role=gridcell], [role=cell], [class*="cell"], td') || c)
        const uniq = Array.from(new Set(top))
        if (uniq.length < 2) continue
        rows.push({ el: rowEl, cells: alignCells(headEls, uniq) })
      }
      if (!rows.length) return
      out.push(makeDomGrid({ source: 'dom-grid', id: root.id || 'grid#' + gi, root, headers, headerRowEl, rows }))
    })
    return out
  }

  function domGrids() {
    let list = []
    try {
      list = list.concat(divGrids())
    } catch {
      // 무시
    }
    try {
      list = list.concat(tableGrids())
    } catch {
      // 무시
    }
    return list
  }

  function allGrids() {
    let cpr = []
    try {
      cpr = cprGrids()
    } catch {
      cpr = []
    }
    return { cpr, dom: domGrids() }
  }

  // ---------- 실제 나이스 화면 (2차: 실제 구조 수집 7개로 확인한 앱 id · 데이터 열) ----------
  // 나이스는 연 화면을 MDI 탭으로 모두 살려 두므로(앱 여러 개가 동시에 있음) 반드시 "지금 보이는 앱"을 고릅니다.
  // 표(DOM)는 일부 행만 그리고 편집기는 눌러야 나타나므로, 알려진 화면은 데이터셋에 바로 씁니다.
  const KNOWN_SCREENS = [
    {
      app: 'edu/sw/els/scr/es/els_scres00_m02',
      screen: '교과평가',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { number: 'clsNo', subject: 'sbjtNm', area: 'relmNm', stdCode: 'sccesCtrCd', standard: 'sccesCtrCn', level: 'evlCtrCd', result: 'evlCtrCn' },
      controls: { level: 'cmbLvl', result: 'txa1' },
    },
    {
      // 교과평가 바깥 탭 앱 (빈 grdMain + cmbLvl/txa1). 보이고 행이 있을 때만 씁니다
      app: 'edu/sw/els/scr/es/els_scres00_m00',
      screen: '교과평가',
      grid: 'grdMain',
      save: 'btnSave',
      parent: true,
      cols: { number: 'clsNo', subject: 'sbjtNm', area: 'relmNm', stdCode: 'sccesCtrCd', standard: 'sccesCtrCn', level: 'evlCtrCd', result: 'evlCtrCn' },
      controls: { level: 'cmbLvl', result: 'txa1' },
    },
    {
      // 번호 열(clsNo)이 없음: stdntCn/stdntInfo 중 숫자만 있는 열의 마지막 숫자 ("1/3" → 3)
      app: 'edu/sw/els/scr/es/els_scres10_m00',
      screen: '학기말종합의견',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { subject: 'sbjtCdNm', semester: 'gnrlzOpiCn' },
      numberDigits: ['stdntCn', 'stdntInfo'],
      controls: { semester: 'txaGnrlzOpiCn' },
    },
    {
      app: 'edu/sw/els/sdl/bg/els_sdlbg00_m00',
      screen: '행동특성',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { number: 'clsNo', behavior: 'gnrlzOpiCn' },
      closed: ['ddlnYn', 'msDdlnYn'],
      controls: { behavior: 'txaGnrlz' },
    },
    {
      app: 'edu/sw/els/sdl/ce/els_sdlce06_m00',
      screen: '학생부자료기록',
      grid: 'grdMain',
      save: 'btnSave',
      // 영역은 actScNm2("자율·자치활동 동아리활동")를 먼저 보고, 없으면 actScNm(실제 값에 오타 "자울활동")
      cols: { number: 'clsNo', area: 'actScNm', note: 'speclActSpablMteCn' },
      areaCols: ['actScNm2', 'actScNm'],
      controls: { note: 'txaSpeclActSpablMteCn' },
    },
    {
      // 자율활동관리 (앱 제목 "학생부자료기록", 탭 제목 "자율·자치활동"). 3차 구조 수집으로 확인. 모양은 진로활동관리와 같음
      app: 'edu/sw/els/sdl/ce/els_sdlce00_m00',
      screen: '자율활동관리',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { number: 'clsNo', note: 'speclActSpablMteCn' },
      controls: { note: 'txaSpeclActSpablMteCn' },
    },
    {
      app: 'edu/sw/els/sdl/ce/els_sdlce01_m06',
      screen: '동아리활동관리',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { number: 'clsNo', grade: 'grd', class: 'clsNm', note: 'speclActSpablMteCn' },
      controls: { note: 'txaSpeclActSpablMteCn' },
    },
    {
      app: 'edu/sw/els/sdl/ce/els_sdlce04_m00',
      screen: '진로활동관리',
      grid: 'grdMain',
      save: 'btnSave',
      cols: { number: 'clsNo', note: 'speclActSpablMteCn' },
      controls: { note: 'txaSpeclActSpablMteCn' },
    },
  ]
  /** 쓰는 칸 (글자수 length 등 나이스가 계산하는 열은 쓰지 않음) */
  const WRITE_ROLES = ['level', 'result', 'semester', 'behavior', 'note']
  const LEVEL_LABELS = ['매우잘함', '잘함', '보통', '노력요함']

  const stripInst = (id) => String(id ?? '').replace(/\$\d+$/, '')
  function knownSpecOf(app) {
    const base = stripInst(appId(app))
    return KNOWN_SCREENS.find((k) => k.app === base) || null
  }

  const isEl = (e) => {
    try {
      return e instanceof Element
    } catch {
      return false
    }
  }
  const cssEsc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'))
  const ctrlUuid = (c) => asStr(prop(c, 'uuid')) || asStr(call(c, 'getUUID')) || asStr(call(c, 'getUuid'))

  /** cpr 컨트롤/앱의 DOM 요소 { el, via } (API 이름이 버전마다 달라 여러 가지를 시도) */
  function elementOf(o) {
    if (!o || typeof o !== 'object') return null
    for (const k of ['getElement', 'getHtmlElement', 'getDomElement', 'getActualElement', 'getRootElement', 'getOriginalElement']) {
      const e = call(o, k)
      if (isEl(e)) return { el: e, via: k }
    }
    for (const k of ['_element', 'element', '_el', 'domElement', '_container']) {
      const e = prop(o, k)
      if (isEl(e)) return { el: e, via: k }
    }
    const uuid = ctrlUuid(o)
    // uuid가 없으면 "uuid-" + 컨트롤 id (실제 나이스 DOM id 모양: uuid-1nk)
    const id = ctrlId(o)
    for (const [u, via] of [[uuid, 'uuid'], [!uuid && id && /^\w+$/.test(id) ? 'uuid-' + id : '', 'uuid-id']]) {
      if (!u) continue
      try {
        const e = document.querySelector(`[data-ndid="${cssEsc(u)}"]`) || document.getElementById(u)
        if (e) return { el: e, via }
      } catch {
        // 무시
      }
    }
    return null
  }

  /** 컨트롤이 화면에 보이는지: true / false / null(알 수 없음) */
  function ctrlVisibility(c) {
    const r = elementOf(c)
    if (r) return { visible: r.el.isConnected !== false && visible(r.el), via: r.via }
    for (const k of ['isActualVisible', 'isShowing']) {
      const b = call(c, k)
      if (typeof b === 'boolean') return { visible: b, via: k }
    }
    return { visible: null, via: null }
  }

  /** 앱이 화면에 보이는지 (표 → 앱 컨테이너 → 앱 순서로 DOM 요소를 찾음) */
  function appVisibility(app, grid) {
    const cont = call(app, 'getContainer')
    for (const [o, tag] of [[grid, 'grid'], [cont, 'container'], [app, 'app']]) {
      const r = elementOf(o)
      if (r) return { visible: r.el.isConnected !== false && visible(r.el), via: tag + '.' + r.via }
    }
    for (const [o, tag] of [[grid, 'grid'], [cont, 'container']]) {
      for (const k of ['isActualVisible', 'isShowing']) {
        const b = call(o, k)
        if (typeof b === 'boolean') return { visible: b, via: tag + '.' + k }
      }
    }
    const rect = call(grid, 'getActualRect')
    const w = prop(rect, 'width')
    const h = prop(rect, 'height')
    if (typeof w === 'number' && typeof h === 'number') return { visible: w > 0 && h > 0, via: 'grid.getActualRect' }
    return { visible: null, via: null }
  }

  /** MDI(mdifolder)에서 선택된 탭의 앱. 못 읽으면 { found:false } */
  function mdiSelected(apps) {
    for (const app of apps) {
      for (const c of appControls(app)) {
        if (ctrlType(c) !== 'mdifolder') continue
        let item = call(c, 'getSelectedTabItem') ?? prop(c, 'selectedTabItem')
        if (!item) {
          const idx = call(c, 'getSelectedIndex') ?? prop(c, 'selectedIndex')
          if (typeof idx === 'number') item = toArray(call(c, 'getTabItems') ?? prop(c, 'tabItems'))[idx]
        }
        if (!item) return { found: true, ctrl: c, app: null }
        const content = call(item, 'getContent') ?? prop(item, 'content') ?? call(item, 'getControl')
        let inner = call(content, 'getEmbeddedAppInstance') ?? prop(content, 'appInstance') ?? call(content, 'getAppInstance')
        if (!inner && content && isFn(content, 'getContainer') && isFn(content, 'lookup')) inner = content
        return { found: true, ctrl: c, app: inner && typeof inner === 'object' ? inner : null }
      }
    }
    return { found: false, ctrl: null, app: null }
  }
  function isWithin(app, outer) {
    for (let a = app, d = 0; a && d < 20; a = embedParent.get(a), d++) if (a === outer) return true
    return false
  }

  /** DOM 표 머리글 → 알려진 화면 */
  function knownScreenOfHeaders(headers) {
    const hs = headers.map(norm)
    const has = (f) => hs.some(f)
    if (has((h) => h.includes('성취기준')) && has((h) => h === '단계') && has((h) => h.includes('평가결과'))) return '교과평가'
    if (has((h) => h.includes('학기말종합의견'))) return '학기말종합의견'
    if (has((h) => h.includes('행동특성'))) return '행동특성'
    if (has((h) => h.includes('특기사항'))) {
      if (has((h) => h.includes('영역구분'))) return '학생부자료기록'
      if (has((h) => h === '학년') || has((h) => h === '반')) return '동아리활동관리'
      if (has((h) => h.includes('희망분야'))) return '진로활동관리'
      return '자율활동관리' // 번호 · 성명 · 특기사항 · 글자수 · 위탁/공동만 있음
    }
    return null
  }

  function knownInstances() {
    const out = []
    for (const app of cprApps()) {
      const spec = knownSpecOf(app)
      if (!spec) continue
      let grid = call(app, 'lookup', spec.grid)
      if (!grid || !isGridCtrl(grid)) grid = appControls(app).find((c) => ctrlId(c) === spec.grid && isGridCtrl(c))
      if (!grid) continue
      const ds = cprDataSet(grid)
      const n = call(ds, 'getRowCount') ?? call(grid, 'getRowCount')
      const v = appVisibility(app, grid)
      out.push({ app, spec, grid, ds, id: appId(app), rows: typeof n === 'number' ? n : 0, visible: v.visible, via: v.via })
    }
    return out
  }

  /**
   * 지금 보이는 알려진 앱 하나를 고릅니다. 숨은 앱(다른 MDI 탭)의 데이터셋은 절대 고르지 않습니다.
   * 1) 화면에 보이는 앱 2) (여럿이면) MDI 선택 탭 3) 보이는 DOM 표의 머리글/요소로 대조
   */
  function resolveActive(forced) {
    const warnings = []
    let all = []
    try {
      all = knownInstances()
    } catch {
      all = []
    }
    const res = { active: null, all, how: null, warnings, mdi: { found: false, app: null } }
    if (!all.length) return res
    const pool = forced ? all.filter((k) => k.spec.screen === forced) : all
    const withRows = (list) => list.filter((k) => k.rows > 0 && !k.spec.parent)
    const one = (list) => {
      const w = withRows(list)
      return w.length === 1 ? w[0] : w.length > 1 ? 'many' : null
    }
    let mdi = null
    const getMdi = () => {
      if (!mdi) {
        try {
          mdi = mdiSelected(cprApps())
        } catch {
          mdi = { found: false, app: null }
        }
        res.mdi = mdi
      }
      return mdi
    }
    const byMdi = (list) => {
      const m = getMdi()
      if (!m.app) return null
      const r = one(list.filter((k) => isWithin(k.app, m.app)))
      return r === 'many' ? null : r
    }
    const byDom = (list) => {
      let doms = []
      try {
        doms = domGrids()
      } catch {
        doms = []
      }
      const hits = new Set()
      for (const g of doms) {
        const ids = [g.root && g.root.id, g.root && g.root.getAttribute && g.root.getAttribute('data-ndid')].filter(Boolean)
        const direct = withRows(list).filter((k) => {
          const u = ctrlUuid(k.grid)
          return u && ids.includes(u)
        })
        if (direct.length === 1) {
          hits.add(direct[0])
          continue
        }
        // 머리글 글자 + aria-label (실제 나이스는 머리글 칸에 aria-label이 붙음)
        let aria = []
        try {
          aria = Array.from(g.root.querySelectorAll('[role=columnheader]')).map((h) => h.getAttribute('aria-label') || '')
        } catch {
          aria = []
        }
        const s = knownScreenOfHeaders(g.headers.concat(aria))
        if (!s) continue
        const cands = withRows(list).filter((k) => k.spec.screen === s)
        if (cands.length === 1) hits.add(cands[0])
        else if (cands.length > 1) cands.forEach((k) => hits.add(k))
      }
      return hits.size === 1 ? [...hits][0] : null
    }

    const shown = pool.filter((k) => k.visible === true)
    let a = one(shown)
    let how = 'visible'
    if (a === 'many') {
      a = byMdi(shown)
      how = 'mdi'
      if (!a) {
        a = byDom(shown)
        how = 'dom'
      }
      if (!a) warnings.push('active-app-ambiguous')
    } else if (!a) {
      // 보이는지 알 수 없는 앱만 남은 경우 (DOM 요소를 못 찾음): MDI 선택 탭 → DOM 표 머리글
      const unknown = pool.filter((k) => k.visible == null)
      if (withRows(unknown).length) {
        a = byMdi(unknown)
        how = 'mdi'
        if (!a) {
          a = byDom(unknown)
          how = 'dom'
        }
        if (!a) warnings.push(withRows(unknown).length > 1 ? 'active-app-ambiguous' : 'active-app-unconfirmed')
      }
    }
    if (a && a !== 'many' && a.visible !== false) {
      // MDI 선택 탭을 읽을 수 있는데 고른 앱이 그 탭 밖이면 믿지 않습니다
      const m = getMdi()
      if (m.app && !isWithin(a.app, m.app) && !elementWithin(a, m.app)) {
        if (!warnings.includes('active-app-ambiguous')) warnings.push('active-app-ambiguous')
        return res
      }
      res.active = a
      res.how = how
    }
    return res
  }
  /** 고른 앱의 표 요소가 MDI 선택 탭 앱의 화면 요소 안에 있는지 (끼워 넣은 앱 관계를 API로 못 읽을 때) */
  function elementWithin(k, outerApp) {
    const inner = elementOf(k.grid) || elementOf(call(k.app, 'getContainer'))
    const outer = elementOf(call(outerApp, 'getContainer')) || elementOf(outerApp)
    return !!(inner && outer && outer.el !== inner.el && outer.el.contains(inner.el))
  }

  // ---------- 교과평가 단계 콤보 (cmbLvl) ----------
  // 실제 나이스(4차 구조 수집): 쉴 때 cmbLvl 항목은 비어 있고, 행(성취기준)을 고르면 그 성취기준에 등록된 평가기준을 불러와 항목이 생깁니다.
  /** 콤보 항목 [{label, value}] (항목 목록 → 묶인 데이터셋 순서로) */
  function comboItemsOf(ctl, app) {
    if (!ctl || typeof ctl !== 'object') return []
    const items = toArray(call(ctl, 'getItems'))
    if (!items.length) {
      const n = call(ctl, 'getItemCount') ?? prop(ctl, 'itemCount')
      if (typeof n === 'number') for (let i = 0; i < n && i < 50; i++) items.push(call(ctl, 'getItem', i))
    }
    const out = items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({ label: asStr(prop(it, 'label')) || asStr(call(it, 'getLabel')), value: asStr(prop(it, 'value')) || asStr(call(it, 'getValue')) }))
    if (!out.length) {
      // 데이터셋에 묶인 항목 (itemSetConfig)
      const cfg = call(ctl, 'getItemSetConfig') ?? prop(ctl, 'itemSetConfig') ?? prop(ctl, 'itemset')
      if (cfg && typeof cfg === 'object') {
        let ids = prop(cfg, 'dataSet') ?? prop(cfg, 'dataset') ?? prop(cfg, 'datasetId') ?? prop(cfg, 'dataSetId')
        if (typeof ids === 'string') ids = call(app, 'lookup', ids)
        if (!ids) ids = prop(ctl, 'dataSet')
        const lc = asStr(prop(cfg, 'label')) || asStr(prop(cfg, 'labelColumn'))
        const vc = asStr(prop(cfg, 'value')) || asStr(prop(cfg, 'valueColumn'))
        const n = call(ids, 'getRowCount')
        if (lc && vc && typeof n === 'number')
          for (let i = 0; i < n && i < 50; i++) out.push({ label: asStr(call(ids, 'getValue', i, lc)), value: asStr(call(ids, 'getValue', i, vc)) })
      }
    }
    return out.filter((x) => x.label || x.value).slice(0, 50)
  }
  const itemsSig = (items) => items.map((x) => x.label + '\u0001' + x.value).join('\u0002')
  /** 단계 글자 → 항목. 띄어쓰기를 무시하고, "매우잘함 : …"처럼 단계 이름으로 시작하는 항목도 받습니다 ("잘함"이 "매우잘함"에 걸리지 않음) */
  function matchLevel(items, label) {
    const want = norm(label)
    if (!want) return null
    return items.find((it) => norm(it.label) === want) || items.find((it) => norm(it.label).startsWith(want)) || null
  }

  /** 알려진 교과평가 앱의 단계 콤보 다루기: 항목 읽기, 행 고르기, 원래 선택으로 되돌리기 */
  function levelKit(k) {
    const { app, grid, spec } = k
    const col = spec.cols.level
    const detail = prop(grid, 'detail') ?? call(grid, 'getDetail')
    let colIndex = -1
    function detailControl() {
      let c = call(detail, 'getColumnByName', col)
      if (!c || typeof c !== 'object') {
        c = null
        const n = cellCount(detail)
        for (let i = 0; i < n && i < 100; i++) {
          const x = cellAt(detail, i)
          if ((asStr(prop(x, 'columnName')) || asStr(call(x, 'getColumnName'))) === col) {
            c = x
            if (colIndex < 0) colIndex = i
            break
          }
        }
      }
      if (c && colIndex < 0) {
        const ci = prop(c, 'cellIndex') ?? prop(c, 'colIndex')
        if (typeof ci === 'number') colIndex = ci
      }
      return c ? prop(c, 'control') ?? call(c, 'getControl') ?? null : null
    }
    function controls() {
      const out = []
      const byId = spec.controls && spec.controls.level ? call(app, 'lookup', spec.controls.level) : null
      if (byId && typeof byId === 'object') out.push(byId)
      const d = detailControl()
      if (d && typeof d === 'object' && !out.includes(d)) out.push(d)
      return out
    }
    detailControl()
    /** 지금 항목 (항목이 있는 첫 컨트롤) */
    function itemsNow() {
      const list = controls()
      for (const ctl of list) {
        const items = comboItemsOf(ctl, app)
        if (items.length) return { items, ctl }
      }
      return { items: [], ctl: list[0] || null }
    }
    /** 지금 고른 행 번호들 (읽을 수 없으면 undefined) */
    function selection() {
      if (isFn(grid, 'getSelectedRowIndices')) return toArray(call(grid, 'getSelectedRowIndices')).filter((x) => typeof x === 'number' && x >= 0)
      const v = call(grid, 'getSelectedRowIndex') ?? prop(grid, 'selectedRowIndex')
      if (typeof v === 'number') return v >= 0 ? [v] : []
      return undefined
    }
    function select(r, how) {
      if (how === 'focus') {
        if (!isFn(grid, 'focusCell')) return false
        call(grid, 'focusCell', r, colIndex >= 0 ? colIndex : 0)
        return true
      }
      if (isFn(grid, 'selectRows')) {
        call(grid, 'selectRows', [r])
        return true
      }
      for (const f of ['select', 'selectRow', 'setSelectedRowIndex'])
        if (isFn(grid, f)) {
          call(grid, f, r)
          return true
        }
      return false
    }
    const sameSel = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
    /** 원래 고른 행으로 되돌립니다. 되돌린 것이 확인되면 true */
    function restore(prev) {
      if (!Array.isArray(prev)) return false
      if (prev.length) {
        if (isFn(grid, 'selectRows')) call(grid, 'selectRows', prev.slice())
        else select(prev[0], 'select')
      } else call(grid, 'clearSelection')
      const now = selection()
      return now === undefined ? false : sameSel(now, prev)
    }
    /**
     * 행 r을 골라 그 행의 단계 항목을 읽습니다 (나이스가 항목을 불러오기를 기다림).
     * hows: 시도할 방법(selectRows → focusCell), wait: 방법마다 최대 대기(ms),
     * prevSig: 앞 행 항목 — 같은 항목이 그대로 보이면 아직 안 바뀐 것일 수 있어 300ms는 더 기다립니다
     */
    async function itemsFor(r, { hows = ['select', 'focus'], wait = 600, prevSig = null } = {}) {
      for (const how of hows) {
        if (!select(r, how)) continue
        const t0 = Date.now()
        for (;;) {
          const now = itemsNow()
          if (now.items.length) {
            const sig = itemsSig(now.items)
            if (sig !== prevSig || Date.now() - t0 >= 300) return { ...now, how, sig }
          }
          if (Date.now() - t0 >= wait) break
          await sleep(50)
        }
      }
      return { items: [], ctl: null, how: null, sig: '' }
    }
    return {
      col,
      canSelect: ['selectRows', 'select', 'selectRow', 'setSelectedRowIndex', 'focusCell'].some((f) => isFn(grid, f)),
      controls,
      itemsNow,
      selection,
      select,
      restore,
      itemsFor,
      get colIndex() {
        return colIndex
      },
    }
  }

  /** 데이터셋의 바뀐 행 수 (RowState: 1 그대로, 2 추가, 4 수정, 8 삭제). 읽을 수 없으면 null */
  function modifiedRowsOf(ds) {
    const n = call(ds, 'getRowCount')
    let seen = false
    let cnt = 0
    if (typeof n === 'number' && isFn(ds, 'getRowState'))
      for (let r = 0; r < n && r < 5000; r++) {
        const st = call(ds, 'getRowState', r)
        if (st == null || st === '' || !Number.isFinite(Number(st))) continue
        seen = true
        if (Number(st) & 6) cnt++
      }
    if (seen) return cnt
    const idx = call(ds, 'getRowIndicesByState', 4)
    if (Array.isArray(idx)) return idx.length
    const m = call(ds, 'isModified')
    return typeof m === 'boolean' ? (m ? 1 : 0) : null
  }

  // --- 알려진 화면의 데이터셋 어댑터 (다른 표 방식과 같은 모양: has/rowCount/readNumber/readText/isEmpty/write/verify/finish) ---
  function makeKnownGrid(k) {
    const { spec, app, grid } = k
    const ds = k.ds || cprDataSet(grid)
    const colNames = cprColumnNames(grid)
    const hasCol = (c) => !!c && (!colNames.length || colNames.includes(c))
    /** 값 읽기. 개인정보 열은 읽지 않습니다 */
    const rd = (r, col) => {
      if (!col || PERSONAL.has(col) || !hasCol(col)) return ''
      const v = isFn(ds, 'getValue') ? call(ds, 'getValue', r, col) : call(grid, 'getCellValue', r, col)
      return v == null ? '' : String(v)
    }
    /** 숫자만 있는 값의 마지막 숫자 (원문은 남기지 않음) */
    const digitsAt = (r, col) => {
      if (!DIGIT_COLS.includes(col) || !hasCol(col)) return null
      const v = isFn(ds, 'getValue') ? call(ds, 'getValue', r, col) : call(grid, 'getCellValue', r, col)
      const t = v == null ? '' : String(v).trim()
      return t && DIGITS_ONLY.test(t) ? lastInt(t) : null
    }
    const rowCount = () => {
      const n = call(ds, 'getRowCount') ?? call(grid, 'getRowCount')
      return typeof n === 'number' ? n : 0
    }
    // 학기말종합의견: 번호를 담은 열 고르기 (앞 행들이 모두 숫자만인 열)
    const numberCol = spec.cols.number && hasCol(spec.cols.number) ? spec.cols.number : null
    let digitCol = null
    if (!numberCol && spec.numberDigits) {
      const n = Math.min(rowCount(), 5)
      for (const col of spec.numberDigits) {
        if (!hasCol(col)) continue
        let okRows = 0
        for (let r = 0; r < n; r++) if (digitsAt(r, col) != null) okRows++
        if (n && okRows === n) {
          digitCol = col
          break
        }
      }
    }
    const colOf = (role) => (role === 'number' ? numberCol : spec.cols[role])
    const has = (role) =>
      role === 'number' ? !!(numberCol || digitCol) : role === 'standard' ? hasCol(spec.cols.standard) || hasCol(spec.cols.stdCode) : hasCol(spec.cols[role])

    /** 영역: 학생부자료기록은 actScNm2 → actScNm, 교과평가는 relmNm */
    const area = (r) => {
      for (const c of spec.areaCols || [spec.cols.area]) {
        const v = rd(r, c)
        if (norm(v)) return v
      }
      return ''
    }
    const stdCodeOf = (r) => rd(r, spec.cols.stdCode).trim() // 실제 값 끝에 공백이 붙어 있음
    const stdKeyOf = (r) => normCode(stdCodeOf(r)) || rowStdKey(rd(r, spec.cols.standard))
    const resultCol = spec.cols.result
    let autoFilled = 0

    // --- 단계 ---
    const kit = spec.cols.level && hasCol(spec.cols.level) ? levelKit(k) : null
    let restItems = null // 행을 고르지 않고 읽은 항목 (실제 나이스는 비어 있음)
    const atRest = () => {
      if (!restItems) restItems = kit ? kit.itemsNow().items : []
      return restItems
    }
    let perRow = false // 행마다 골라서 항목을 읽는 방식
    let probed = null // 인식 검사에서 행을 골라 읽은 항목
    const rowCodes = new Map() // 행|글자 → 단계 코드
    let prevSel
    let selSaved = false
    let selRestored = null
    let lastSig = null
    let lastKey = null
    let globalItems = false // 성취기준이 달라도 항목이 같음 → 더 기다리지 않음
    let how = null
    let fails = 0
    let okRows = 0
    let dead = false
    let liveUnsafe = false
    let liveUsed = 0
    let liveMoved = 0
    const snapshot = () => {
      const n = rowCount()
      const out = []
      for (let i = 0; i < n && i < 5000; i++) out.push([rd(i, spec.cols.level), rd(i, resultCol)])
      return out
    }
    /** 단계 코드 넣기: 고른 행의 콤보로 고르고(나이스의 변경 처리가 평가결과를 채우도록), 데이터셋에도 확실히 넣음 */
    async function setLevel(r, value, ctl) {
      const col = spec.cols.level
      const before = rd(r, resultCol)
      const sel = kit ? kit.selection() : undefined
      const live = !liveUnsafe && !!ctl && Array.isArray(sel) && sel.length === 1 && sel[0] === r
      if (live) {
        const snap = snapshot()
        try {
          if (isFn(ctl, 'selectItemByValue')) ctl.selectItemByValue(value)
          else if (isFn(ctl, 'putValue')) ctl.putValue(value)
        } catch {
          // 아래에서 데이터셋으로
        }
        // 콤보가 다른 행에 묶여 있었으면 그 행을 되돌리고, 이후로는 콤보를 쓰지 않습니다
        for (let i = 0; i < snap.length; i++) {
          if (i === r) continue
          if (rd(i, col) !== snap[i][0] || rd(i, resultCol) !== snap[i][1]) {
            liveUnsafe = true
            liveMoved++
            call(ds, 'setValue', i, col, snap[i][0])
            if (resultCol) call(ds, 'setValue', i, resultCol, snap[i][1])
          }
        }
        liveUsed++
      }
      if (norm(rd(r, col)) !== norm(value)) {
        try {
          if (isFn(ds, 'setValue')) ds.setValue(r, col, value)
          else if (isFn(grid, 'setCellValue')) grid.setCellValue(r, col, value)
          else return false
        } catch {
          return false
        }
      }
      // 콤보로 골랐으면 나이스가 평가결과를 채우는지 잠깐 기다립니다
      if (live && resultCol && norm(before) === '') {
        const t0 = Date.now()
        while (Date.now() - t0 < 300 && norm(rd(r, resultCol)) === '') await sleep(50)
      }
      const after = rd(r, resultCol)
      if (resultCol && after !== before && norm(after) !== '') autoFilled++
      return true
    }
    /** 행마다 고르기: 행을 골라 그 성취기준의 항목에서 코드를 찾습니다. 못 찾으면 { unavailable } (그 행만 건너뜀) */
    async function writeLevelPerRow(r, label) {
      if (dead || !kit) return { unavailable: true }
      if (!selSaved) {
        prevSel = kit.selection()
        selSaved = true
        // 사람이 앞서 고른 행의 항목이 남아 있을 수 있으므로, 처음 행도 그 항목과 같으면 조금 기다립니다
        lastSig = itemsSig(kit.itemsNow().items) || null
      }
      const key = stdKeyOf(r)
      const got = await kit.itemsFor(r, { hows: how ? [how] : ['select', 'focus'], wait: how ? 800 : 500, prevSig: globalItems ? null : lastSig })
      if (!got.items.length) {
        fails++
        if (!okRows && fails >= 3) dead = true // 처음 세 행에서 항목이 하나도 안 나오면 더 기다리지 않음
        return { unavailable: true }
      }
      if (!globalItems && lastKey != null && key !== lastKey && got.sig === lastSig) globalItems = true
      how = got.how
      lastSig = got.sig
      lastKey = key
      const hit = matchLevel(got.items, label)
      if (!hit || hit.value === '') return { unavailable: true }
      okRows++
      rowCodes.set(r + '|' + norm(label), hit.value)
      return setLevel(r, hit.value, got.ctl)
    }

    return {
      source: 'cpr-known',
      appId: k.id,
      id: ctrlId(grid),
      spec,
      headers: [],
      headerColumns: [],
      columns: colNames,
      roles: Object.fromEntries(Object.entries(spec.cols).filter(([, c]) => hasCol(c))),
      has,
      usable(screen) {
        return (NEEDS[screen] || []).every((r) => has(r)) && (screen !== '교과평가' || has('level') || has('result')) && (screen === '교과평가' || !!targetRole(screen, this))
      },
      rowCount,
      readNumber(r) {
        if (numberCol) return lastInt(rd(r, numberCol))
        return digitCol ? digitsAt(r, digitCol) : null
      },
      readText: (r, role) => (role === 'area' ? area(r) : rd(r, colOf(role))),
      /** 성취기준: 코드 열(sccesCtrCd, 앞뒤 공백 제거)에서 먼저, 없으면 성취기준 글자(sccesCtrCn)에서 */
      stdMatch: (r, code) => hasCode(stdCodeOf(r), code) || hasCode(rd(r, spec.cols.standard), code),
      stdKey: stdKeyOf,
      /** 성취기준 코드([6국05-01] 모양)가 어느 행에든 있는지 (없으면 내부 코드뿐 → 글자·순서로 맞춤) */
      hasCodes() {
        const n = rowCount()
        for (let r = 0; r < n && r < 2000; r++) if (CODE_RE.test(normCode(stdCodeOf(r))) || CODE_RE.test(normCode(rd(r, spec.cols.standard)))) return true
        return false
      },
      isEmpty: (r, role) => norm(role === 'area' ? area(r) : rd(r, colOf(role))) === '',
      closedRow: (r) => (spec.closed || []).some((c) => hasCol(c) && norm(rd(r, c)).toUpperCase() === 'Y'),
      /** 화면 데이터의 과목 (행마다 같은 과목 하나일 때만) */
      subjectLabel() {
        const col = spec.cols.subject
        if (!hasCol(col)) return null
        const set = new Set()
        const n = rowCount()
        for (let r = 0; r < n && r < 2000; r++) {
          const v = stripParen(rd(r, col))
          if (v) set.add(v)
          if (set.size > 1) return null
        }
        return set.size === 1 ? [...set][0] : null
      },
      /** 바뀐 행 수 (저장 대상). 읽을 수 없으면 null */
      modifiedRows: () => modifiedRowsOf(ds),
      /**
       * 단계 코드를 미리 정합니다. 못 찾은 글자 목록을 돌려줌.
       * 쉴 때 항목이 비어 있으면(실제 나이스) 행마다 골라서 읽도록 미루고 빈 목록을 돌려줍니다
       */
      prepareLevels(tasks) {
        // 행을 고를 수 있으면 언제나 행마다 골라 읽습니다 (쉴 때 보이는 항목은 앞서 고른 행의 것일 수 있음)
        if (kit && kit.canSelect) {
          perRow = true
          return []
        }
        const items = atRest()
        if (!items.length) return ['(단계 항목을 읽을 수 없음)']
        const missing = new Set()
        for (const t of tasks)
          for (const c of t.cells) {
            if (c.role !== 'level') continue
            const hit = matchLevel(items, c.value)
            if (!hit || hit.value === '') missing.add(oneLine(c.value))
            else rowCodes.set(t.r + '|' + norm(c.value), hit.value)
          }
        return [...missing]
      },
      get perRow() {
        return perRow
      },
      /** 인식 검사: 행을 잠깐 골라 단계 항목을 읽고 원래 선택으로 되돌립니다 (칸은 바꾸지 않음) */
      async probeLevels(rows) {
        if (!kit || !kit.canSelect) return null
        const prev = kit.selection()
        const out = []
        let sig = null
        for (const r of rows.slice(0, 2)) {
          const got = await kit.itemsFor(r, { prevSig: sig })
          if (got.sig) sig = got.sig
          out.push({ row: r, how: got.how, items: got.items.slice(0, 12).map((x) => ({ label: cut(x.label, 20), value: cut(x.value, 40) })) })
          if (!got.items.length) break
        }
        const restored = kit.restore(prev)
        probed = out
        return { rows: out, restored }
      },
      /** 인식 검사용: {글자: 코드} 또는 null */
      levelCodes() {
        if (!has('level')) return null
        let items = probed && probed[0] ? probed[0].items : []
        if (!items.length && !probed) items = atRest()
        if (!items.length) return null
        const m = {}
        for (const x of items.slice(0, 20)) if (x.label && !(oneLine(x.label) in m)) m[oneLine(x.label)] = x.value
        return m
      },
      /** 단계 항목을 행을 고르지 않고는 읽을 수 없는지 */
      levelItemsEmpty() {
        return has('level') && atRest().length === 0
      },
      /** 빈 칸만: 이미 있는 단계 코드가 넣으려는 코드와 다른지(행마다 고르는 방식이면 확인할 수 없으므로 다른 것으로 봄) */
      levelMismatch(r, label) {
        const now = norm(rd(r, spec.cols.level))
        if (now === '') return false
        const want = rowCodes.get(r + '|' + norm(label))
        return want == null ? true : now !== norm(want)
      },
      /** 인식 검사용: 단계 코드가 있는 행에서 단계 이름·성취수준 열이 차 있는 수 (아직 쓰지 않는 열) */
      levelSideColumns() {
        if (!has('level')) return null
        const cols = ['evlCtrNm', 'evlLvlCd', 'evlLvlNm'].filter((c) => hasCol(c))
        const out = { rows: 0 }
        for (const c of cols) out[c] = 0
        const n = rowCount()
        for (let r = 0; r < n && r < 2000; r++) {
          if (norm(rd(r, spec.cols.level)) === '') continue
          out.rows++
          for (const c of cols) if (norm(rd(r, c)) !== '') out[c]++
        }
        return out.rows ? out : null
      },
      /** 인식 검사용 추정: 단계가 있는 행의 평가결과가 모두 차 있으면 true, 빈 것이 있으면 false, 단계가 있는 행이 없으면 null */
      resultAutoFill() {
        if (!has('level') || !has('result')) return null
        let withLevel = 0
        let filled = 0
        const n = rowCount()
        for (let r = 0; r < n && r < 2000; r++) {
          if (norm(rd(r, spec.cols.level)) === '') continue
          withLevel++
          if (norm(rd(r, resultCol)) !== '') filled++
        }
        return withLevel ? filled === withLevel : null
      },
      get autoFilled() {
        return autoFilled
      },
      /** 입력 뒤 단계 콤보 정보 (결과 안내용) */
      levelInfo() {
        return { perRow, how, liveUsed, liveMoved, restored: selRestored, dead }
      },
      async write(r, role, value) {
        if (!WRITE_ROLES.includes(role)) return false
        const col = colOf(role)
        if (!col || PERSONAL.has(col) || !hasCol(col)) return false
        if (role === 'level') {
          if (perRow) return writeLevelPerRow(r, value)
          const v = rowCodes.get(r + '|' + norm(value))
          if (v == null || v === '') return false
          return setLevel(r, v, null)
        }
        try {
          if (isFn(ds, 'setValue')) ds.setValue(r, col, value)
          else if (isFn(grid, 'setCellValue')) grid.setCellValue(r, col, value)
          else return false
        } catch {
          return false
        }
        return true
      },
      verify(r, role, value) {
        const got = norm(rd(r, colOf(role)))
        if (role === 'level') {
          const want = rowCodes.get(r + '|' + norm(value)) ?? ''
          return got !== '' && got === norm(want)
        }
        return got === norm(value)
      },
      finish() {
        // 행을 골랐으면 원래 고른 행(없으면 선택 없음)으로 되돌립니다
        if (selSaved && kit) {
          selRestored = kit.restore(prevSel)
          selSaved = false
        }
        call(grid, 'redraw')
      },
      editableRows: () => [],
      /**
       * 저장: 이 앱(없으면 바깥 앱)의 btnSave. 꺼져 있으면 누르지 않고, 페이지 전체의 '저장' 글자 버튼으로 넘어가지 않습니다.
       * 화면 요소로 찾을 때는 이 앱 화면 안에서만 찾습니다.
       */
      async save() {
        const gone = { saved: false, confirmed: 0, note: '저장 직전에 화면이 바뀌어 저장하지 않았습니다. 화면을 확인하고 직접 저장하세요.' }
        // 저장 직전: 이 앱이 아직 보이는지 다시 확인 (알 수 없으면 다시 골라 같은 앱인지)
        const v = appVisibility(app, grid)
        if (v.visible === false) return gone
        if (v.visible == null) {
          const again = resolveActive(null)
          if (!again.active || again.active.app !== app) return gone
        }
        const parent = embedParent.get(app)
        for (const a of parent ? [app, parent] : [app]) {
          const btn = spec.save ? call(a, 'lookup', spec.save) : null
          if (!btn) continue
          const e = elementOf(btn)
          if (e && !visible(e.el)) continue // 이 앱의 저장 버튼이 숨어 있으면 바깥 앱의 저장 버튼
          if (prop(btn, 'enabled') === false || call(btn, 'isEnabled') === false) return { saved: false, confirmed: 0, note: '저장 버튼이 비활성' }
          if (isFn(btn, 'click')) {
            try {
              btn.click()
              return waitDialogs()
            } catch {
              // 아래 요소 클릭
            }
          }
          if (e) {
            clickEl(e.el)
            return waitDialogs()
          }
        }
        const root = elementOf(call(app, 'getContainer')) || elementOf(app) || (parent ? elementOf(call(parent, 'getContainer')) : null)
        if (root && visible(root.el)) return clickSave(root.el)
        return { saved: false, confirmed: 0, note: '저장 버튼을 찾지 못했습니다' }
      },
    }
  }

  // ---------- 화면 인식 ----------
  const TITLE_RULES = [
    ['학기말종합의견', /학기말\s*종합\s*의견/],
    ['행동특성', /행동\s*특성/],
    ['동아리활동관리', /동아리\s*활동\s*관리/],
    ['진로활동관리', /진로\s*활동\s*관리/],
    ['교과평가', /교과\s*(별\s*)?평가/],
    ['학생부자료기록', /학생부\s*자료\s*기록/],
  ]
  const MENU_SEL =
    'nav, [role=navigation], [role=menu], [role=menubar], [role=tree], [class*="menu"], [class*="Menu"], [class*="tree"], [class*="aside"], [class*="gnb"], [class*="lnb"], [class*="breadcrumb"]'

  // 제목은 화면 이름 낱말만 꺼내 씁니다. 화면의 다른 글자(학생 이름 등)는 내보내지 않습니다
  const TITLE_PHRASES =
    /학기말\s*종합\s*의견|행동\s*특성(?:\s*및\s*종합\s*의견)?|동아리\s*활동\s*관리|진로\s*활동\s*관리|교과\s*(?:별\s*)?평가|학생부\s*자료\s*기록|창의적\s*체험\s*활동|자율\s*·?\s*자치\s*활동|동아리\s*활동|진로\s*활동|학생\s*평가/g

  /** 화면 제목 후보에서 찾은 화면 이름 낱말들 (원문 아님) */
  function pageTitles() {
    const out = []
    const push = (t) => {
      for (const m of String(t ?? '').match(TITLE_PHRASES) || []) {
        const k = oneLine(m)
        if (!out.includes(k)) out.push(k)
      }
    }
    try {
      for (const app of cprApps()) push(appTitle(app))
    } catch {
      // 무시
    }
    const sel = 'h1, h2, h3, h4, [role=heading], [class*="title"], [class*="Title"], [role=tab][aria-selected="true"], .cl-tabfolder-item.cl-selected'
    for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 400)) {
      if (!visible(el) || el.closest(MENU_SEL) || el.closest('table, [role=grid], .cl-grid')) continue
      push(el.textContent)
      if (out.length >= 30) break
    }
    push(document.title)
    return out
  }

  function screenFromTitles(titles) {
    for (const t of titles) for (const [screen, re] of TITLE_RULES) if (re.test(t)) return screen
    return null
  }

  /** 머리글로 화면 판단. 동아리/진로처럼 "특기사항"만 있으면 제목으로 나눕니다 */
  function screenOfGrid(g, titleScreen) {
    const hs = g.headers.map(norm)
    if (g.has('level') && g.has('result')) return '교과평가'
    if (g.has('semester') || (g.has('opinion') && titleScreen === '학기말종합의견')) return '학기말종합의견'
    if (g.has('behavior')) return '행동특성'
    if (g.has('note') && g.has('area')) return '학생부자료기록'
    if (g.has('note')) {
      if (titleScreen === '진로활동관리' || titleScreen === '동아리활동관리') return titleScreen
      if (hs.some((h) => h === '학년' || h === '반')) return '동아리활동관리'
      return null
    }
    return null
  }

  const NEEDS = {
    교과평가: ['number', 'standard'],
    학기말종합의견: ['number'],
    행동특성: ['number', 'behavior'],
    학생부자료기록: ['number', 'area', 'note'],
    동아리활동관리: ['number', 'note'],
    진로활동관리: ['number', 'note'],
  }
  function targetRole(screen, g) {
    if (screen === '학기말종합의견') return g.has('semester') ? 'semester' : g.has('opinion') ? 'opinion' : null
    if (screen === '행동특성') return 'behavior'
    if (screen === '교과평가') return null
    return 'note'
  }
  function usable(screen, g) {
    if (!(NEEDS[screen] || []).every((r) => g.has(r))) return false
    if (screen === '교과평가') return g.has('level') || g.has('result')
    if (screen === '학기말종합의견') return !!targetRole(screen, g)
    return true
  }

  function analyze() {
    const titles = pageTitles()
    const titleScreen = screenFromTitles(titles)
    const { cpr, dom } = allGrids()
    const grids = cpr.concat(dom)
    let screen = null
    for (const g of grids) {
      const s = screenOfGrid(g, titleScreen)
      if (s) {
        screen = s
        break
      }
    }
    if (!screen) screen = titleScreen
    return { titles, titleScreen, screen: screen || 'unknown', cpr, dom, grids }
  }

  function gridSummary(g) {
    return {
      source: g.source,
      appId: g.appId,
      ctrlId: g.id,
      rows: g.rowCount(),
      columns: g.headers.map((h, i) => ({ header: h, name: g.headerColumns[i] ?? null, role: roleOf(h) })),
    }
  }

  function pickGrid(screen, a) {
    const ok = (list) => list.filter((g) => usable(screen, g)).sort((x, y) => y.rowCount() - x.rowCount())[0]
    return ok(a.cpr) || ok(a.dom) || null
  }

  const cleanPath = () => location.pathname.split(';')[0]

  /**
   * 입력할 표 고르기. 알려진 나이스 화면이 보이면 그 앱의 데이터셋(cpr-known)만 씁니다.
   * - 보이는 알려진 앱의 화면과 forced(팝업이 보낸 화면)가 다르면 fatal 'screen-mismatch' (다른 화면 글을 넣지 않음)
   * - 알려진 앱이 있는데 보이는 앱을 하나로 정하지 못하면 fatal 'active-app-ambiguous' (다른 방식으로 넘어가지 않음)
   * - 알려진 앱이 없거나 모두 숨어 있으면 1차 방식(알려지지 않은 cpr 그리드/DOM)
   */
  function chooseGrid(forced, a) {
    const notes = []
    const kr = resolveActive(null)
    const warnings = kr.warnings.slice()
    const k = kr.active
    const base = { detectedScreen: k ? k.spec.screen : a.screen, k, knownList: kr.all, warnings, notes }
    if (k) {
      if (forced && forced !== k.spec.screen) {
        warnings.push('screen-mismatch')
        return { ...base, screen: forced, g: null, fatal: 'screen-mismatch' }
      }
      let kg = null
      try {
        kg = makeKnownGrid(k)
      } catch {
        kg = null
      }
      if (kg && kg.usable(k.spec.screen)) return { ...base, screen: k.spec.screen, g: kg }
      // 데이터 열이 예상과 다름: 다른 cpr 표에는 쓰지 않고, 화면(DOM)에 보이는 편집 칸만
      warnings.push('known-columns-missing')
      notes.push('나이스 화면의 데이터 열을 찾지 못해 화면(DOM)에 보이는 칸에만 입력합니다.')
      const dom = a.dom.filter((g) => usable(k.spec.screen, g)).sort((x, y) => y.rowCount() - x.rowCount())[0] || null
      return { ...base, screen: k.spec.screen, g: dom }
    }
    if (kr.all.some((x) => x.rows > 0) && (warnings.includes('active-app-ambiguous') || warnings.includes('active-app-unconfirmed'))) {
      notes.push('보이는 나이스 화면을 하나로 정하지 못해 입력하지 않았습니다. 쓰지 않는 탭을 닫고 다시 시도하세요.')
      return { ...base, screen: forced || a.screen, g: null, fatal: 'active-app-ambiguous' }
    }
    // 보이는 알려진 앱이 없는데 MDI 선택 탭이 나이스 업무 화면(edu/…)이면, 숨은 다른 탭의 제목·표로 짐작하지 않습니다.
    // (3차: 자율활동관리 탭을 열었는데 숨은 동아리 탭 제목/표 머리글로 "동아리활동관리"라고 잘못 알아본 일)
    let m = kr.mdi && kr.mdi.found ? kr.mdi : null
    if (!m) {
      try {
        m = mdiSelected(cprApps())
      } catch {
        m = { found: false, app: null }
      }
    }
    if (m.app) {
      const mid = appId(m.app)
      if (stripInst(mid).startsWith('edu/')) {
        base.mdiSelected = mid
        const inside = kr.all.filter((x) => !x.spec.parent && (x.app === m.app || isWithin(x.app, m.app)))
        const own = knownSpecOf(m.app)
        const scr = inside.length ? inside[0].spec.screen : own && !own.parent ? own.screen : null
        if (scr) {
          // 알려진 화면인데 데이터가 비어 있음 (조회 전)
          base.detectedScreen = scr
          if (forced && forced !== scr) {
            warnings.push('screen-mismatch')
            return { ...base, screen: forced, g: null, fatal: 'screen-mismatch' }
          }
          notes.push('나이스 화면의 표가 비어 있습니다. 조회를 누른 뒤 다시 시도하세요.')
          return { ...base, screen: scr, g: null }
        }
        warnings.push('unsupported-screen')
        notes.push(`아직 지원하지 않는 나이스 화면입니다 (앱 ${stripInst(mid).split('/').pop()}). 화면 구조 수집 파일을 보내 주세요.`)
        return { ...base, detectedScreen: 'unknown', screen: 'unknown', g: null, fatal: 'unsupported-screen' }
      }
    }
    const screen = forced || a.screen
    return { ...base, screen, g: SCREENS.includes(screen) ? pickGrid(screen, a) : null }
  }
  const strategyOf = (g) => (!g ? null : g.source === 'cpr-known' ? 'cpr-known' : g.source === 'cpr' ? 'cpr' : 'dom')

  /** args.screen: 팝업의 "화면 지정" (있으면 그 화면으로 표를 고릅니다) */
  function detect(args) {
    const a = analyze()
    const forced = args && SCREENS.includes(args.screen) ? args.screen : null
    const c = chooseGrid(forced, a)
    const g = c.g
    return {
      screen: c.screen,
      detectedScreen: c.detectedScreen,
      blocked: c.fatal || (NOT_TARGET[c.screen] ? 'not-a-target' : null),
      forced: !!forced,
      running,
      ready: !!g,
      strategy: strategyOf(g),
      knownApp: !!g && g.source === 'cpr-known',
      activeApp: c.k ? c.k.id : null,
      datasetRows: c.k ? c.k.rows : null,
      mdiSelected: c.mdiSelected || null,
      rows: g ? g.rowCount() : 0,
      cpr: !!cprPlatform(),
      cprVersion: cprVersion(),
      apps: cprApps().length,
      titleScreen: a.titleScreen,
      titles: a.titles.slice(0, 5),
      grids: a.grids.slice(0, 20).map(gridSummary),
      warnings: c.warnings,
      path: cleanPath(),
    }
  }

  // ---------- 과목 확인 (학기말종합의견) ----------
  const SUBJECTS = ['국어', '수학', '사회', '과학', '영어', '도덕', '실과', '체육', '음악', '미술', '정보', '바른생활', '슬기로운생활', '즐거운생활', '통합']
  const stripParen = (t) => norm(t).replace(/\([^)]*\)/g, '')
  /** 글자에서 "낱말 전체가 과목 이름"인 것만 찾습니다 ("학생정보"·"통합조회"는 과목 아님, "국어(독서)"는 국어) */
  function subjectsIn(text) {
    const out = new Set()
    for (const tok of String(text ?? '').split(/[\s:：/|·,]+/)) {
      const base = stripParen(tok)
      if (SUBJECTS.includes(base)) out.add(base)
    }
    return out
  }
  /** 콤보 옆 이름표 글자 (label, aria-label, 앞 형제, 짧은 부모 글자) */
  function nearLabel(el) {
    const parts = [el.getAttribute('aria-label') || '']
    const lab = el.closest('label')
    if (lab) parts.push(lab.textContent)
    if (el.previousElementSibling) parts.push(el.previousElementSibling.textContent)
    const par = el.parentElement
    if (par && par.textContent.length <= 40) parts.push(par.textContent)
    return parts.join(' ')
  }
  /**
   * 화면에서 고른 과목 (비교에만 쓰고 내보내지 않음).
   * "과목/교과" 이름표가 붙은 콤보를 먼저 보고, 없으면 표 밖 콤보·제목 전체에서 찾습니다.
   * 서로 다른 과목이 0개이거나 2개 이상이면 null(막지 않음)
   */
  function screenSubjectLabel(g) {
    const inGrid = (el) => (g.root && g.root.contains(el)) || el.closest('table, [role=grid], .cl-grid')
    const preferred = new Set()
    const all = new Set()
    for (const el of document.querySelectorAll('select, .cl-combobox, [role=combobox]')) {
      if (!visible(el) || inGrid(el) || el.closest(MENU_SEL)) continue
      let text
      if (el.tagName === 'SELECT') text = el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent : ''
      else {
        const inp = el.querySelector('input')
        text = inp ? inp.value : el.textContent
      }
      const found = subjectsIn(text)
      found.forEach((x) => all.add(x))
      if (/과목|교과/.test(norm(nearLabel(el)))) found.forEach((x) => preferred.add(x))
    }
    if (preferred.size === 1) return [...preferred][0]
    for (const el of document.querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="Title"]')) {
      if (visible(el) && !inGrid(el) && !el.closest(MENU_SEL)) subjectsIn(el.textContent).forEach((x) => all.add(x))
    }
    return all.size === 1 ? [...all][0] : null
  }

  // ---------- 저장 ----------
  const btnText = (el) => norm(el.tagName === 'INPUT' ? el.value : el.textContent)
  const BTN_SEL = 'button, [role=button], .cl-button, a, input[type=button], input[type=submit]'
  const DIALOG_SEL = '[role=dialog], [role=alertdialog], .cl-dialog, .cl-messagebox'
  const disabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('cl-disabled')

  function findButtons(root, texts) {
    const els = Array.from(root.querySelectorAll(BTN_SEL)).filter((el) => texts.includes(btnText(el)) && visible(el) && !disabled(el))
    // 같은 버튼의 바깥/안쪽이 모두 걸리면 가장 안쪽 하나만
    return els.filter((el) => !els.some((o) => o !== el && el.contains(o)))
  }

  async function clickSave(root = document) {
    const btns = findButtons(root, ['저장']).filter((b) => !b.closest(DIALOG_SEL))
    if (!btns.length) return { saved: false, confirmed: 0, note: '저장 버튼을 찾지 못했습니다' }
    clickEl(btns[0])
    return waitDialogs()
  }

  /** 저장을 누른 뒤 뜨는 확인 대화상자(최대 3개)를 누릅니다 */
  async function waitDialogs() {
    let confirmed = 0
    let lastAction = Date.now()
    const t0 = Date.now()
    while (Date.now() - t0 < 3000 && confirmed < 3) {
      await sleep(120)
      const dialogs = Array.from(document.querySelectorAll(DIALOG_SEL)).filter(visible)
      let clicked = false
      for (const d of dialogs) {
        const ok = findButtons(d, ['확인', '예', 'OK', 'Yes'])[0]
        if (ok) {
          clickEl(ok)
          confirmed++
          clicked = true
          lastAction = Date.now()
          break
        }
      }
      if (!clicked && confirmed > 0 && Date.now() - lastAction > 800) break
    }
    return { saved: true, confirmed }
  }

  // ---------- 입력 ----------
  let running = false
  let aborted = false
  // 입력 중에 사람이 키를 누르거나 화면을 누르면 멈춥니다 (확장이 보내는 이벤트는 isTrusted가 아님)
  for (const type of ['keydown', 'pointerdown'])
    window.addEventListener(
      type,
      (e) => {
        if (running && e.isTrusted) aborted = true
      },
      true,
    )

  function stop() {
    aborted = true
    return { ok: true, running }
  }

  async function fill(job, onProgress) {
    if (running) return { error: 'busy' }
    if (!job || !Array.isArray(job.rows)) return { error: 'bad-job' }
    running = true
    aborted = false
    try {
      return await fillInner(job, onProgress || (() => {}))
    } finally {
      running = false
    }
  }

  // ---------- 입력 방식 ----------
  // 빈 칸만(empty) · 덮어쓰기(overwrite) · 이어쓰기(append: 1학기 글 뒤에 2학기 글을 붙임)
  const MODES = ['empty', 'overwrite', 'append']
  /** 이어쓰기를 쓰는 화면 (교과평가는 코드, 학기말종합의견은 학기마다 따로 씀) */
  const APPEND_SCREENS = ['행동특성', '자율활동관리', '동아리활동관리', '진로활동관리']
  /** 이어쓰기를 하는 칸: 행동특성 gnrlzOpiCn, 창체 speclActSpablMteCn */
  const APPEND_ROLES = ['behavior', 'note']
  /**
   * 참고용 바이트(한글 3바이트, UTF-8). 넘으면 인식 검사에서 알리기만 하고 막지 않습니다.
   * 학교·지침에 따라 다르므로 필요하면 이 값을 고쳐 쓰세요
   */
  const REFERENCE_BYTES = { 행동특성: 1500, 학생부자료기록: 500, 자율활동관리: 500, 동아리활동관리: 500, 진로활동관리: 500 }
  const byteLen = (s) => new TextEncoder().encode(String(s ?? '')).length
  const cleanJoiner = (j) => (typeof j === 'string' ? j.replace(/\r\n?/g, '\n').slice(0, 10) : ' ')
  /** 이어쓰기 값. 기존 글이 비면 새 글만, 이미 새 글로 끝나면(다시 실행) 건너뜀 */
  function appendValue(existing, text, joiner) {
    const add = String(text ?? '').trim()
    const base = String(existing ?? '').replace(/\s+$/, '')
    if (!norm(base)) return { value: add, skip: null }
    if (norm(add) && norm(base).endsWith(norm(add))) return { value: base, skip: 'already' }
    return { value: base + joiner + add, skip: null }
  }
  /**
   * 자율활동관리 칸: 1학기 글이 빈 줄로 나뉜 구간으로 들어 있음 — 자율·자치활동 구간, 그다음 "(부서명(학년-반)) …"로 시작하는 동아리 구간.
   * 동아리 구간: 괄호로 시작하는 첫 구간(없고 구간이 정확히 둘이면 두 번째). 그 앞은 모두 자율 구간입니다.
   */
  function splitSections(text) {
    const t = String(text ?? '').replace(/^\s+|\s+$/g, '')
    const crlf = /\r\n[ \t]*\r\n/.test(t)
    const sep = crlf ? '\r\n\r\n' : '\n\n'
    const parts = t ? t.split(/(?:\r?\n[ \t]*){2,}/) : []
    let club = parts.findIndex((x) => x.trim().startsWith('('))
    if (club < 0 && parts.length === 2) club = 1
    return {
      sep,
      count: parts.length,
      aut: (club < 0 ? parts : parts.slice(0, club)).join(sep),
      club: club < 0 ? null : parts.slice(club).join(sep),
      hasClubSection: club >= 0 && parts[club].trim().startsWith('('),
    }
  }
  /**
   * 자율활동관리 칸에 넣을 값. aut: 자율 문장, club: 동아리 문장(없으면 '').
   * 이어쓰기면 구간마다 끝에 붙이고(이미 그 문장으로 끝나면 그 구간은 건너뜀), 빈 칸만/덮어쓰기면 "자율\n\n동아리"로 씁니다
   */
  function composeAutonomy(existing, aut, club, mode, joiner) {
    const a = String(aut ?? '').trim()
    const c = String(club ?? '').trim()
    const info = { autAlready: false, clubAlready: false, clubNew: false, skip: null }
    if (mode !== 'append') {
      if (mode === 'empty' && norm(existing)) return { ...info, value: existing, skip: 'not-empty' }
      return { ...info, value: [a, c].filter(Boolean).join('\n\n') }
    }
    const sec = splitSections(existing)
    if (sec.sep === '\r\n\r\n') joiner = joiner.replace(/\r?\n/g, '\r\n') // 기존 글이 CRLF면 이음 줄바꿈도 CRLF
    let autOut = sec.aut
    let clubOut = sec.club
    if (a) {
      const av = appendValue(sec.aut, a, joiner)
      if (av.skip) info.autAlready = true
      else autOut = av.value
    }
    if (c) {
      if (clubOut == null || !norm(clubOut)) {
        clubOut = c
        info.clubNew = !!norm(autOut)
      } else {
        const cv = appendValue(clubOut, c, joiner)
        if (cv.skip) info.clubAlready = true
        else clubOut = cv.value
      }
    }
    const value = [autOut, clubOut].filter((x) => x != null && norm(x)).map((x) => x.replace(/\s+$/, '')).join(sec.sep)
    if ((!a || info.autAlready) && (!c || info.clubAlready)) info.skip = 'already'
    return { ...info, value, sections: sec }
  }
  /** 지금 칸의 글 (DOM 표는 편집 칸의 값) */
  const currentText = (g, r, role) => (isFn(g, 'readValue') ? g.readValue(r, role) : g.readText(r, role))
  const CREATIVE_AREA_SCREENS = ['학생부자료기록', '자율활동관리', '동아리활동관리', '진로활동관리']

  /**
   * 입력 계획 (쓰기 없음): 표 고르기 → 행마다 번호 → 학생·성취기준·영역 맞추기 → 작업 목록.
   * fill과 inspect가 함께 씁니다. 막는 조건(반 섞임·과목 다름·마감·단계 코드 없음)은 blockers에 모읍니다.
   */
  function buildPlan(job) {
    const a = analyze()
    const forced = SCREENS.includes(job.screen) ? job.screen : null
    const c = chooseGrid(forced, a)
    const notes = c.notes.slice()
    const warnings = c.warnings.slice()
    const screen = c.screen
    let mode = MODES.includes(job.mode) ? job.mode : 'empty'
    if (mode === 'append' && SCREENS.includes(screen) && !APPEND_SCREENS.includes(screen)) {
      mode = 'empty'
      notes.push('이어쓰기는 이 화면에서 쓰지 않습니다(교과평가는 단계 코드, 학기말종합의견은 학기마다 따로 씀). 빈 칸만으로 입력합니다.')
    }
    const joiner = cleanJoiner(job.joiner)
    const base = { screen, notes, warnings, k: c.k, knownList: c.knownList, mdiSelected: c.mdiSelected || null, mode, joiner }
    if (c.fatal) return { ...base, fatal: c.fatal }
    if (!SCREENS.includes(screen)) return { ...base, fatal: 'unknown-screen' }
    if (NOT_TARGET[screen]) return { ...base, fatal: 'not-a-target', notes: notes.concat(NOT_TARGET[screen]) }
    const g = c.g
    if (!g) return { ...base, fatal: 'grid-not-found', notes: notes.concat('입력할 표를 찾지 못했습니다. 조회를 누른 뒤 다시 시도하세요.') }
    if (a.cpr.length && g.source === 'dom' && !c.k) notes.push('cpr 표의 열을 찾지 못해 화면(DOM) 방식으로 입력했습니다.')
    const blockers = [] // {error, note}

    // 창체 데이터 → 화면: 자율 → 자율활동관리, 진로 → 진로활동관리, 동아리 → 동아리활동관리 (또는 자율활동관리 칸의 동아리 구간에 이어쓰기)
    const creative = ['자율', '진로', '동아리'].includes(job.creative) ? job.creative : null
    if (creative && CREATIVE_AREA_SCREENS.includes(screen) && !CREATIVE_SCREENS[creative].includes(screen))
      blockers.push({ error: 'area-mismatch', note: `${creative} 데이터는 ${CREATIVE_SCREENS[creative].join(' 또는 ')} 화면에 넣습니다.` })

    const want = new Map()
    for (const r of job.rows) if (r && Number.isInteger(r.student)) want.set(r.student, r)
    // 자율활동관리: 같은 칸의 동아리 구간에 넣을 동아리 문장 (자율 데이터와 함께, 또는 동아리 데이터만)
    const clubText = new Map()
    if (screen === '자율활동관리') {
      if (creative === '동아리') {
        for (const [s, r] of want) clubText.set(s, typeof r.text === 'string' ? r.text : '')
        for (const s of want.keys()) want.set(s, { student: s, text: '' })
      } else if (Array.isArray(job.clubRows))
        for (const r of job.clubRows) if (r && Number.isInteger(r.student) && typeof r.text === 'string' && r.text.trim()) {
          clubText.set(r.student, r.text)
          if (!want.has(r.student)) want.set(r.student, { student: r.student, text: '' })
        }
      if (clubText.size && mode !== 'append')
        blockers.push({ error: 'club-append-only', note: '동아리 문장은 이어쓰기로만 자율활동관리 칸(동아리 구간)에 넣습니다. 입력 방식을 이어쓰기로 바꾸세요.' })
    }

    const single = SINGLE_ROW.includes(screen)
    const n = g.rowCount()

    // 동아리: 여러 반(학년)이 섞인 명단이면 번호가 겹치므로 입력하지 않습니다
    if (screen === '동아리활동관리') {
      for (const role of ['class', 'grade']) {
        if (!g.has(role)) continue
        const vals = new Set()
        for (let r = 0; r < n; r++) {
          // 합계/계 행, 본문에 다시 나온 머리글 행은 빼고 셉니다 (번호가 있고 값에 숫자가 있는 행만)
          if (g.readNumber(r) == null) continue
          const v = norm(g.readText(r, role))
          if (/\d/.test(v)) vals.add(v)
        }
        if (vals.size > 1) {
          blockers.push({ error: 'mixed-classes', note: '여러 반이 섞인 명단입니다. 반을 하나만 조회한 뒤 다시 실행하세요.' })
          break
        }
      }
    }

    // 과목 확인: 화면 데이터(학기말종합의견 sbjtCdNm, 교과평가 sbjtNm) 또는 화면에서 고른 과목이 데이터 과목과 다르면 입력하지 않습니다
    if ((screen === '학기말종합의견' || screen === '교과평가') && job.subject) {
      let label = isFn(g, 'subjectLabel') ? g.subjectLabel() : null
      if (!label && screen === '학기말종합의견') label = screenSubjectLabel(g)
      const wantSubject = stripParen(job.subject)
      if (label && wantSubject && !label.includes(wantSubject) && !wantSubject.includes(label))
        blockers.push({ error: 'subject-mismatch', note: '화면 과목과 데이터 과목이 다름' })
    }

    // 행 → 번호. 여러 행 화면(교과평가·학생부자료기록)만 병합/빈 칸에 앞 번호를 이어 씁니다
    const rowNum = []
    let last = null
    for (let r = 0; r < n; r++) {
      const v = g.readNumber(r)
      if (v != null) last = v
      rowNum.push(single ? v : last)
    }
    const stdKey = (r) => (isFn(g, 'stdKey') ? g.stdKey(r) : rowStdKey(g.readText(r, 'standard')))
    const stdMatch = (r, code) => (isFn(g, 'stdMatch') ? g.stdMatch(r, code) : hasCode(g.readText(r, 'standard'), code))

    // 같은 학생의 같은 칸이 두 번 나오면(다른 반 등) 그 번호는 건너뜀
    // 교과평가: (번호, 성취기준 코드), 학생부자료기록: (번호, 영역), 한 행 화면: 번호
    const ambiguous = new Set()
    const seenKeys = new Set()
    rowNum.forEach((k, r) => {
      if (k == null || !want.has(k)) return
      let key = String(k)
      if (screen === '교과평가') key += '|' + stdKey(r)
      else if (screen === '학생부자료기록') key += '|' + norm(g.readText(r, 'area'))
      if (seenKeys.has(key)) ambiguous.add(k)
      seenKeys.add(key)
    })
    if (ambiguous.size) notes.push(`번호가 여러 곳에 있어 건너뜀: ${[...ambiguous].sort((x, y) => x - y).join(', ')} (반이 다른 학생일 수 있음)`)

    // 작업 목록
    const tasks = [] // {r, student, cells:[{role, value}]}
    const found = new Set()
    const matchedCodes = new Map() // student -> Set(code)
    const pairs = [] // 교과평가: {student, r, std, how: 'code'|'text'|'order'}
    const tRole = targetRole(screen, g)
    if (screen === '교과평가') {
      // 나이스 성취기준 칸에 [6국05-01] 같은 코드가 하나도 없으면(실제 나이스: 내부 코드 "12임…") 본문 → 순서로 맞춥니다
      let codeless
      if (isFn(g, 'hasCodes')) codeless = !g.hasCodes()
      else {
        codeless = true
        for (let r = 0; r < n && codeless; r++) if (CODE_RE.test(normCode(g.readText(r, 'standard')))) codeless = false
      }
      const byStudent = new Map()
      for (let r = 0; r < n; r++) {
        const s = rowNum[r]
        if (s == null || !want.has(s) || ambiguous.has(s)) continue
        found.add(s)
        if (!byStudent.has(s)) byStudent.set(s, [])
        byStudent.get(s).push(r)
      }
      const orderFail = []
      for (const [s, rows] of byStudent) {
        const stds = (want.get(s).standards || []).filter((x) => x && typeof x.code === 'string')
        const usedR = new Set()
        const usedS = new Set()
        const pair = (r, j, how) => {
          usedR.add(r)
          usedS.add(j)
          pairs.push({ student: s, r, std: stds[j], how })
        }
        // 1) 코드
        for (const r of rows) {
          const j = stds.findIndex((x, i) => !usedS.has(i) && stdMatch(r, x.code))
          if (j >= 0) pair(r, j, 'code')
        }
        // 2) 성취기준 본문 (데이터에 본문이 있을 때, 하나로 정해질 때만)
        for (const r of rows) {
          if (usedR.has(r)) continue
          const t = g.readText(r, 'standard')
          const cands = stds.map((_, i) => i).filter((i) => !usedS.has(i) && stds[i].text && sameStdText(t, stds[i].text))
          if (cands.length === 1) pair(r, cands[0], 'text')
        }
        // 3) 순서 (코드가 없는 화면만): 그 학생의 나이스 행 순서 = 데이터 성취기준 순서. 영역이 있으면 영역도 맞아야 함
        if (codeless) {
          const rr = rows.filter((r) => !usedR.has(r))
          const ss = stds.map((_, i) => i).filter((i) => !usedS.has(i))
          if (rr.length && ss.length) {
            let plan = null
            if (rr.length === ss.length) {
              const withArea = ss.every((i) => stds[i].area) && rr.every((r) => norm(g.readText(r, 'area')))
              if (withArea) {
                // 영역마다 순서대로
                const left = rr.slice()
                plan = []
                for (const i of ss) {
                  const at = left.findIndex((r) => sameArea(g.readText(r, 'area'), stds[i].area))
                  if (at < 0) {
                    plan = null
                    break
                  }
                  plan.push([left[at], i])
                  left.splice(at, 1)
                }
              } else {
                plan = rr.map((r, k) => [r, ss[k]])
                if (plan.some(([r, i]) => stds[i].area && norm(g.readText(r, 'area')) && !sameArea(g.readText(r, 'area'), stds[i].area))) plan = null
              }
            }
            if (plan) for (const [r, i] of plan) pair(r, i, 'order')
            else orderFail.push(s)
          }
        }
      }
      pairs.sort((x, y) => x.r - y.r)
      for (const p of pairs) {
        if (!matchedCodes.has(p.student)) matchedCodes.set(p.student, new Set())
        matchedCodes.get(p.student).add(p.std.code)
        const cells = []
        if (g.has('level') && p.std.level) cells.push({ role: 'level', value: p.std.level })
        if (g.has('result') && p.std.criterion) cells.push({ role: 'result', value: p.std.criterion })
        if (cells.length) tasks.push({ r: p.r, student: p.student, cells })
      }
      if (pairs.some((p) => p.how === 'order'))
        notes.push('성취기준을 순서로 맞춤: 나이스 성취기준 칸에 코드가 없어 학생마다 데이터 성취기준 순서대로 짝지었습니다. 인식 검사의 짝 목록으로 확인하세요.')
      if (orderFail.length)
        notes.push(`성취기준 수나 영역이 달라 순서로 맞추지 못한 학생: ${orderFail.sort((x, y) => x - y).join(', ')}번 (그 학생의 성취기준은 넣지 않음)`)
    } else {
      for (let r = 0; r < n; r++) {
        const s = rowNum[r]
        if (s == null || !want.has(s) || ambiguous.has(s)) continue
        const jr = want.get(s)
        found.add(s)
        if (screen === '자율활동관리') {
          const aut = typeof jr.text === 'string' ? jr.text : ''
          const club = clubText.get(s) || ''
          if (aut.trim() || club.trim()) tasks.push({ r, student: s, cells: [{ role: 'note', value: aut, club }] })
        } else if (tRole && typeof jr.text === 'string' && jr.text) tasks.push({ r, student: s, cells: [{ role: tRole, value: jr.text }] })
      }
    }
    if (screen === '학생부자료기록') {
      // 학생은 있는데 해당 영역 행이 없는 경우
      const withArea = new Set(tasks.map((t) => t.student))
      for (const s of [...found]) if (!withArea.has(s)) found.delete(s)
    }

    // 마감된 행(ddlnYn/msDdlnYn = Y)에는 쓰지 않습니다 (하나라도 있으면 전체 거부)
    if (isFn(g, 'closedRow')) {
      const closed = [...new Set(tasks.filter((t) => g.closedRow(t.r)).map((t) => t.student))].sort((x, y) => x - y)
      if (closed.length) blockers.push({ error: 'closed', note: `마감된 학생이 있어 입력하지 않았습니다: ${closed.join(', ')}번` })
    }

    // 단계: 나이스 콤보(cmbLvl) 항목에서 코드를 찾습니다. 쉴 때 항목이 있으면 미리 확인하고 하나라도 없으면 짐작하지 않고 중단.
    // 쉴 때 항목이 비어 있으면(실제 나이스) 입력할 때 행마다 골라 읽습니다. 화면(DOM) 방식은 콤보 글자를 직접 고름
    let levelMissing = []
    if (screen === '교과평가' && (g.source === 'cpr' || g.source === 'cpr-known') && tasks.some((t) => t.cells.some((x) => x.role === 'level'))) {
      levelMissing = isFn(g, 'prepareLevels') ? g.prepareLevels(tasks) : ['(단계 항목을 읽을 수 없음)']
      if (levelMissing.length)
        blockers.push({ error: 'level-code-unknown', note: `단계 코드를 나이스 화면에서 찾지 못했습니다: ${levelMissing.join(', ')}` })
    }

    const missing = [...want.keys()].filter((s) => !found.has(s) && !ambiguous.has(s)).sort((x, y) => x - y)
    const unmatchedStandards = []
    if (screen === '교과평가')
      for (const [s, jr] of want)
        if (found.has(s)) for (const std of jr.standards || []) if (!matchedCodes.get(s)?.has(std.code)) unmatchedStandards.push({ student: s, code: std.code })

    return { ...base, g, blockers, want, found, ambiguous, matchedCodes, pairs, tasks, missing, unmatchedStandards, levelMissing }
  }

  const JOINER_LABEL = { '': '바로 이어서', ' ': '띄어쓰기 한 칸', '\n': '줄바꿈 한 번', '\n\n': '줄바꿈 두 번' }
  const modeLabel = (mode, joiner) =>
    mode === 'append' ? `이어쓰기 · ${JOINER_LABEL[joiner] ?? '직접 입력 "' + joiner.replace(/\n/g, '↵') + '"'}` : mode === 'overwrite' ? '덮어쓰기' : '빈 칸만'

  async function fillInner(job, progress) {
    const p = buildPlan(job)
    const strategy = strategyOf(p.g)
    const empty = { screen: p.screen, strategy, activeApp: p.k ? p.k.id : null, mdiSelected: p.mdiSelected, mode: p.mode, joiner: p.joiner, filled: 0, cells: 0, missing: [], ambiguous: [], unmatchedStandards: [], saved: false, warnings: p.warnings }
    if (p.fatal) return { error: p.fatal, ...empty, missing: p.fatal === 'grid-not-found' ? job.rows.map((r) => r.student) : [], notes: p.notes }
    if (p.blockers.length) {
      const b = p.blockers[0]
      return { error: b.error, ...empty, missing: p.missing, ambiguous: [...p.ambiguous], notes: p.notes.concat([b.note], p.blockers.slice(1).map((x) => x.note)) }
    }
    const { g, tasks, screen, notes, mode, joiner } = p
    let delay = Math.max(0, Math.min(5000, Number(job.delayMs ?? 400) || 0))
    if (g.source === 'cpr-known') delay = Math.min(delay, 20) // 데이터셋 쓰기는 기다릴 필요가 없음 (중지 키는 계속 받음)
    const modifiedBefore = isFn(g, 'modifiedRows') ? g.modifiedRows() : null

    const total = tasks.length
    let done = 0
    let cellsWritten = 0
    let skipped = 0
    let failed = 0
    let levelConflict = 0
    let levelUnavailable = 0
    let already = 0
    let autAlready = 0
    let clubAlready = 0
    const clubNew = new Set()
    const unavailableStudents = new Set()
    const filledStudents = new Set()
    const written = []
    progress({ phase: 'start', done: 0, total, screen })
    for (const t of tasks) {
      if (aborted) break
      let wrote = 0
      let skipResult = false
      for (const c of t.cells) {
        if (c.role === 'result' && skipResult) {
          if (skipResult !== 'unavailable') skipped++
          continue
        }
        let value = c.value
        if (screen === '자율활동관리' && c.role === 'note') {
          // 자율 구간 · 동아리 구간에 따로 이어쓰기 (빈 줄 구분 유지)
          const cv = composeAutonomy(currentText(g, t.r, c.role), c.value, c.club, mode, joiner)
          if (cv.autAlready) autAlready++
          if (cv.clubAlready) clubAlready++
          if (cv.skip === 'already') {
            already++
            continue
          }
          if (cv.skip === 'not-empty') {
            skipped++
            continue
          }
          if (cv.clubNew) clubNew.add(t.student)
          value = cv.value
        } else if (mode === 'append' && APPEND_ROLES.includes(c.role)) {
          // 이어쓰기: 기존 글 + 이음 글 + 새 글 (이미 새 글로 끝나면 다시 붙이지 않음)
          const av = appendValue(currentText(g, t.r, c.role), c.value, joiner)
          if (av.skip) {
            already++
            continue
          }
          value = av.value
        } else if (mode !== 'overwrite' && !g.isEmpty(t.r, c.role)) {
          // 교과평가: 단계를 고르면 나이스가 평가결과를 채울 수 있으므로, 평가결과의 빈 칸 판단은 단계를 쓴 뒤에 합니다
          skipped++
          // 이미 다른 단계가 있으면 그 행의 평가결과는 넣지 않습니다 (다른 단계와 평가결과가 짝지어지지 않게)
          if (c.role === 'level' && isFn(g, 'levelMismatch') && g.levelMismatch(t.r, c.value)) {
            skipResult = 'conflict'
            levelConflict++
          }
          continue
        }
        const res = await g.write(t.r, c.role, value)
        if (res && typeof res === 'object' && res.unavailable) {
          // 이 행의 단계 항목을 읽지 못함: 이 행(단계·평가결과)만 건너뜀
          levelUnavailable++
          unavailableStudents.add(t.student)
          skipResult = 'unavailable'
          continue
        }
        if (res) {
          wrote++
          written.push({ r: t.r, role: c.role, value })
        } else failed++
      }
      if (wrote) {
        cellsWritten += wrote
        filledStudents.add(t.student)
      }
      done++
      progress({ phase: 'row', done, total, current: t.student })
      if (wrote && delay) await sleep(delay)
      else if (g.source === 'cpr-known' && done % 10 === 0) await sleep(0)
    }
    try {
      g.finish()
    } catch {
      // 무시
    }
    const lv = isFn(g, 'levelInfo') ? g.levelInfo() : null

    // 확인: 다시 읽어서 비교
    let verifyFailed = 0
    for (const w of written) if (!g.verify(w.r, w.role, w.value)) verifyFailed++
    if (verifyFailed) notes.push(`입력 후 다시 읽었을 때 다른 칸 ${verifyFailed}개`)
    if (failed) notes.push(`입력하지 못한 칸 ${failed}개`)
    const autoFilled = g.source === 'cpr-known' ? g.autoFilled : 0
    if (autoFilled) notes.push(`단계를 고르자 나이스가 평가결과를 채운 칸 ${autoFilled}개 (${mode === 'overwrite' ? '덮어쓰기: 데이터의 평가결과로 바꿈' : '빈 칸만: 나이스가 채운 글을 그대로 둠'})`)
    if (levelConflict) notes.push(`단계가 이미 있는 행 ${levelConflict}개는 평가결과를 넣지 않았습니다 (빈 칸만: 다른 단계이거나 확인할 수 없음)`)
    if (skipped) notes.push(`이미 내용이 있어 건너뛴 칸 ${skipped}개 (빈 칸만)`)
    if (already) notes.push(`이미 이어져 있음: ${already}칸은 새 글로 끝나 있어 다시 붙이지 않았습니다`)
    if (screen === '자율활동관리' && (autAlready || clubAlready))
      notes.push(`이미 이어져 있음 (구간별): 자율 구간 ${autAlready}칸 · 동아리 구간 ${clubAlready}칸은 건너뛰었습니다`)
    if (clubNew.size) notes.push(`동아리 부서명 괄호가 없어 새 구간으로 추가함: ${[...clubNew].sort((x, y) => x - y).join(', ')}번 (나이스에서 부서명을 확인하세요)`)
    if (levelUnavailable)
      notes.push(`단계 항목을 읽지 못해 건너뛴 행 ${levelUnavailable}개 (학생 ${[...unavailableStudents].sort((x, y) => x - y).join(', ')}번) — 나이스에서 직접 고르세요`)
    if (lv && lv.perRow && lv.how) notes.push(`단계: 행마다 골라 항목을 읽었습니다 (${lv.how === 'focus' ? 'focusCell' : 'selectRows'})`)
    if (lv && lv.liveMoved) notes.push('단계 콤보가 다른 행에 묶여 있어 그 행을 되돌렸고, 이후로는 데이터에만 넣었습니다. 화면에서 확인하세요.')
    if (lv && lv.perRow && lv.restored === false) notes.push('원래 고른 행으로 되돌리지 못했습니다 (입력 내용에는 영향 없음).')
    if (p.missing.length && g.source === 'dom') notes.push('표가 스크롤되면 화면에 보이는 행만 입력됩니다. 아래로 내린 뒤 "빈 칸만"으로 다시 실행하세요.')

    const levelWritten = written.filter((w) => w.role === 'level').length
    const allLevelsFailed = levelUnavailable > 0 && levelWritten === 0 && cellsWritten === 0
    const modifiedRows = isFn(g, 'modifiedRows') ? g.modifiedRows() : null
    const notModified = cellsWritten > 0 && modifiedRows === 0
    if (notModified) notes.push('데이터셋이 변경 상태로 바뀌지 않아 저장해도 반영되지 않을 수 있습니다. 저장은 누르지 않았습니다. 화면에서 확인한 뒤 직접 저장하세요.')

    let saved = false
    let confirmed = 0
    if (aborted) notes.push('중지했습니다. 저장은 누르지 않았습니다.')
    else if (allLevelsFailed) notes.push('단계 항목을 한 행도 읽지 못해 아무것도 넣지 않았습니다.')
    else if (job.save && (verifyFailed > 0 || failed > 0)) notes.push('일부 칸이 확인되지 않아 저장하지 않았습니다. 확인 후 직접 저장하세요.')
    else if (job.save && notModified) {
      // 위 안내
    } else if (job.save && cellsWritten > 0) {
      const s = isFn(g, 'save') ? await g.save() : await clickSave()
      saved = s.saved
      confirmed = s.confirmed
      if (s.note) notes.push(s.note)
    } else if (job.save) notes.push('바뀐 칸이 없어 저장을 누르지 않았습니다.')

    const result = {
      screen,
      strategy,
      activeApp: p.k ? p.k.id : null,
      mode,
      joiner,
      modeLabel: modeLabel(mode, joiner),
      filled: filledStudents.size,
      rows: done,
      cells: cellsWritten,
      skipped,
      already,
      levelConflict,
      levelUnavailable,
      autoFilled,
      verifyFailed,
      failed,
      modifiedBefore,
      modifiedRows,
      missing: p.missing,
      ambiguous: [...p.ambiguous],
      unmatchedStandards: p.unmatchedStandards,
      saved,
      confirmed,
      aborted,
      warnings: p.warnings,
      notes,
    }
    if (allLevelsFailed) result.error = 'level-code-unknown'
    progress({ phase: 'done', done, total })
    return result
  }

  /** 인식 검사 (칸은 바꾸지 않음): 어떤 앱·표를 쓰는지, 학생·성취기준을 몇 개 찾는지, 단계 코드, 글 길이 */
  async function inspect(job) {
    if (!job || !Array.isArray(job.rows)) return { error: 'bad-job' }
    if (running) return { error: 'busy' }
    running = true
    try {
      return await inspectInner(job)
    } finally {
      running = false
    }
  }
  async function inspectInner(job) {
    const p = buildPlan(job)
    const g = p.g
    const out = {
      screen: p.screen,
      strategy: strategyOf(g),
      knownApp: !!g && g.source === 'cpr-known',
      activeApp: p.k ? p.k.id : null,
      mdiSelected: p.mdiSelected,
      datasetRows: p.k ? p.k.rows : null,
      mode: p.mode,
      joiner: p.joiner,
      modeLabel: modeLabel(p.mode, p.joiner),
      knownApps: (p.knownList || []).slice(0, 20).map((k) => ({ id: k.id, screen: k.spec.screen, visible: k.visible, rows: k.rows })),
      studentsFound: 0,
      studentsMissing: [],
      ambiguous: [],
      standardsPerStudent: null,
      unmatchedStandards: [],
      pairing: null,
      pairingHow: null,
      tasks: 0,
      cells: 0,
      levelCodes: null,
      levelProbe: null,
      resultAutoFill: null,
      levelSideColumns: null,
      modifiedRows: null,
      lengths: null,
      referenceBytes: null,
      warnings: p.warnings.slice(),
      notes: p.notes.slice(),
    }
    if (p.fatal) return { ...out, error: p.fatal }
    for (const b of p.blockers) {
      out.warnings.push(b.error)
      out.notes.push(b.note)
    }
    out.studentsFound = p.found.size
    out.studentsMissing = p.missing
    out.ambiguous = [...p.ambiguous]
    out.tasks = p.tasks.length
    out.cells = p.tasks.reduce((n, t) => n + t.cells.length, 0)
    if (isFn(g, 'modifiedRows')) out.modifiedRows = g.modifiedRows()
    if (p.screen === '교과평가') {
      out.standardsPerStudent = Object.fromEntries([...p.found].sort((x, y) => x - y).map((s) => [s, p.matchedCodes.get(s)?.size ?? 0]))
      out.unmatchedStandards = p.unmatchedStandards
      // 짝 목록: 앞 두 학생 (모든 학생이 같은 순서이므로 확인용)
      const firsts = [...new Set(p.pairs.map((x) => x.student))].slice(0, 2)
      out.pairing = p.pairs
        .filter((x) => firsts.includes(x.student))
        .slice(0, 16)
        .map((x) => {
          const text = g.readText(x.r, 'standard')
          return { student: x.student, code: x.std.code, how: x.how, row: x.r, area: cut(oneLine(g.readText(x.r, 'area')), 20), dataArea: x.std.area ? cut(x.std.area, 20) : null, neisLen: text.length, neisText: cut(oneLine(text), 24) }
        })
      out.pairingHow = { code: 0, text: 0, order: 0 }
      for (const x of p.pairs) out.pairingHow[x.how]++
      if (g.perRow && isFn(g, 'probeLevels') && p.tasks.length) {
        // 행을 잠깐 골라 단계 항목을 읽고 원래 선택으로 되돌림 (서로 다른 성취기준 두 행)
        const rows = []
        const keys = new Set()
        for (const t of p.tasks) {
          const key = isFn(g, 'stdKey') ? g.stdKey(t.r) : String(t.r)
          if (keys.has(key)) continue
          keys.add(key)
          rows.push(t.r)
          if (rows.length >= 2) break
        }
        const pr = await g.probeLevels(rows)
        if (pr) {
          out.levelProbe = { restored: pr.restored, rows: pr.rows.map((x) => ({ row: x.row, how: x.how, items: x.items.length })) }
          if (!pr.rows.some((x) => x.items.length)) {
            out.warnings.push('level-code-unknown')
            out.notes.push('행을 골라도 단계 항목이 나오지 않았습니다. 나이스에서 그 성취기준의 평가기준이 등록되어 있는지 확인하세요.')
          } else if (pr.rows.length > 1 && pr.rows[0].items.map((x) => x.value).join() !== pr.rows[1].items.map((x) => x.value).join())
            out.notes.push('단계 항목(코드)이 성취기준마다 다릅니다. 자동 입력 때 행마다 골라 읽습니다.')
        }
      }
      if (isFn(g, 'levelCodes')) out.levelCodes = g.levelCodes()
      if (isFn(g, 'resultAutoFill')) out.resultAutoFill = g.resultAutoFill()
      if (isFn(g, 'levelSideColumns')) out.levelSideColumns = g.levelSideColumns()
    } else {
      // 글 길이: 학생마다 기존 · 새 글 · 합친 바이트 (한글 3바이트). 참고용 바이트를 넘으면 알리기만 함
      const ref = REFERENCE_BYTES[p.screen] ?? null
      out.referenceBytes = ref
      const lens = []
      let nonEmpty = 0
      for (const t of p.tasks) {
        const c = t.cells[0]
        if (!c) continue
        const existing = currentText(g, t.r, c.role)
        if (norm(existing)) nonEmpty++
        if (p.screen === '자율활동관리') {
          // 구간별 길이만 (구간 글자는 보여 주지 않음)
          const cv = composeAutonomy(existing, c.value, c.club, p.mode, p.joiner)
          const sec = cv.sections || splitSections(existing)
          const row = {
            student: t.student,
            sections: sec.count,
            hasClubSection: sec.hasClubSection,
            existing: byteLen(existing),
            autBytes: byteLen(sec.aut),
            clubBytes: byteLen(sec.club || ''),
            add: byteLen(String(c.value || '').trim()),
            addClub: byteLen(String(c.club || '').trim()),
            combined: byteLen(cv.value),
          }
          row.over = ref != null && row.combined > ref
          if (cv.skip) row.state = cv.skip === 'not-empty' ? 'skip' : 'already'
          lens.push(row)
          continue
        }
        let combined
        let state = null
        if (p.mode === 'append' && APPEND_ROLES.includes(c.role)) {
          const av = appendValue(existing, c.value, p.joiner)
          combined = av.value
          if (av.skip) state = 'already'
        } else if (p.mode === 'overwrite' || !norm(existing)) combined = String(c.value)
        else {
          combined = existing
          state = 'skip'
        }
        const row = { student: t.student, existing: byteLen(existing), add: byteLen(String(c.value).trim()), combined: byteLen(combined), over: ref != null && byteLen(combined) > ref }
        if (state) row.state = state
        lens.push(row)
      }
      out.lengths = lens.slice(0, 60)
      const over = lens.filter((x) => x.over).map((x) => x.student)
      if (over.length) {
        out.warnings.push('over-reference-bytes')
        out.notes.push(`참고용 ${ref}바이트를 넘는 학생: ${over.join(', ')}번 (막지 않음 — 나이스에서 글자수를 확인하세요)`)
      }
      if (nonEmpty && p.mode !== 'append' && APPEND_SCREENS.includes(p.screen)) {
        out.warnings.push('target-not-empty')
        out.notes.push(`칸에 이미 글(1학기 등)이 있는 학생 ${nonEmpty}명: ${p.mode === 'overwrite' ? '덮어쓰기면 지워지고 바뀝니다' : '빈 칸만이면 건너뜁니다'}. 2학기 글을 뒤에 붙이려면 이어쓰기를 고르세요.`)
      }
      if (p.screen === '자율활동관리' && p.mode === 'overwrite' && lens.some((x) => x.hasClubSection))
        out.notes.push('덮어쓰기면 칸의 동아리 구간("(부서명…)")도 지워집니다.')
    }
    return out
  }

  // ---------- 구조 수집 ----------
  function sanitizeHeaderHtml(el, labels) {
    if (!el) return null
    const keep = new Set(labels.map(oneLine).filter(Boolean))
    const clone = el.cloneNode(true)
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
    const texts = []
    while (walker.nextNode()) texts.push(walker.currentNode)
    for (const t of texts) {
      const v = oneLine(t.nodeValue)
      if (v && !keep.has(v)) t.nodeValue = '…'
    }
    const SAFE = /^(class|id|role|colspan|rowspan|data-ndid|data-role|data-app|aria-colindex|aria-rowindex|aria-label|tabindex|type)$/
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const at of Array.from(node.attributes)) {
        if (!SAFE.test(at.name)) node.removeAttribute(at.name)
        else if (at.name === 'aria-label' && !keep.has(oneLine(at.value))) node.setAttribute('aria-label', '…')
      }
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') node.removeAttribute('value')
    }
    if (clone.tagName === 'TEXTAREA') clone.textContent = ''
    return clone.outerHTML.slice(0, 20000)
  }

  function domHistogram() {
    const h = {}
    for (const el of document.querySelectorAll('[class*="cl-"]')) {
      const tag = el.tagName.toLowerCase()
      for (const c of el.classList) if (c.startsWith('cl-')) h[tag + '.' + c] = (h[tag + '.' + c] || 0) + 1
    }
    return Object.fromEntries(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 400))
  }

  function domControls() {
    const out = []
    for (const el of document.querySelectorAll('[data-ndid], [class*="cl-"][id]')) {
      const cls = Array.from(el.classList).filter((c) => c.startsWith('cl-')).slice(0, 8)
      out.push({ id: el.id || null, ndid: el.getAttribute('data-ndid'), tag: el.tagName.toLowerCase(), cls })
      if (out.length >= 1500) break
    }
    return out
  }

  function cprControls() {
    const out = []
    for (const app of cprApps()) {
      for (const c of appControls(app)) {
        const style = prop(c, 'style')
        const cls = toArray(call(style, 'getClasses')).map(asStr).filter(Boolean).slice(0, 8)
        const bind = call(c, 'getBindInfo', 'value')
        const bindCol = asStr(prop(bind, 'columnName')) || asStr(prop(bind, 'fieldName')) || null
        out.push({ app: appId(app), id: ctrlId(c), type: ctrlType(c), cls, bind: bindCol })
        if (out.length >= 2000) return out
      }
    }
    return out
  }

  function gridScan(g) {
    const rows = g.rowCount()
    const numbers = []
    if (g.has('number')) for (let r = 0; r < Math.min(3, rows); r++) numbers.push(g.readNumber(r))
    let editable = []
    try {
      editable = g.editableRows()
    } catch {
      editable = []
    }
    return {
      source: g.source,
      appId: g.appId,
      ctrlId: g.id,
      headers: g.headers,
      headerColumns: g.headerColumns,
      roles: g.roles,
      columns: g.columns,
      rowCount: rows,
      numbers,
      editable,
    }
  }

  // --- 2차 구조 수집: API 이름 · 열 정보 · 비개인 열 표본 (개인정보 열은 값 대신 표시만) ---
  const IDENT = /^[A-Za-z_$][\w$]{0,39}$/
  /** 객체의 메서드/속성 이름만 (자기 것 + 프로토타입). 값은 읽지 않습니다 */
  function namesOf(o, cap = 150) {
    const out = new Set()
    try {
      let p = o
      for (let d = 0; p && p !== Object.prototype && p !== Function.prototype && d < 10 && out.size < cap; d++) {
        for (const n of Object.getOwnPropertyNames(p)) {
          if (n === 'constructor' || !IDENT.test(n)) continue
          out.add(n)
          if (out.size >= cap) break
        }
        p = Object.getPrototypeOf(p)
      }
    } catch {
      // 무시
    }
    return [...out]
  }
  /** 숫자·참거짓 속성 값만 (cellCount 등) */
  function scalarProps(o, cap = 40) {
    const out = {}
    if (!o || typeof o !== 'object') return out
    for (const n of namesOf(o, 300)) {
      const v = prop(o, n)
      if (typeof v === 'number' || typeof v === 'boolean') out[n] = v
      if (Object.keys(out).length >= cap) break
    }
    return out
  }
  const cut = (v, n) => (v == null ? null : String(v).slice(0, n))
  const maskCol = (c) => (c && PERSONAL.has(c) ? '[개인정보]' : cut(c, 40) || null)
  const maskHeader = (t) => {
    const s = oneLine(t)
    if (!s) return ''
    if (isNameHeader(s) || norm(s).includes('이름') || PERSONAL.has(s)) return '[개인정보]'
    return s.slice(0, 40)
  }
  const SAMPLE_COLS = ['clsNo', 'grd', 'clsNm', 'sbjtNm', 'sbjtCdNm', 'relmNm', 'sccesCtrCd', 'evlCtrCd', 'evlCtrNm', 'evlLvlCd', 'evlLvlNm', 'actScCd', 'actScNm', 'actScCdGrp', 'actScNm2', 'chk', 'ddlnYn', 'msDdlnYn', 'scrgRfltYn', 'copyEvlRslt', 'obsvExistsYn']
  const LENGTH_COLS = ['gnrlzOpiCn', 'speclActSpablMteCn', 'evlCtrCn', 'sccesCtrCn']

  /** 머리글/본문 열 정보 (성명·개인정보 열 이름은 가림) */
  function gridColsOf(grid) {
    const header = prop(grid, 'header') ?? call(grid, 'getHeader')
    const detail = prop(grid, 'detail') ?? call(grid, 'getDetail')
    const headerCols = []
    const hn = cellCount(header)
    for (let i = 0; i < hn && i < 60; i++) {
      const c = cellAt(header, i)
      if (!c) {
        headerCols.push(null)
        continue
      }
      headerCols.push({
        text: maskHeader(asStr(prop(c, 'text')) || asStr(call(c, 'getText')) || asStr(prop(c, 'value'))),
        columnName: maskCol(asStr(prop(c, 'columnName')) || asStr(call(c, 'getColumnName'))),
        targetColumnName: maskCol(asStr(prop(c, 'targetColumnName')) || asStr(call(c, 'getTargetColumnName'))),
        sortColumnName: maskCol(asStr(prop(c, 'sortColumnName')) || asStr(call(c, 'getSortColumnName'))),
      })
    }
    const detailCols = []
    const dn = cellCount(detail)
    for (let i = 0; i < dn && i < 60; i++) {
      const c = cellAt(detail, i)
      if (!c) {
        detailCols.push(null)
        continue
      }
      const ctl = prop(c, 'control') ?? call(c, 'getControl')
      detailCols.push({
        columnName: maskCol(asStr(prop(c, 'columnName')) || asStr(call(c, 'getColumnName'))),
        controlType: cut(ctl ? ctrlType(ctl) : '', 40) || null,
        controlId: cut(ctl ? ctrlId(ctl) : '', 40) || null,
      })
    }
    return { header, detail, headerCols, detailCols }
  }

  // --- 3차 구조 수집: 데이터 컨트롤 · 범주 열 값 분포 · 단계 콤보 확인 · 알려지지 않은 업무 화면 ---
  /** 이름만 봐도 개인정보일 수 있는 열 (값을 내보내지 않음) */
  const PERSONAL_RE = /flnm|brdt|stdnt|stuInvl|userId|hop|sxds|dptNm|^stu[A-Z]|tchr|user|usr|telno|addr|email|rrn|emp/i
  const isPersonalCol = (c) => PERSONAL.has(c) || PERSONAL_RE.test(c)
  /** 사람 이름처럼 보이는 값 (한글 2~4자, 흔한 성으로 시작, 단계·여부 낱말 제외) */
  const SURNAME_CH = '김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민류나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경사부'
  const NOT_NAMES = new Set(['매우잘함', '잘함', '보통', '노력요함', '임의입력', '전체', '선택', '사용', '미사용', '예', '아니오', '상', '중', '하'])
  const looksLikeName = (v) => {
    const t = String(v ?? '').trim()
    return /^[가-힣]{2,4}$/.test(t) && SURNAME_CH.includes(t[0]) && !NOT_NAMES.has(t)
  }
  /** 코드표처럼 보이는 열 (코드·이름·단계·값·라벨·순번) */
  const CODE_COL_RE = /cd|nm|code|name|lvl|val|label|sn/i
  const DISTINCT_COLS = ['actScCd', 'actScNm', 'actScNm2', 'relmNm', 'sbjtNm', 'sbjtCdNm', 'evlLvlCd', 'evlLvlNm', 'evlCtrCd', 'evlCtrNm', 'scrgRfltYn', 'ddlnYn', 'msDdlnYn', 'chk', 'copyEvlRslt', 'obsvExistsYn']

  /** 데이터셋 하나: id · 종류 · 열 이름 · 행 수. 작은 코드표(≤40행, 개인정보 열 없음)는 값도(60자까지) */
  function dataControlInfo(dc, noRows) {
    const cols = toArray(call(dc, 'getColumnNames')).map(asStr).filter(Boolean)
    const n = call(dc, 'getRowCount')
    const rowCount = typeof n === 'number' ? n : null
    const personal = cols.some(isPersonalCol)
    const out = {
      id: cut(asStr(prop(dc, 'id')) || asStr(call(dc, 'getId')), 40) || null,
      type: cut(asStr(prop(dc, 'type')) || asStr(call(dc, 'getType')), 20) || null,
      columnNames: cols.slice(0, 60).map(maskCol),
      rowCount,
    }
    if (personal) out.personal = true
    if (!noRows && !personal && rowCount != null && rowCount > 0 && rowCount <= 40 && cols.some((c) => CODE_COL_RE.test(c)) && isFn(dc, 'getValue')) {
      const rows = []
      let nameLike = false
      for (let r = 0; r < rowCount && !nameLike; r++) {
        const row = {}
        for (const c of cols.slice(0, 30)) {
          const v = call(dc, 'getValue', r, c)
          const t = v == null ? '' : typeof v === 'object' ? '[객체]' : String(v)
          if (looksLikeName(t)) nameLike = true
          row[c] = cut(t, 60)
        }
        rows.push(row)
      }
      // 사람 이름처럼 보이는 값이 하나라도 있으면 값은 하나도 내보내지 않음
      if (nameLike) out.rowsWithheld = 'name-like'
      else out.rows = rows
    }
    return out
  }
  /** 앱의 데이터 컨트롤 목록 (화면 표의 데이터셋은 값 없이 — 표본은 datasetSample에) */
  function dataControlsOf(app, mainDs) {
    return toArray(call(app, 'getAllDataControls'))
      .filter((o) => o && typeof o === 'object')
      .slice(0, 40)
      .map((dc) => dataControlInfo(dc, dc === mainDs))
  }
  /** 범주 열(영역·과목·단계·마감 등)의 값 분포: 모든 행에서 서로 다른 값 30개까지(40자) + 개수 */
  function distinctOf(ds, colNames) {
    const out = {}
    const n = call(ds, 'getRowCount')
    if (typeof n !== 'number') return out
    for (const c of DISTINCT_COLS) {
      if (!colNames.includes(c)) continue
      const m = new Map()
      for (let r = 0; r < n && r < 5000; r++) {
        const v = call(ds, 'getValue', r, c)
        const s = v == null ? '' : cut(v, 40)
        m.set(s, (m.get(s) || 0) + 1)
      }
      out[c] = { distinct: m.size, values: [...m].slice(0, 30).map(([value, count]) => ({ value, count })) }
    }
    return out
  }
  /** 객체의 글자·숫자 속성 (itemSetConfig 등) */
  function flatScalars(o, cap = 20) {
    if (typeof o === 'string') return cut(o, 80)
    if (!o || typeof o !== 'object') return null
    const out = {}
    for (const n of namesOf(o, 60)) {
      const v = prop(o, n)
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[n] = typeof v === 'string' ? cut(v, 40) : v
      else if (v && typeof v === 'object' && asStr(prop(v, 'id'))) out[n] = '#' + cut(asStr(prop(v, 'id')), 40)
      if (Object.keys(out).length >= cap) break
    }
    return out
  }
  const itemsOut = (items) => items.slice(0, 30).map((x) => ({ label: cut(x.label, 20), value: cut(x.value, 40) }))

  /**
   * 교과평가 단계 콤보 확인 (보이는 교과평가 앱만): 쉴 때 항목 · itemSetConfig · 묶인 데이터셋,
   * 그리고 한 번만 행을 골라(selectRows → focusCell) 항목을 읽은 뒤 원래 선택으로 되돌립니다. 칸은 바꾸지 않습니다.
   */
  async function levelProbeOf(k) {
    const kit = levelKit(k)
    const ctl = call(k.app, 'lookup', k.spec.controls.level)
    const cds = prop(ctl, 'dataSet') ?? call(ctl, 'getDataSet')
    const cdsInfo = () => (cds && typeof cds === 'object' ? dataControlInfo(cds, false) : null)
    const ds = k.ds || cprDataSet(k.grid)
    const keyOf = (r) => normCode(asStr(call(ds, 'getValue', r, k.spec.cols.stdCode)))
    const out = {
      itemSetConfig: flatScalars(prop(ctl, 'itemSetConfig') ?? call(ctl, 'getItemSetConfig')),
      itemsAtRest: itemsOut(kit.itemsNow().items),
      dataSetAtRest: cdsInfo(),
      selectionBefore: null,
      editRowBefore: null,
      rows: [],
      itemsAfterSelect: [],
      restored: false,
    }
    const prev = kit.selection()
    out.selectionBefore = Array.isArray(prev) ? prev.length : null
    const er = call(k.grid, 'getEditRowIndex')
    out.editRowBefore = typeof er === 'number' ? er : null
    const rows = [0]
    const n = Math.min(k.rows, 12)
    for (let r = 1; r < n; r++)
      if (keyOf(r) !== keyOf(0)) {
        rows.push(r)
        break
      }
    let sig = null
    for (const r of rows) {
      if (r >= k.rows) break
      const got = await kit.itemsFor(r, { wait: 600, prevSig: sig })
      if (got.sig) sig = got.sig
      const ctls = kit.controls()
      const detailItems = ctls.length > 1 ? itemsOut(comboItemsOf(ctls[1], k.app)) : 'same'
      out.rows.push({ row: r, how: got.how, items: itemsOut(got.items), detailItems, dataSet: cdsInfo() })
    }
    out.itemsAfterSelect = out.rows[0] ? out.rows[0].items : []
    out.restored = kit.restore(prev)
    return out
  }

  function scanKnownApp(k) {
    const { grid, spec } = k
    const ds = k.ds || cprDataSet(grid)
    const colNames = cprColumnNames(grid)
    const { header, detail, headerCols, detailCols } = gridColsOf(grid)
    let levelComboItems = null
    if (spec.screen === '교과평가') levelComboItems = itemsOut(comboItemsOf(call(k.app, 'lookup', spec.controls.level), k.app))
    const rows = Math.min(3, k.rows)
    const has = (c) => !colNames.length || colNames.includes(c)
    const get = (r, c) => {
      const v = isFn(ds, 'getValue') ? call(ds, 'getValue', r, c) : call(grid, 'getCellValue', r, c)
      return v == null ? '' : String(v)
    }
    const datasetSample = []
    const rowStates = []
    for (let r = 0; r < rows; r++) {
      const row = {}
      for (const c of SAMPLE_COLS) if (colNames.includes(c)) row[c] = cut(get(r, c), 40)
      for (const c of DIGIT_COLS)
        if (colNames.includes(c)) {
          const t = get(r, c).trim()
          row[c] = DIGITS_ONLY.test(t) ? t.slice(0, 20) : t ? '[비숫자]' : ''
        }
      for (const c of LENGTH_COLS) if (colNames.includes(c)) row[c] = `[len=${get(r, c).length}]`
      datasetSample.push(row)
      let st = call(ds, 'getRowState', r)
      if (st === undefined) st = call(call(ds, 'getRow', r), 'getState')
      rowStates.push(typeof st === 'number' || typeof st === 'string' ? cut(st, 20) : st == null ? null : typeof st)
    }
    return {
      id: cut(k.id, 100),
      screen: spec.screen,
      visible: k.visible,
      via: k.via,
      rows: k.rows,
      gridUuid: cut(ctrlUuid(grid), 40) || null,
      missingColumns: Object.values(spec.cols).filter((c) => !has(c)),
      headerProps: scalarProps(header),
      detailProps: scalarProps(detail),
      headerCols,
      detailCols,
      levelComboItems,
      datasetSample,
      rowStates,
      modifiedRows: modifiedRowsOf(ds),
      distinct: k.rows ? distinctOf(ds, colNames) : {},
    }
  }

  /** 알려지지 않은 업무 화면(edu/…) 하나: 표 열 정보 · 데이터 열 · 행 수 · 버튼 · 입력 컨트롤 (한 번의 구조 수집으로 매핑을 더할 수 있게) */
  function scanUnknownApp(app, vis) {
    const ctrls = appControls(app)
    const grids = ctrls.filter(isGridCtrl).slice(0, 6)
    const bindOf = (c) => {
      const b = call(c, 'getBindInfo', 'value')
      return cut(asStr(prop(b, 'columnName')) || asStr(prop(b, 'fieldName')), 40) || null
    }
    return {
      id: cut(appId(app), 100),
      title: (appTitle(app).match(TITLE_PHRASES) || []).map(oneLine).join(' ') || null,
      visible: vis.visible,
      via: vis.via,
      grids: grids.map((g) => {
        const ds = cprDataSet(g)
        const cols = cprColumnNames(g)
        const n = call(ds, 'getRowCount') ?? call(g, 'getRowCount')
        const { headerCols, detailCols } = gridColsOf(g)
        return { id: cut(ctrlId(g), 40), rowCount: typeof n === 'number' ? n : null, columnNames: cols.slice(0, 80).map(maskCol), headerCols, detailCols, distinct: distinctOf(ds, cols), modifiedRows: modifiedRowsOf(ds) }
      }),
      buttons: ctrls.filter((c) => ctrlType(c) === 'button').map((c) => cut(ctrlId(c), 40)).slice(0, 60),
      inputs: ctrls
        .filter((c) => /^(textarea|combobox|inputbox|checkbox|radiobutton|maskeditor|numbereditor|dateinput|output|embeddedapp|tabfolder)$/.test(ctrlType(c)))
        .map((c) => ({ id: cut(ctrlId(c), 40), type: cut(ctrlType(c), 30), bind: maskCol(bindOf(c)) }))
        .filter((x) => x.type !== 'output' || x.bind)
        .slice(0, 80),
      dataControls: dataControlsOf(app, grids.length ? cprDataSet(grids[0]) : null),
    }
  }

  async function scanKnown() {
    const r = resolveActive(null)
    const P = cprPlatform()
    const pick = r.active || r.all.find((k) => k.rows > 0) || r.all[0] || null
    const api = {}
    if (P) api.platform = namesOf(P)
    if (pick) {
      const header = prop(pick.grid, 'header') ?? call(pick.grid, 'getHeader')
      const detail = prop(pick.grid, 'detail') ?? call(pick.grid, 'getDetail')
      api.app = namesOf(pick.app)
      api.container = namesOf(call(pick.app, 'getContainer'))
      api.grid = namesOf(pick.grid)
      api.header = namesOf(header)
      api.detail = namesOf(detail)
      api.headerColumn = namesOf(cellAt(header, 0))
      api.detailColumn = namesOf(cellAt(detail, 0))
      api.dataSet = namesOf(pick.ds || cprDataSet(pick.grid))
      api.button = namesOf(call(pick.app, 'lookup', pick.spec.save))
    }
    const lv = r.all.find((k) => k.spec.screen === '교과평가' && !k.spec.parent) || r.all.find((k) => k.spec.screen === '교과평가')
    if (lv) api.levelCombo = namesOf(call(lv.app, 'lookup', lv.spec.controls.level))
    const mdi = r.mdi && r.mdi.found ? r.mdi : mdiSelected(cprApps())
    if (mdi.ctrl) api.mdi = namesOf(mdi.ctrl)

    // 데이터 컨트롤: 보이는 알려진 앱, 그 바깥 앱, MDI 선택 탭 앱
    const dataControls = []
    if (r.active) {
      const seen = new Set()
      for (const a of [r.active.app, embedParent.get(r.active.app), mdi.app]) {
        if (!a || seen.has(a)) continue
        seen.add(a)
        dataControls.push({ app: cut(appId(a), 100), list: dataControlsOf(a, a === r.active.app ? r.active.ds : null) })
      }
    }
    // 알려지지 않은 업무 화면 (보이거나 MDI 선택 탭 안에 있는 edu/ 앱)
    const unknownApps = []
    for (const app of cprApps()) {
      if (unknownApps.length >= 6) break
      if (!stripInst(appId(app)).startsWith('edu/') || knownSpecOf(app)) continue
      const g0 = appControls(app).find(isGridCtrl)
      const vis = appVisibility(app, g0)
      const inMdi = !!mdi.app && (app === mdi.app || isWithin(app, mdi.app))
      if (vis.visible !== true && !inMdi) continue
      try {
        unknownApps.push(scanUnknownApp(app, vis))
      } catch {
        unknownApps.push({ id: cut(appId(app), 100), error: 'scan-failed' })
      }
    }
    // 교과평가 단계 콤보: 보이는 교과평가 앱일 때만 한 번 행을 골라 봄
    let levelProbe = null
    if (!running && r.active && r.active.spec.screen === '교과평가' && !r.active.spec.parent && r.active.rows > 0) {
      try {
        levelProbe = await levelProbeOf(r.active)
      } catch {
        levelProbe = { error: 'probe-failed' }
      }
    }
    return {
      activeApp: r.active ? cut(r.active.id, 100) : null,
      activeScreen: r.active ? r.active.spec.screen : null,
      how: r.how,
      warnings: r.warnings,
      mdiSelected: mdi.found ? (mdi.app ? cut(appId(mdi.app), 100) || '(이름 없음)' : '(선택 탭 앱 못 읽음)') : null,
      apps: r.all.slice(0, 20).map(scanKnownApp),
      dataControls,
      levelProbe,
      unknownApps,
      api,
    }
  }

  async function scan(args) {
    const maxBytes = Math.min(SCAN_MAX, Math.max(8 * 1024, Number(args && args.maxBytes) || SCAN_MAX))
    const a = analyze()
    const firstDom = a.dom[0]
    let known
    try {
      known = await scanKnown()
    } catch {
      known = { error: 'scan-known-failed' }
    }
    const out = {
      kind: 'sgb-neis-frame-scan',
      engine: VERSION,
      path: cleanPath(),
      top: window.top === window,
      detect: detect(),
      titleScreen: a.titleScreen,
      titles: a.titles,
      cpr: { present: !!cprPlatform(), version: cprVersion() },
      // 앱 제목도 화면 이름 낱말만 (원문 아님)
      apps: cprApps().map((app) => ({ id: appId(app), title: (appTitle(app).match(TITLE_PHRASES) || []).map(oneLine).join(' ') || null })),
      grids: a.grids.slice(0, 30).map(gridScan),
      known,
      controls: cprControls(),
      dom: {
        iframes: document.querySelectorAll('iframe, frame').length,
        ndid: document.querySelectorAll('[data-ndid]').length,
        histogram: domHistogram(),
        controls: domControls(),
        headerHtml: firstDom ? sanitizeHeaderHtml(firstDom.headerRowEl, firstDom.headers) : null,
      },
    }
    const size = () => new TextEncoder().encode(JSON.stringify(out)).length
    const cuts = []
    const shrink = [
      () => (out.dom.controls = out.dom.controls.slice(0, 300)),
      () => (out.controls = out.controls.slice(0, 400)),
      () => (out.dom.histogram = Object.fromEntries(Object.entries(out.dom.histogram).slice(0, 80))),
      () => (out.dom.headerHtml = out.dom.headerHtml ? out.dom.headerHtml.slice(0, 4000) : null),
      () => (out.dom.controls = []),
      () => {
        // 지금 보이는 앱만 남김
        if (Array.isArray(out.known.apps) && out.known.activeApp) out.known.apps = out.known.apps.filter((x) => x.id === out.known.activeApp)
      },
      () => (out.controls = out.controls.slice(0, 100)),
      () => {
        if (out.known.api) for (const k of Object.keys(out.known.api)) out.known.api[k] = out.known.api[k].slice(0, 60)
      },
      () => (out.grids = out.grids.slice(0, 8)),
      () => (out.detect.grids = out.detect.grids.slice(0, 5)),
      () => {
        // 숨은 앱의 값 분포
        if (Array.isArray(out.known.apps)) for (const x of out.known.apps) if (x.id !== out.known.activeApp) x.distinct = {}
      },
      () => {
        if (Array.isArray(out.known.dataControls)) for (const d of out.known.dataControls) d.list = d.list.map(({ rows, ...rest }) => rest)
      },
      () => (out.controls = []),
    ]
    for (const f of shrink) {
      if (size() <= maxBytes) break
      f()
      cuts.push(shrink.indexOf(f))
    }
    if (cuts.length) out.truncated = true
    return out
  }

  // ---------- 메시지 ----------
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return
    const d = event.data
    if (!d || typeof d !== 'object' || typeof d.__sgb !== 'string') return
    const nonce = d.__sgb
    let result
    try {
      switch (d.cmd) {
        case 'ping':
          result = { ok: true, version: VERSION }
          break
        case 'detect':
          result = detect(d.args)
          break
        case 'scan':
          result = await scan(d.args)
          break
        case 'fill':
          result = await fill(d.args, (p) => window.postMessage({ __sgbProgress: nonce, ...p }, '*'))
          break
        case 'inspect':
          result = await inspect(d.args)
          break
        case 'stop':
          result = stop()
          break
        default:
          result = { error: 'unknown-command' }
      }
    } catch (e) {
      result = { error: String(e && e.message ? e.message : e) }
    }
    window.postMessage({ __sgbReply: nonce, result }, '*')
  })

  window.__sgbNeis = Object.freeze({ version: VERSION, detect, scan, fill: (job) => fill(job), inspect, stop })
})()
