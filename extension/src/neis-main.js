// 나이스 화면에서 동작하는 엔진 (MAIN world). window.__sgbNeis = { detect, scan, fill, inspect, stop }
// - 실제 나이스 화면(KNOWN_SCREENS: 앱 id·데이터 열 이름을 실제 구조 수집으로 확인)은 지금 보이는 앱의 데이터셋에 바로 씁니다.
// - 그 밖에는 cpr(eXBuilder6) 그리드 API로, 없거나 열을 못 찾으면 화면(DOM)에서 직접 입력합니다.
// - 성명(이름) 열은 읽지도 내보내지도 않습니다. 네트워크 요청과 eval은 쓰지 않습니다.
// - content script(neis-content.js)와 window.postMessage({__sgb:nonce, cmd, args})로 통신합니다.
;(() => {
  'use strict'
  if (window.__sgbNeis && window.__sgbNeis.version) return

  const VERSION = '0.2.0'
  const SCREENS = ['교과평가', '학기말종합의견', '행동특성', '학생부자료기록', '동아리활동관리', '진로활동관리']
  const SINGLE_ROW = ['학기말종합의견', '행동특성', '동아리활동관리', '진로활동관리']
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

  /** 학생부자료기록 영역 구분 일치 ("자율"은 "자율동아리"와 구분) */
  function areaMatches(text, area) {
    const t = norm(text)
    if (!t) return false
    if (area === '자율') return t.includes('자치') || (t.includes('자율') && !t.includes('동아리'))
    if (area === '진로') return t.includes('진로')
    if (area === '동아리') return t.includes('동아리') && !t.includes('자율동아리')
    return t.includes(norm(area))
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
    const valueFor = (role, value) => {
      if (role !== 'level') return { value, alt: null }
      const items = comboItems(role)
      const hit = items.find((it) => norm(it.label) === norm(value)) || items.find((it) => norm(it.value) === norm(value))
      return hit ? { value: hit.value, alt: hit.label } : { value, alt: null }
    }
    return {
      source: 'cpr',
      appId: appId(app),
      id: ctrlId(grid),
      headers,
      headerColumns: info.map((h) => h.column || null),
      columns: cprColumnNames(grid),
      roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.column])),
      has: (role) => !!roles[role],
      rowCount,
      readNumber: (r) => lastInt(raw(r, 'number')),
      readText: (r, role) => raw(r, role),
      isEmpty: (r, role) => norm(raw(r, role)) === '',
      async write(r, role, value) {
        if (!roles[role] || role === 'name' || role === 'number' || PERSONAL.has(roles[role].column)) return false
        const col = roles[role].column
        const { value: v } = valueFor(role, value)
        if (isFn(grid, 'setCellValue')) call(grid, 'setCellValue', r, col, v)
        else if (isFn(ds, 'setValue')) call(ds, 'setValue', r, col, v)
        else return false
        return true
      },
      verify(r, role, value) {
        const got = norm(raw(r, role))
        const { value: v, alt } = valueFor(role, value)
        return got === norm(v) || (alt != null && got === norm(alt)) || got === norm(value)
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
    for (const app of cprApps()) {
      const known = !!knownSpecOf(app)
      for (const c of appControls(app)) {
        if (!isGridCtrl(c)) continue
        // 다른 MDI 탭에 숨어 있는 앱의 표는 쓰지 않습니다 (알려진 화면은 보이는 것이 확인될 때만)
        const v = ctrlVisibility(c)
        if (v.visible === false || (known && v.visible !== true)) continue
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
      cols: { number: 'clsNo', area: 'actScNm', note: 'speclActSpablMteCn' },
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
    if (uuid) {
      try {
        const e = document.querySelector(`[data-ndid="${cssEsc(uuid)}"]`) || document.getElementById(uuid)
        if (e) return { el: e, via: 'uuid' }
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
      res.active = a
      res.how = how
    }
    return res
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
    let numberCol = spec.cols.number && hasCol(spec.cols.number) ? spec.cols.number : null
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
    const has = (role) => (role === 'number' ? !!(numberCol || digitCol) : hasCol(spec.cols[role]))

    // --- 단계 콤보(cmbLvl) 항목: 글자(매우잘함…) → 나이스 코드 ---
    function comboItemsOf(ctl) {
      if (!ctl) return []
      let items = toArray(call(ctl, 'getItems'))
      if (!items.length) {
        const n = call(ctl, 'getItemCount') ?? prop(ctl, 'itemCount')
        if (typeof n === 'number') for (let i = 0; i < n && i < 50; i++) items.push(call(ctl, 'getItem', i))
      }
      let out = items
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({ label: asStr(prop(it, 'label')) || asStr(call(it, 'getLabel')), value: asStr(prop(it, 'value')) || asStr(call(it, 'getValue')) }))
      if (!out.length) {
        // 데이터셋에 묶인 항목 (itemset)
        const cfg = call(ctl, 'getItemSetConfig') ?? prop(ctl, 'itemSetConfig') ?? prop(ctl, 'itemset')
        if (cfg && typeof cfg === 'object') {
          let ids = prop(cfg, 'dataSet') ?? prop(cfg, 'dataset') ?? prop(cfg, 'datasetId') ?? prop(cfg, 'dataSetId')
          if (typeof ids === 'string') ids = call(app, 'lookup', ids)
          const lc = asStr(prop(cfg, 'label')) || asStr(prop(cfg, 'labelColumn'))
          const vc = asStr(prop(cfg, 'value')) || asStr(prop(cfg, 'valueColumn'))
          const n = call(ids, 'getRowCount')
          if (lc && vc && typeof n === 'number')
            for (let i = 0; i < n && i < 50; i++) out.push({ label: asStr(call(ids, 'getValue', i, lc)), value: asStr(call(ids, 'getValue', i, vc)) })
        }
      }
      return out.filter((x) => x.label || x.value).slice(0, 50)
    }
    function levelControls() {
      const out = []
      const byId = spec.controls && spec.controls.level ? call(app, 'lookup', spec.controls.level) : null
      if (byId) out.push(byId)
      const detail = prop(grid, 'detail') ?? call(grid, 'getDetail')
      const n = cellCount(detail)
      for (let i = 0; i < n && i < 100; i++) {
        const c = cellAt(detail, i)
        const col = asStr(prop(c, 'columnName')) || asStr(call(c, 'getColumnName'))
        if (col !== spec.cols.level) continue
        const ctl = prop(c, 'control') ?? call(c, 'getControl')
        if (ctl && !out.includes(ctl)) out.push(ctl)
      }
      return out
    }
    function levelMapNow() {
      const m = new Map()
      for (const ctl of levelControls()) for (const it of comboItemsOf(ctl)) if (it.label && !m.has(norm(it.label))) m.set(norm(it.label), { label: oneLine(it.label), value: it.value })
      return m
    }
    function selectRow(r) {
      for (const f of ['selectRow', 'setSelectedRowIndex', 'focusRow', 'focusCell']) {
        if (isFn(grid, f)) {
          call(grid, f, r)
          return true
        }
      }
      return false
    }
    let levelMap = null
    const rowCodes = new Map() // 행 → 단계 코드 (미리 정함)
    /** 단계 글자 → 코드. 항목이 행마다 다르면 그 행을 골라 다시 읽습니다. 없으면 null (짐작하지 않음) */
    function levelCodeFor(r, label) {
      if (!levelMap) levelMap = levelMapNow()
      let hit = levelMap.get(norm(label))
      if (!hit && selectRow(r)) {
        const m = levelMapNow()
        hit = m.get(norm(label))
        if (m.size && !levelMap.size) levelMap = m
      }
      return hit ? hit.value : null
    }

    const area = (r) => rd(r, spec.cols.area)
    const resultCol = spec.cols.result
    let autoFilled = 0

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
      /** 성취기준: 코드 열(sccesCtrCd)에서 먼저, 없으면 성취기준 글자(sccesCtrCn)에서 */
      stdMatch: (r, code) => hasCode(rd(r, spec.cols.stdCode), code) || hasCode(rd(r, spec.cols.standard), code),
      stdKey(r) {
        const c = normCode(rd(r, spec.cols.stdCode))
        return c || rowStdKey(rd(r, spec.cols.standard))
      },
      isEmpty: (r, role) => norm(rd(r, colOf(role))) === '',
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
      /** 단계 코드를 미리 정합니다. 못 찾은 글자 목록을 돌려줌 */
      prepareLevels(tasks) {
        const missing = new Set()
        for (const t of tasks)
          for (const c of t.cells) {
            if (c.role !== 'level') continue
            const code = levelCodeFor(t.r, c.value)
            if (code == null || code === '') missing.add(oneLine(c.value))
            else rowCodes.set(t.r + '|' + norm(c.value), code)
          }
        return [...missing]
      },
      /** 인식 검사용: {글자: 코드} 또는 null */
      levelCodes(tasks) {
        if (!has('level')) return null
        if (!levelMap) levelMap = levelMapNow()
        if (!levelMap.size && tasks && tasks.length) levelCodeFor(tasks[0].r, LEVEL_LABELS[0])
        if (!levelMap || !levelMap.size) return null
        return Object.fromEntries([...levelMap.values()].slice(0, 20).map((x) => [x.label, x.value]))
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
      async write(r, role, value) {
        if (!WRITE_ROLES.includes(role)) return false
        const col = colOf(role)
        if (!col || PERSONAL.has(col) || !hasCol(col)) return false
        let v = value
        let before = null
        if (role === 'level') {
          v = rowCodes.get(r + '|' + norm(value)) ?? levelCodeFor(r, value)
          if (v == null || v === '') return false
          before = rd(r, resultCol)
        }
        try {
          if (isFn(ds, 'setValue')) ds.setValue(r, col, v)
          else if (isFn(grid, 'setCellValue')) grid.setCellValue(r, col, v)
          else return false
        } catch {
          return false
        }
        if (role === 'level' && resultCol) {
          const after = rd(r, resultCol)
          if (after !== before && norm(after) !== '') autoFilled++
        }
        return true
      },
      verify(r, role, value) {
        const got = norm(rd(r, colOf(role)))
        if (role === 'level') {
          const want = rowCodes.get(r + '|' + norm(value)) ?? (levelMap && levelMap.get(norm(value)) ? levelMap.get(norm(value)).value : '')
          return got !== '' && got === norm(want)
        }
        return got === norm(value)
      },
      finish() {
        call(grid, 'redraw')
      },
      editableRows: () => [],
      async save() {
        const btn = spec.save ? call(app, 'lookup', spec.save) : null
        if (btn && prop(btn, 'enabled') !== false) {
          if (isFn(btn, 'click')) {
            try {
              btn.click()
              return waitDialogs()
            } catch {
              // 아래 DOM 방식
            }
          }
          const e = elementOf(btn)
          if (e && visible(e.el)) {
            clickEl(e.el)
            return waitDialogs()
          }
        }
        return clickSave()
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
   * 입력할 표 고르기. 알려진 나이스 화면이 보이면 그 앱의 데이터셋(cpr-known), 아니면 1차 방식(cpr 그리드/DOM).
   * forced: 팝업의 "화면 지정" (있으면 그 화면만)
   */
  function chooseGrid(forced, a) {
    const warnings = []
    const notes = []
    const kr = resolveActive(null)
    let kres = kr
    if (forced && (!kr.active || kr.active.spec.screen !== forced)) kres = resolveActive(forced)
    for (const w of kr.warnings.concat(kres === kr ? [] : kres.warnings)) if (!warnings.includes(w)) warnings.push(w)
    const k = kres.active
    let kg = null
    if (k) {
      try {
        kg = makeKnownGrid(k)
      } catch {
        kg = null
      }
      if (kg && !kg.usable(k.spec.screen)) {
        warnings.push('known-columns-missing')
        notes.push('나이스 화면의 데이터 열을 찾지 못해 다른 방식으로 입력합니다.')
        kg = null
      }
    }
    const detectedScreen = kr.active ? kr.active.spec.screen : a.screen
    const screen = forced || detectedScreen
    const g = kg || (SCREENS.includes(screen) ? pickGrid(screen, a) : null)
    return { screen, detectedScreen, g, k, knownList: kr.all, warnings, notes }
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
      forced: !!forced,
      running,
      ready: !!g,
      strategy: strategyOf(g),
      knownApp: !!g && g.source === 'cpr-known',
      activeApp: c.k ? c.k.id : null,
      datasetRows: c.k ? c.k.rows : null,
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

  async function clickSave() {
    const btns = findButtons(document, ['저장']).filter((b) => !b.closest(DIALOG_SEL))
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
  window.addEventListener(
    'keydown',
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
    const base = { screen, notes, warnings, k: c.k, knownList: c.knownList }
    if (!SCREENS.includes(screen)) return { ...base, fatal: 'unknown-screen' }
    const g = c.g
    if (!g) return { ...base, fatal: 'grid-not-found', notes: notes.concat('입력할 표를 찾지 못했습니다. 조회를 누른 뒤 다시 시도하세요.') }
    if (a.cpr.length && g.source === 'dom' && !c.k) notes.push('cpr 표의 열을 찾지 못해 화면(DOM) 방식으로 입력했습니다.')
    const blockers = [] // {error, note}

    const want = new Map()
    for (const r of job.rows) if (r && Number.isInteger(r.student)) want.set(r.student, r)

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
    const tRole = targetRole(screen, g)
    for (let r = 0; r < n; r++) {
      const s = rowNum[r]
      if (s == null || !want.has(s) || ambiguous.has(s)) continue
      const jr = want.get(s)
      if (screen === '교과평가') {
        const std = (jr.standards || []).find((x) => stdMatch(r, x.code))
        found.add(s)
        if (!std) continue
        if (!matchedCodes.has(s)) matchedCodes.set(s, new Set())
        matchedCodes.get(s).add(std.code)
        const cells = []
        if (g.has('level') && std.level) cells.push({ role: 'level', value: std.level })
        if (g.has('result') && std.criterion) cells.push({ role: 'result', value: std.criterion })
        if (cells.length) tasks.push({ r, student: s, cells })
      } else if (screen === '학생부자료기록') {
        const area = job.area || '자율'
        found.add(s)
        if (!areaMatches(g.readText(r, 'area'), area)) continue
        if (typeof jr.text === 'string' && jr.text) tasks.push({ r, student: s, cells: [{ role: 'note', value: jr.text }] })
      } else {
        found.add(s)
        if (tRole && typeof jr.text === 'string' && jr.text) tasks.push({ r, student: s, cells: [{ role: tRole, value: jr.text }] })
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

    // 단계: 나이스 콤보(cmbLvl) 항목에서 코드를 찾습니다. 하나라도 없으면 짐작하지 않고 중단
    let levelMissing = []
    if (screen === '교과평가' && isFn(g, 'prepareLevels')) {
      levelMissing = g.prepareLevels(tasks)
      if (levelMissing.length)
        blockers.push({ error: 'level-code-unknown', note: `단계 코드를 나이스 화면에서 찾지 못했습니다: ${levelMissing.join(', ')}` })
    }

    const missing = [...want.keys()].filter((s) => !found.has(s) && !ambiguous.has(s)).sort((x, y) => x - y)
    const unmatchedStandards = []
    if (screen === '교과평가')
      for (const [s, jr] of want)
        if (found.has(s)) for (const std of jr.standards || []) if (!matchedCodes.get(s)?.has(std.code)) unmatchedStandards.push({ student: s, code: std.code })

    return { ...base, g, blockers, want, found, ambiguous, matchedCodes, tasks, missing, unmatchedStandards, levelMissing }
  }

  async function fillInner(job, progress) {
    const p = buildPlan(job)
    const strategy = strategyOf(p.g)
    const empty = { screen: p.screen, strategy, filled: 0, cells: 0, missing: [], ambiguous: [], unmatchedStandards: [], saved: false }
    if (p.fatal) return { error: p.fatal, ...empty, missing: p.fatal === 'grid-not-found' ? job.rows.map((r) => r.student) : [], notes: p.notes }
    if (p.blockers.length) {
      const b = p.blockers[0]
      return { error: b.error, ...empty, missing: p.missing, ambiguous: [...p.ambiguous], notes: [b.note].concat(p.blockers.slice(1).map((x) => x.note)) }
    }
    const { g, tasks, screen, notes } = p
    const mode = job.mode === 'overwrite' ? 'overwrite' : 'empty'
    let delay = Math.max(0, Math.min(5000, Number(job.delayMs ?? 400) || 0))
    if (g.source === 'cpr-known') delay = Math.min(delay, 20) // 데이터셋 쓰기는 기다릴 필요가 없음 (중지 키는 계속 받음)

    const total = tasks.length
    let done = 0
    let cellsWritten = 0
    let skipped = 0
    let failed = 0
    const filledStudents = new Set()
    const written = []
    progress({ phase: 'start', done: 0, total, screen })
    for (const t of tasks) {
      if (aborted) break
      let wrote = 0
      for (const c of t.cells) {
        // 교과평가: 단계를 고르면 나이스가 평가결과를 채울 수 있으므로, 평가결과의 빈 칸 판단은 단계를 쓴 뒤에 합니다
        if (mode === 'empty' && !g.isEmpty(t.r, c.role)) {
          skipped++
          continue
        }
        const ok = await g.write(t.r, c.role, c.value)
        if (ok) {
          wrote++
          written.push({ r: t.r, role: c.role, value: c.value })
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

    // 확인: 다시 읽어서 비교
    let verifyFailed = 0
    for (const w of written) if (!g.verify(w.r, w.role, w.value)) verifyFailed++
    if (verifyFailed) notes.push(`입력 후 다시 읽었을 때 다른 칸 ${verifyFailed}개`)
    if (failed) notes.push(`입력하지 못한 칸 ${failed}개`)
    const autoFilled = g.source === 'cpr-known' ? g.autoFilled : 0
    if (autoFilled) notes.push(`단계를 고르자 나이스가 평가결과를 채운 칸 ${autoFilled}개 (${mode === 'overwrite' ? '덮어쓰기: 데이터의 평가결과로 바꿈' : '빈 칸만: 나이스가 채운 글을 그대로 둠'})`)
    if (skipped) notes.push(`이미 내용이 있어 건너뛴 칸 ${skipped}개 (빈 칸만)`)
    if (p.missing.length && g.source === 'dom') notes.push('표가 스크롤되면 화면에 보이는 행만 입력됩니다. 아래로 내린 뒤 "빈 칸만"으로 다시 실행하세요.')

    let saved = false
    let confirmed = 0
    if (aborted) notes.push('중지했습니다. 저장은 누르지 않았습니다.')
    else if (job.save && (verifyFailed > 0 || failed > 0)) notes.push('일부 칸이 확인되지 않아 저장하지 않았습니다. 확인 후 직접 저장하세요.')
    else if (job.save && cellsWritten > 0) {
      const s = isFn(g, 'save') ? await g.save() : await clickSave()
      saved = s.saved
      confirmed = s.confirmed
      if (s.note) notes.push(s.note)
    } else if (job.save) notes.push('바뀐 칸이 없어 저장을 누르지 않았습니다.')

    const result = {
      screen,
      strategy,
      activeApp: p.k ? p.k.id : null,
      filled: filledStudents.size,
      rows: done,
      cells: cellsWritten,
      skipped,
      autoFilled,
      verifyFailed,
      failed,
      missing: p.missing,
      ambiguous: [...p.ambiguous],
      unmatchedStandards: p.unmatchedStandards,
      saved,
      confirmed,
      aborted,
      notes,
    }
    progress({ phase: 'done', done, total })
    return result
  }

  /** 인식 검사 (쓰기 없음): 어떤 앱·표를 쓰는지, 학생·성취기준을 몇 개 찾는지, 단계 코드 */
  function inspect(job) {
    if (!job || !Array.isArray(job.rows)) return { error: 'bad-job' }
    if (running) return { error: 'busy' }
    const p = buildPlan(job)
    const g = p.g
    const out = {
      screen: p.screen,
      strategy: strategyOf(g),
      knownApp: !!g && g.source === 'cpr-known',
      activeApp: p.k ? p.k.id : null,
      datasetRows: p.k ? p.k.rows : null,
      knownApps: (p.knownList || []).slice(0, 20).map((k) => ({ id: k.id, screen: k.spec.screen, visible: k.visible, rows: k.rows })),
      studentsFound: 0,
      studentsMissing: [],
      ambiguous: [],
      standardsPerStudent: null,
      unmatchedStandards: [],
      tasks: 0,
      cells: 0,
      levelCodes: null,
      resultAutoFill: null,
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
    if (p.screen === '교과평가') {
      out.standardsPerStudent = Object.fromEntries([...p.found].sort((x, y) => x - y).map((s) => [s, p.matchedCodes.get(s)?.size ?? 0]))
      out.unmatchedStandards = p.unmatchedStandards
      if (isFn(g, 'levelCodes')) out.levelCodes = g.levelCodes(p.tasks)
      if (isFn(g, 'resultAutoFill')) out.resultAutoFill = g.resultAutoFill()
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

  function scanKnownApp(k) {
    const { grid, spec, app } = k
    const ds = k.ds || cprDataSet(grid)
    const colNames = cprColumnNames(grid)
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
    let levelComboItems = null
    if (spec.screen === '교과평가') {
      const ctl = call(app, 'lookup', spec.controls.level)
      let items = toArray(call(ctl, 'getItems'))
      if (!items.length) {
        const n = call(ctl, 'getItemCount') ?? prop(ctl, 'itemCount')
        if (typeof n === 'number') for (let i = 0; i < n && i < 30; i++) items.push(call(ctl, 'getItem', i))
      }
      levelComboItems = items
        .filter((it) => it && typeof it === 'object')
        .slice(0, 30)
        .map((it) => ({ label: cut(asStr(prop(it, 'label')) || asStr(call(it, 'getLabel')), 20), value: cut(asStr(prop(it, 'value')) || asStr(call(it, 'getValue')), 40) }))
    }
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
          row[c] = DIGITS_ONLY.test(t) ? t.slice(0, 20) : `[비숫자 len=${t.length}]`
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
    }
  }

  function scanKnown() {
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
    return {
      activeApp: r.active ? cut(r.active.id, 100) : null,
      activeScreen: r.active ? r.active.spec.screen : null,
      how: r.how,
      warnings: r.warnings,
      mdiSelected: mdi.found ? (mdi.app ? cut(appId(mdi.app), 100) || '(이름 없음)' : '(선택 탭 앱 못 읽음)') : null,
      apps: r.all.slice(0, 20).map(scanKnownApp),
      api,
    }
  }

  function scan(args) {
    const maxBytes = Math.min(SCAN_MAX, Math.max(8 * 1024, Number(args && args.maxBytes) || SCAN_MAX))
    const a = analyze()
    const firstDom = a.dom[0]
    let known
    try {
      known = scanKnown()
    } catch (e) {
      known = { error: String(e && e.message ? e.message : e).slice(0, 200) }
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
          result = scan(d.args)
          break
        case 'fill':
          result = await fill(d.args, (p) => window.postMessage({ __sgbProgress: nonce, ...p }, '*'))
          break
        case 'inspect':
          result = inspect(d.args)
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
