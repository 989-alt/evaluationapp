// 나이스 화면에서 동작하는 엔진 (MAIN world). window.__sgbNeis = { detect, scan, fill, stop }
// - cpr(eXBuilder6) 런타임이 있으면 그리드 API로, 없거나 열을 못 찾으면 화면(DOM)에서 직접 입력합니다.
// - 성명(이름) 열은 읽지도 내보내지도 않습니다. 네트워크 요청과 eval은 쓰지 않습니다.
// - content script(neis-content.js)와 window.postMessage({__sgb:nonce, cmd, args})로 통신합니다.
;(() => {
  'use strict'
  if (window.__sgbNeis && window.__sgbNeis.version) return

  const VERSION = '0.1.0'
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
        if (inner && inner !== out[i] && isFn(inner, 'getContainer')) add(inner)
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
      const v = call(grid, 'getCellValue', r, col) ?? call(ds, 'getValue', r, col)
      return v == null ? '' : String(v)
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
        if (!roles[role] || role === 'name') return false
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
      for (const c of appControls(app)) {
        if (!isGridCtrl(c)) continue
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
      const headerRowEl = headEls[0].closest('[role=row], [class*="row"]') || headEls[0].parentElement
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

  function pageTitles() {
    const out = []
    const push = (t) => {
      t = oneLine(t)
      if (t && t.length <= 40 && !out.includes(t)) out.push(t)
    }
    try {
      for (const app of cprApps()) push(appTitle(app))
    } catch {
      // 무시
    }
    const sel = 'h1, h2, h3, h4, [role=heading], [class*="title"], [class*="Title"], [class*="tit"], [role=tab][aria-selected="true"], .cl-tabfolder-item.cl-selected, .cl-selected'
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
    if (g.has('note') && hs.some((h) => h.includes('영역구분'))) return '학생부자료기록'
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

  function detect() {
    const a = analyze()
    const g = a.screen !== 'unknown' ? pickGrid(a.screen, a) : null
    return {
      screen: a.screen,
      ready: !!g,
      strategy: g ? (g.source === 'cpr' ? 'cpr' : 'dom') : null,
      rows: g ? g.rowCount() : 0,
      cpr: !!cprPlatform(),
      cprVersion: cprVersion(),
      apps: cprApps().length,
      titles: a.titles.slice(0, 5),
      grids: a.grids.slice(0, 20).map(gridSummary),
      path: location.pathname,
    }
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

  async function fillInner(job, progress) {
    const notes = []
    const a = analyze()
    const screen = SCREENS.includes(job.screen) ? job.screen : a.screen
    if (!SCREENS.includes(screen)) return { error: 'unknown-screen', screen, filled: 0, missing: [], unmatchedStandards: [], saved: false, notes }
    let g = pickGrid(screen, a)
    if (!g) return { error: 'grid-not-found', screen, filled: 0, missing: job.rows.map((r) => r.student), unmatchedStandards: [], saved: false, notes: ['입력할 표를 찾지 못했습니다. 조회를 누른 뒤 다시 시도하세요.'] }
    if (a.cpr.length && g.source !== 'cpr') notes.push('cpr 표의 열을 찾지 못해 화면(DOM) 방식으로 입력했습니다.')
    const mode = job.mode === 'overwrite' ? 'overwrite' : 'empty'
    const delay = Math.max(0, Math.min(5000, Number(job.delayMs ?? 400) || 0))

    const want = new Map()
    for (const r of job.rows) if (r && Number.isInteger(r.student)) want.set(r.student, r)

    // 행 → 번호 (병합/빈 칸은 앞 번호를 이어 씀)
    const n = g.rowCount()
    const rowNum = []
    let last = null
    for (let r = 0; r < n; r++) {
      const v = g.readNumber(r)
      if (v != null) last = v
      rowNum.push(last)
    }

    // 한 학생 한 행 화면에서 번호가 여러 행이면(다른 반 등) 건너뜀
    const ambiguous = new Set()
    if (SINGLE_ROW.includes(screen)) {
      const cnt = new Map()
      rowNum.forEach((k) => k != null && cnt.set(k, (cnt.get(k) || 0) + 1))
      for (const [k, c] of cnt) if (c > 1 && want.has(k)) ambiguous.add(k)
      if (ambiguous.size) notes.push(`번호가 여러 행에 있어 건너뜀: ${[...ambiguous].join(', ')} (반이 다른 학생일 수 있음)`)
    }

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
        const stdText = g.readText(r, 'standard')
        const std = (jr.standards || []).find((x) => hasCode(stdText, x.code))
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
    if (skipped) notes.push(`이미 내용이 있어 건너뛴 칸 ${skipped}개 (빈 칸만)`)

    const missing = [...want.keys()].filter((s) => !found.has(s) && !ambiguous.has(s)).sort((x, y) => x - y)
    const unmatchedStandards = []
    if (screen === '교과평가')
      for (const [s, jr] of want)
        if (found.has(s)) for (const std of jr.standards || []) if (!matchedCodes.get(s)?.has(std.code)) unmatchedStandards.push({ student: s, code: std.code })
    if (missing.length && g.source !== 'cpr') notes.push('표가 스크롤되면 화면에 보이는 행만 입력됩니다. 아래로 내린 뒤 "빈 칸만"으로 다시 실행하세요.')

    let saved = false
    let confirmed = 0
    if (aborted) notes.push('중지했습니다. 저장은 누르지 않았습니다.')
    else if (job.save && cellsWritten > 0) {
      const s = await clickSave()
      saved = s.saved
      confirmed = s.confirmed
      if (s.note) notes.push(s.note)
    } else if (job.save) notes.push('바뀐 칸이 없어 저장을 누르지 않았습니다.')

    const result = {
      screen,
      strategy: g.source === 'cpr' ? 'cpr' : 'dom',
      filled: filledStudents.size,
      rows: done,
      cells: cellsWritten,
      skipped,
      verifyFailed,
      missing,
      ambiguous: [...ambiguous],
      unmatchedStandards,
      saved,
      confirmed,
      aborted,
      notes,
    }
    progress({ phase: 'done', done, total })
    return result
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

  function scan(args) {
    const maxBytes = Math.min(SCAN_MAX, Math.max(8 * 1024, Number(args && args.maxBytes) || SCAN_MAX))
    const a = analyze()
    const firstDom = a.dom[0]
    const out = {
      kind: 'sgb-neis-frame-scan',
      engine: VERSION,
      path: location.pathname,
      top: window.top === window,
      detect: detect(),
      titles: a.titles,
      cpr: { present: !!cprPlatform(), version: cprVersion() },
      apps: cprApps().map((app) => ({ id: appId(app), title: appTitle(app) })),
      grids: a.grids.slice(0, 30).map(gridScan),
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
    const cut = []
    const shrink = [
      () => (out.dom.controls = out.dom.controls.slice(0, 300)),
      () => (out.controls = out.controls.slice(0, 400)),
      () => (out.dom.histogram = Object.fromEntries(Object.entries(out.dom.histogram).slice(0, 80))),
      () => (out.dom.headerHtml = out.dom.headerHtml ? out.dom.headerHtml.slice(0, 4000) : null),
      () => (out.dom.controls = []),
      () => (out.controls = out.controls.slice(0, 100)),
      () => (out.grids = out.grids.slice(0, 8)),
      () => (out.detect.grids = out.detect.grids.slice(0, 5)),
    ]
    for (const f of shrink) {
      if (size() <= maxBytes) break
      f()
      cut.push(shrink.indexOf(f))
    }
    if (cut.length) out.truncated = true
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
          result = detect()
          break
        case 'scan':
          result = scan(d.args)
          break
        case 'fill':
          result = await fill(d.args, (p) => window.postMessage({ __sgbProgress: nonce, ...p }, '*'))
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

  window.__sgbNeis = Object.freeze({ version: VERSION, detect, scan, fill: (job) => fill(job), stop })
})()
