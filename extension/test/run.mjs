// 확장 테스트: xvfb-run -a node extension/test/run.mjs   (npm run test:ext)
// 1) 엔진(neis-main.js)을 모의 나이스 화면 6개에 직접 넣어 detect/scan/fill/inspect/stop 확인
//    ?cpr=1 은 실제 나이스 모양(MDI로 여섯 앱이 동시에 있음, 실제 앱 id·데이터 열)
// 2) 웹앱 bridge → 서비스 워커 저장 경로 (http://localhost:<port>/app.html)
// 3) 끝에서 끝: https://sgb-test.neis.go.kr (Playwright route로 모의 화면 제공) + 팝업 UI로 인식·입력·구조 수집
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers'
const { chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT = resolve(HERE, '..')
const ENGINE = join(EXT, 'src', 'neis-main.js')
const SCREENS = ['교과평가', '학기말종합의견', '행동특성', '학생부자료기록', '동아리활동관리', '진로활동관리']
const NAMES = ['학생A', '학생B', '학생C', '학생D']

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) pass++
  else {
    fail++
    failures.push(label)
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''))
  }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 5000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await sleep(step)
  }
}

// ---------- 정적 서버 ----------
const FILES = { '/mock-neis.html': 'mock-neis.html', '/app.html': 'app.html' }
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const f = FILES[path]
  if (!f) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(join(HERE, f)))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const MOCK = (screen) => `http://127.0.0.1:${PORT}/mock-neis.html?screen=${encodeURIComponent(screen)}`

// 엔진 버전: neis-main.js VERSION = neis-content.js ENGINE_VERSION = manifest version
{
  const ver = (f, re) => ((readFileSync(join(EXT, f), 'utf8').match(re) || [])[1])
  const v = [ver('src/neis-main.js', /const VERSION = '([^']+)'/), ver('src/neis-content.js', /const ENGINE_VERSION = '([^']+)'/), JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')).version]
  ok(v[0] && v.every((x) => x === v[0]), '버전: 엔진·content script·manifest 같음', v)
}

// ---------- 브라우저 ----------
const profile = await mkdtemp(join(tmpdir(), 'sgb-ext-'))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
})
let sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }))
const extId = new URL(sw.url()).host
console.log(`확장 로드: ${extId}`)

// ---------- 1) 엔진 ----------
function jobFor(screen, extra = {}) {
  const students = [1, 2, 3, 9]
  if (screen === '교과평가')
    return {
      screen,
      delayMs: 0,
      rows: students.map((s) => ({
        student: s,
        text: '평어',
        standards: [
          { code: '[6국05-01]', level: '잘함', criterion: `기준01-${s}` },
          { code: '[6국05-02]', level: '매우잘함', criterion: `기준02-${s}` },
          { code: '[6국99-99]', level: '보통', criterion: '없는 성취기준' },
        ],
      })),
      ...extra,
    }
  return { screen, area: '자율', delayMs: 0, rows: students.map((s) => ({ student: s, text: `${screen} 문장 ${s}` })), ...extra }
}

async function openMock(page, screen) {
  await page.goto(MOCK(screen))
  await page.addScriptTag({ path: ENGINE })
  await page.waitForFunction(() => !!window.__sgbNeis)
}

/** 화면의 입력 칸 값 [{student, area?, level?, result?, text?}] — 테스트 확인용 (모의 화면 구조를 앎) */
async function readMock(page, screen) {
  return page.evaluate((screen) => {
    const rows = Array.from(document.querySelectorAll('#grid tbody tr'))
    let last = null
    return rows.map((tr) => {
      const tds = Array.from(tr.cells)
      if (screen === '교과평가' || screen === '학생부자료기록') {
        if (tds.length >= (screen === '교과평가' ? 7 : 5)) last = Number(tds[0].textContent)
      } else if (screen === '학기말종합의견') last = Number(tds[0].textContent.split('/')[1])
      else if (screen === '행동특성') last = Number(tds[0].textContent)
      else last = Number(tds[2].textContent)
      const sel = tr.querySelector('select')
      const inp = tr.querySelector('input.result')
      const ta = tr.querySelector('textarea')
      return {
        student: last,
        area: ta && ta.dataset.area ? ta.dataset.area : undefined,
        level: sel ? (sel.value ? sel.options[sel.selectedIndex].text : '') : undefined,
        result: inp ? inp.value : undefined,
        text: ta ? ta.value : undefined,
      }
    })
  }, screen)
}
const counters = (page) => page.evaluate(() => ({ save: window.__saveClicks, confirm: window.__confirmClicks }))

const page = await context.newPage()
for (const screen of SCREENS) {
  console.log(`[엔진] ${screen}`)
  await openMock(page, screen)

  const d = await page.evaluate(() => window.__sgbNeis.detect())
  eq(d.screen, screen, `${screen}: detect.screen`)
  const dj = JSON.stringify(d)
  ok(!NAMES.some((n) => dj.includes(n)) && !dj.includes('선택'), `${screen}: detect에 표 밖 글자(학생A/학생B 선택) 없음`, d.titles)
  ok(Array.isArray(d.titles) && d.titles.every((t) => /평가|종합\s*의견|행동\s*특성|활동|자료\s*기록|관리/.test(t)), `${screen}: titles는 화면 이름 낱말만`, d.titles)
  ok(d.ready && d.strategy === 'dom', `${screen}: detect ready (dom)`, d)
  ok(d.cpr === false, `${screen}: cpr 없음`)

  const scan = await page.evaluate(() => window.__sgbNeis.scan())
  const scanJson = JSON.stringify(scan)
  ok(!NAMES.some((n) => scanJson.includes(n)), `${screen}: scan에 이름 없음`)
  ok(!scanJson.includes('기존'), `${screen}: scan에 입력 칸 내용 없음`)
  ok(!scanJson.includes('선택') && !scanJson.includes('3번'), `${screen}: scan에 표 밖 글자 없음`)
  ok(Buffer.byteLength(scanJson) < 300 * 1024, `${screen}: scan < 300KB`, Buffer.byteLength(scanJson))
  ok(scan.grids.length >= 1 && scan.grids[0].headers.includes('성명'), `${screen}: scan 머리글 포함`)
  ok(scan.grids[0].numbers.length > 0 && scan.grids[0].numbers.every((n) => Number.isInteger(n)), `${screen}: scan 번호 표본`, scan.grids[0].numbers)
  ok(typeof scan.dom.headerHtml === 'string' && scan.dom.headerHtml.includes('번호'), `${screen}: scan headerHtml`)
  ok(scan.path === '/mock-neis.html' && !scanJson.includes('screen='), `${screen}: scan은 pathname만`)

  // 덮어쓰기 + 저장 안 함
  const r1 = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor(screen, { mode: 'overwrite', save: false }))
  const v1 = await readMock(page, screen)
  let c = await counters(page)
  eq(r1.missing, [9], `${screen}: 못 찾은 번호 [9]`)
  ok(r1.saved === false && c.save === 0, `${screen}: save:false면 저장 안 누름`, c)
  ok(r1.strategy === 'dom', `${screen}: strategy dom`)
  if (screen === '교과평가') {
    eq(r1.filled, 3, `${screen}: 3명 입력`)
    eq(r1.cells, 12, `${screen}: 12칸 입력`)
    for (const s of [1, 2, 3]) {
      const rows = v1.filter((x) => x.student === s)
      eq(rows.map((x) => x.level), ['잘함', '매우잘함'], `${screen}: ${s}번 단계(콤보)`)
      eq(rows.map((x) => x.result), [`기준01-${s}`, `기준02-${s}`], `${screen}: ${s}번 평가결과(코드로 찾음)`)
    }
    eq(v1.filter((x) => x.student === 4).map((x) => x.level + x.result), ['', ''], `${screen}: 4번은 그대로`)
    eq(r1.unmatchedStandards.map((u) => u.student + u.code), ['1[6국99-99]', '2[6국99-99]', '3[6국99-99]'], `${screen}: 없는 성취기준 보고`)
  } else if (screen === '학생부자료기록') {
    eq(r1.filled, 3, `${screen}: 3명 입력`)
    for (const s of [1, 2, 3]) {
      const rows = v1.filter((x) => x.student === s)
      eq(rows.find((x) => x.area === '자율·자치활동').text, `${screen} 문장 ${s}`, `${screen}: ${s}번 자율·자치활동`)
      ok(rows.filter((x) => x.area !== '자율·자치활동').every((x) => x.text === ''), `${screen}: ${s}번 다른 영역(자율동아리 포함) 그대로`)
    }
  } else {
    eq(r1.filled, 3, `${screen}: 3명 입력`)
    eq(v1.map((x) => x.text), [`${screen} 문장 1`, `${screen} 문장 2`, `${screen} 문장 3`, ''], `${screen}: 칸 값`)
  }

  // 빈 칸만 + 저장
  await openMock(page, screen)
  const r2 = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor(screen, { mode: 'empty', save: true }))
  const v2 = await readMock(page, screen)
  c = await counters(page)
  ok(r2.saved === true && c.save === 1, `${screen}: 저장 1번 누름`, c)
  ok(c.confirm === 2 && r2.confirmed === 2, `${screen}: 확인 대화상자 2개 누름`, { c, confirmed: r2.confirmed })
  ok(r2.skipped > 0, `${screen}: 빈 칸만 → 건너뜀 보고`, r2.skipped)
  if (screen === '교과평가') {
    const two = v2.filter((x) => x.student === 2)
    eq([two[0].level, two[0].result], ['보통', '기존 결과'], `${screen}: 빈 칸만 → 2번 기존 값 유지`)
    eq([two[1].level, two[1].result], ['매우잘함', '기준02-2'], `${screen}: 빈 칸만 → 2번 빈 행은 입력`)
  } else if (screen === '학생부자료기록') {
    eq(v2.find((x) => x.student === 2 && x.area === '자율·자치활동').text, '기존 자율', `${screen}: 빈 칸만 → 2번 기존 값 유지`)
    eq(v2.find((x) => x.student === 1 && x.area === '자율·자치활동').text, `${screen} 문장 1`, `${screen}: 빈 칸만 → 1번 입력`)
  } else {
    eq(v2.map((x) => x.text).slice(0, 3), [`${screen} 문장 1`, v2[1].text, `${screen} 문장 3`], `${screen}: 빈 칸만 → 1·3번 입력`)
    ok(v2[1].text.startsWith('기존'), `${screen}: 빈 칸만 → 2번 기존 값 유지`, v2[1].text)
  }
}

// 학생부자료기록 · 진로 영역
{
  console.log('[엔진] 학생부자료기록 · 진로')
  await openMock(page, '학생부자료기록')
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('학생부자료기록', { area: '진로', mode: 'empty', save: false }))
  const v = await readMock(page, '학생부자료기록')
  eq(r.filled, 3, '진로: 3명 입력')
  eq(v.filter((x) => x.area === '진로활동').map((x) => x.text), ['학생부자료기록 문장 1', '학생부자료기록 문장 2', '학생부자료기록 문장 3', ''], '진로: 진로활동 행만')
  ok(v.filter((x) => x.area === '자율동아리' || x.area === '동아리활동').every((x) => x.text === ''), '진로: 동아리 행은 그대로')
}

// 중지
{
  console.log('[엔진] 중지')
  await openMock(page, '행동특성')
  const p = page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('행동특성', { mode: 'overwrite', save: true, delayMs: 400 }))
  await sleep(150)
  await page.evaluate(() => window.__sgbNeis.stop())
  const r = await p
  const c = await counters(page)
  ok(r.aborted === true && r.filled < 3, '중지: 중간에 멈춤', r)
  ok(r.saved === false && c.save === 0, '중지: 저장 안 누름', c)
  // 키 입력으로 중지
  await openMock(page, '행동특성')
  const p2 = page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('행동특성', { mode: 'overwrite', save: true, delayMs: 400 }))
  await sleep(150)
  await page.keyboard.press('Shift')
  const r2 = await p2
  ok(r2.aborted === true && (await counters(page)).save === 0, '키 입력으로 중지', r2)
}

// 두 반이 한 표에 섞인 경우: 떨어져서 다시 나오는 번호는 건너뜀
for (const screen of ['교과평가', '학생부자료기록']) {
  console.log(`[엔진] 두 반 · ${screen}`)
  await page.goto(MOCK(screen) + '&classes=2')
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor(screen, { mode: 'overwrite', save: true }))
  eq(r.ambiguous, [1, 2], `두 반 ${screen}: 1·2번 건너뜀`)
  eq(r.filled, 1, `두 반 ${screen}: 3번만 입력`)
  eq(r.missing, [9], `두 반 ${screen}: 못 찾은 번호`)
  const v = await readMock(page, screen)
  const touched = v.filter((x) => (x.text && x.text.includes('문장')) || (x.result && x.result.startsWith('기준')))
  ok(touched.every((x) => x.student === 3), `두 반 ${screen}: 1·2번 행은 손대지 않음`, touched)
}

// 동아리: 여러 반이 섞인 명단은 입력 거부
{
  console.log('[엔진] 동아리 · 여러 반')
  await page.goto(MOCK('동아리활동관리') + '&classes=2')
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('동아리활동관리', { mode: 'overwrite', save: true }))
  eq(r.error, 'mixed-classes', '동아리 여러 반: 거부')
  ok(r.notes.some((n) => n.includes('여러 반이 섞인 명단')), '동아리 여러 반: 안내')
  const v = await readMock(page, '동아리활동관리')
  ok(v.every((x) => !x.text.includes('문장')) && (await counters(page)).save === 0, '동아리 여러 반: 입력·저장 없음')
}

// 학기말종합의견: 화면 과목과 데이터 과목이 다르면 거부
{
  console.log('[엔진] 학기말종합의견 · 과목 확인')
  await openMock(page, '학기말종합의견')
  const bad = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('학기말종합의견', { subject: '수학', mode: 'overwrite', save: true }))
  eq(bad.error, 'subject-mismatch', '과목 다름: 거부')
  ok(bad.notes.includes('화면 과목과 데이터 과목이 다름'), '과목 다름: 안내')
  ok((await readMock(page, '학기말종합의견')).every((x) => !x.text.includes('문장')) && (await counters(page)).save === 0, '과목 다름: 입력·저장 없음')
  const good = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('학기말종합의견', { subject: '국어', mode: 'overwrite', save: false }))
  ok(!good.error && good.filled === 3, '과목 같음: 입력', good)
}

// 과목 확인: 낱말 전체 비교, 괄호 무시, 과목이 0개·여러 개면 막지 않음, "과목" 이름표 콤보 우선
{
  console.log('[엔진] 학기말종합의견 · 과목 비교 규칙')
  const semFill = async (query, subject) => {
    await page.goto(MOCK('학기말종합의견') + query)
    await page.addScriptTag({ path: ENGINE })
    return page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('학기말종합의견', { subject, mode: 'overwrite', save: false }))
  }
  let r = await semFill('&subjects=' + encodeURIComponent('국어(독서),수학'), '국어')
  ok(!r.error && r.filled === 3, '과목: 화면 "국어(독서)" ↔ 데이터 "국어" 통과', r)
  r = await semFill('', '국어(독서)')
  ok(!r.error && r.filled === 3, '과목: 화면 "국어" ↔ 데이터 "국어(독서)" 통과', r)
  r = await semFill('&nosubject=1&titles=' + encodeURIComponent('학생정보,통합조회'), '수학')
  ok(!r.error && r.filled === 3, '과목: "학생정보"·"통합조회" 제목만 있으면 막지 않음', r)
  r = await semFill('&sidemenu=1&subject=' + encodeURIComponent('수학'), '수학')
  ok(!r.error && r.filled === 3, '과목: 과목 목록 + 수학 콤보 → 수학 입력', r)
  r = await semFill('&sidemenu=1&subject=' + encodeURIComponent('수학'), '국어')
  eq(r.error, 'subject-mismatch', '과목: 과목 목록 + 수학 콤보 → 국어 거부')
}

// 동아리: 합계("계") 행은 반 섞임 판단에서 뺌
{
  console.log('[엔진] 동아리 · 합계 행')
  await page.goto(MOCK('동아리활동관리') + '&footer=1')
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('동아리활동관리', { mode: 'overwrite', save: false }))
  ok(!r.error && r.filled === 3, '동아리 합계 행: 거부하지 않고 입력', r)
}

// 교과평가: 성취기준별로 묶인 표도 모두 입력 (같은 번호가 떨어져 나와도 (번호, 코드)가 다르면 정상)
{
  console.log('[엔진] 교과평가 · 성취기준별 묶음')
  await page.goto(MOCK('교과평가') + '&grouped=1')
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('교과평가', { mode: 'overwrite', save: false }))
  eq([r.filled, r.cells, r.ambiguous, r.missing], [3, 12, [], [9]], '묶음: 3명·12칸 입력, 건너뜀 없음')
  const v = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#grid tbody tr')).map((tr) => [Number(tr.cells[0].textContent), tr.cells[3].textContent.split(' ')[0], tr.querySelector('select').selectedOptions[0].text, tr.querySelector('input.result').value]),
  )
  const want = []
  for (const [code, lv, k] of [['[6국05-01]', '잘함', '01'], ['[6국05-02]', '매우잘함', '02']])
    for (const s of [1, 2, 3, 4]) want.push(s === 4 ? [s, code, '선택', ''] : [s, code, lv, `기준${k}-${s}`])
  eq(v, want, '묶음: 학생·성취기준마다 맞는 칸')
}

// 입력 실패 칸이 있으면 저장하지 않음
{
  console.log('[엔진] 입력 실패 → 저장 안 함')
  await page.goto(MOCK('행동특성') + '&readonly=3')
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('행동특성', { mode: 'overwrite', save: true }))
  ok(r.failed === 1 && r.filled === 2, '입력 실패: 1칸 실패, 2명 입력', r)
  ok(r.saved === false && (await counters(page)).save === 0, '입력 실패: 저장 안 누름')
  ok(r.notes.includes('일부 칸이 확인되지 않아 저장하지 않았습니다. 확인 후 직접 저장하세요.'), '입력 실패: 안내')
}

// 진행 중 표시 (팝업을 다시 열 때)
{
  await openMock(page, '행동특성')
  const p = page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('행동특성', { mode: 'overwrite', save: false, delayMs: 300 }))
  await sleep(100)
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  ok(d.running === true, 'detect: 입력 중이면 running')
  await p
  ok((await page.evaluate(() => window.__sgbNeis.detect())).running === false, 'detect: 끝나면 running false')
  const f = await page.evaluate(() => window.__sgbNeis.detect({ screen: '교과평가' }))
  ok(f.screen === '교과평가' && f.forced && f.detectedScreen === '행동특성' && f.ready === false, 'detect: 화면 지정', f)
}

// cpr(eXBuilder6) 1차 추정 모양 (?cpr=legacy) — 알려지지 않은 앱이면 1차 cpr 그리드 방식이 계속 동작
for (const screen of ['교과평가', '행동특성']) {
  console.log(`[엔진] cpr(1차 모양) · ${screen}`)
  await page.goto(MOCK(screen) + '&cpr=legacy')
  await page.addScriptTag({ path: ENGINE })
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  eq([d.screen, d.strategy, d.cpr, d.cprVersion, d.apps, d.knownApp], [screen, 'cpr', true, 'mock-1', 1, false], `cpr ${screen}: detect`)
  const scan = await page.evaluate(() => window.__sgbNeis.scan())
  const sj = JSON.stringify(scan)
  ok(!NAMES.some((n) => sj.includes(n)), `cpr ${screen}: scan에 이름 없음`)
  ok(scan.apps[0]?.id === 'SCR_MOCK' && scan.controls.some((c) => c.id === 'grdMain' && c.type === 'grid'), `cpr ${screen}: scan 앱·컨트롤`, { apps: scan.apps, controls: scan.controls })
  const cg = scan.grids.find((g) => g.source === 'cpr')
  ok(cg && cg.columns.includes('STD_NM') && cg.headerColumns.includes('STD_NO') && cg.editable.length === 3, `cpr ${screen}: scan 그리드 열 이름·편집 여부`, cg)
  const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor(screen, { mode: 'empty', save: true }))
  const data = await page.evaluate(() => window.__cprData.map(({ STD_NM, ...rest }) => rest))
  eq(r.strategy, 'cpr', `cpr ${screen}: strategy cpr`)
  eq(r.missing, [9], `cpr ${screen}: 못 찾은 번호`)
  ok(r.saved && (await counters(page)).save === 1, `cpr ${screen}: 저장 누름`)
  eq(await page.evaluate(() => window.__nameReads), 0, `cpr ${screen}: 성명 열을 한 번도 읽지 않음`)
  if (screen === '교과평가') {
    eq(data.map((x) => x.LVL_CD), ['2', '1', '3', '1', '2', '1', '', ''], `cpr ${screen}: 단계 → 콤보 값(2=잘함, 1=매우잘함), 2번 첫 행 유지`)
    eq(data.map((x) => x.EVL_RSLT), ['기준01-1', '기준02-1', '기존 결과', '기준02-2', '기준01-3', '기준02-3', '', ''], `cpr ${screen}: 평가결과 (번호 이어 쓰기)`)
    eq(r.verifyFailed, 0, `cpr ${screen}: 다시 읽기 확인`)
  } else {
    eq(data.map((x) => x.BHV_OPN), ['행동특성 문장 1', '기존 행발', '행동특성 문장 3', ''], `cpr ${screen}: 행발 칸`)
  }
}

// ---------- 실제 나이스 모양 (?cpr=1): MDI로 여섯 화면 앱이 모두 있고 ?screen= 화면만 보임 ----------
const APP = {
  교과평가: 'edu/sw/els/scr/es/els_scres00_m02$1',
  학기말종합의견: 'edu/sw/els/scr/es/els_scres10_m00$1',
  행동특성: 'edu/sw/els/sdl/bg/els_sdlbg00_m00$1',
  학생부자료기록: 'edu/sw/els/sdl/ce/els_sdlce06_m00$2',
  동아리활동관리: 'edu/sw/els/sdl/ce/els_sdlce01_m06$1',
  진로활동관리: 'edu/sw/els/sdl/ce/els_sdlce04_m00$2',
}
const TEXT_COL = { 학기말종합의견: 'gnrlzOpiCn', 행동특성: 'gnrlzOpiCn', 학생부자료기록: 'speclActSpablMteCn', 동아리활동관리: 'speclActSpablMteCn', 진로활동관리: 'speclActSpablMteCn' }
const ALL21 = Array.from({ length: 21 }, (_, i) => i + 1)
const FAKE = ['가상학생', '2014-03-', '희망 가상', '가상동아리', 'user1']
const LV = { 잘함: 'B', '매우 잘함': 'A', '노력 요함': 'D' }
function cprJob(screen, students, extra = {}) {
  if (screen === '교과평가')
    return {
      screen,
      subject: '국어',
      delayMs: 0,
      rows: students.map((s) => ({
        student: s,
        text: '평어',
        standards: [
          { code: '[6국05-01]', level: '잘함', criterion: `c1-${s}` },
          { code: '[6국05-02]', level: '매우 잘함', criterion: `c2-${s}` },
          { code: '[6국05-03]', level: '노력 요함', criterion: `c3-${s}` },
        ],
      })),
      ...extra,
    }
  return { screen, area: '자율', subject: screen === '학기말종합의견' ? '국어' : undefined, delayMs: 0, rows: students.map((s) => ({ student: s, text: `${screen} 문장 ${s}` })), ...extra }
}
async function openCpr(screen, q = '') {
  await page.goto(MOCK(screen) + '&cpr=1' + q)
  await page.addScriptTag({ path: ENGINE })
  await page.waitForFunction(() => !!window.__sgbNeis)
}
const personalReads = () => page.evaluate(() => Object.entries(window.__personalReads).filter(([c]) => c !== 'stdntInfo').reduce((n, [, v]) => n + v, 0))
const mock = (fn, arg) => page.evaluate(([fn, arg]) => window.__mock[fn](arg), [fn, arg])
const visKey = () => page.evaluate(() => window.__mock.visibleKey)

for (const screen of SCREENS) {
  console.log(`[cpr 실제 모양] ${screen}`)
  await openCpr(screen)
  const key = await visKey()
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  eq([d.screen, d.strategy, d.knownApp, d.activeApp, d.ready], [screen, 'cpr-known', true, APP[screen], true], `cpr실제 ${screen}: 보이는 앱으로 화면 인식 (제목은 교과평가)`)
  eq(d.rows, screen === '교과평가' ? 63 : screen === '학생부자료기록' ? 105 : 21, `cpr실제 ${screen}: 데이터셋 행 수`)

  // 인식 검사: 쓰기 없음
  const snap0 = await mock('snapshot')
  const job = cprJob(screen, ALL21.concat(99))
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), job)
  ok(ins.strategy === 'cpr-known' && ins.knownApp && ins.activeApp === APP[screen], `cpr실제 ${screen}: inspect 앱`, ins)
  eq([ins.studentsFound, ins.studentsMissing], [21, [99]], `cpr실제 ${screen}: inspect 학생 찾기`)
  eq(ins.cells, screen === '교과평가' ? 126 : 21, `cpr실제 ${screen}: inspect 넣을 칸`)
  eq(await mock('snapshot'), snap0, `cpr실제 ${screen}: inspect는 아무것도 쓰지 않음`)
  if (screen === '교과평가') {
    ok(Object.values(ins.standardsPerStudent).length === 21 && Object.values(ins.standardsPerStudent).every((n) => n === 3), 'cpr실제 교과평가: inspect 학생별 성취기준 3개', ins.standardsPerStudent)
    eq(ins.levelCodes, { 매우잘함: 'A', 잘함: 'B', 보통: 'C', 노력요함: 'D', 임의입력: 'Z' }, 'cpr실제 교과평가: inspect 단계 코드')
    eq(ins.resultAutoFill, true, 'cpr실제 교과평가: inspect 평가결과 자동 채움 추정')
  } else ok(ins.levelCodes === null && ins.standardsPerStudent === null, `cpr실제 ${screen}: inspect 단계 코드 없음`)

  // 덮어쓰기 + 저장: 데이터셋 모든 행 (표에 그려진 16행 밖 포함)
  const hidden0 = await mock('snapshotExcept', key)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, mode: 'overwrite', save: true })
  ok(r.strategy === 'cpr-known' && r.activeApp === APP[screen], `cpr실제 ${screen}: fill strategy cpr-known`, r)
  eq([r.filled, r.missing, r.verifyFailed, r.failed], [21, [99], 0, 0], `cpr실제 ${screen}: 21명 입력`)
  const saves = await page.evaluate(() => window.__saveByApp)
  ok(r.saved && JSON.stringify(saves) === JSON.stringify({ [APP[screen]]: 1 }) && r.confirmed === 2, `cpr실제 ${screen}: 보이는 앱의 btnSave만 누름`, { saves, r })
  eq(await mock('snapshotExcept', key), hidden0, `cpr실제 ${screen}: 숨은 앱(다른 MDI 탭) 데이터는 그대로`)
  eq(await personalReads(), 0, `cpr실제 ${screen}: 개인정보 열 읽기 0`)
  ok((await mock('redraws', key)) >= 1, `cpr실제 ${screen}: grid.redraw`)
  const writeCols = await page.evaluate(() => Object.keys(window.__writeCols))
  const allowed = screen === '교과평가' ? ['evlCtrCd', 'evlCtrCn'] : [TEXT_COL[screen]]
  ok(writeCols.every((c) => allowed.includes(c)), `cpr실제 ${screen}: 쓴 열은 ${allowed.join('·')}만 (length·희망분야 안 씀)`, writeCols)
  const rows = await mock('rows', key)
  const states = await mock('states', key)
  if (screen === '교과평가') {
    const codes = rows.map((x) => x.evlCtrCd)
    eq(codes, ALL21.flatMap(() => ['B', 'A', 'D']), 'cpr실제 교과평가: 63행 모두 단계 코드(라벨→코드, 띄어쓰기 무시)')
    eq(rows.map((x) => x.evlCtrCn), ALL21.flatMap((s) => [`c1-${s}`, `c2-${s}`, `c3-${s}`]), 'cpr실제 교과평가: 덮어쓰기 → 나이스 자동 문구도 데이터 평가결과로')
    eq(r.autoFilled, 21, 'cpr실제 교과평가: 자동 채움 21칸 보고')
    ok(states.every((x) => x === 2), 'cpr실제 교과평가: 모든 행 변경 상태')
  } else if (screen === '학생부자료기록') {
    const auto = rows.filter((x) => x.actScNm === '자율·자치활동')
    eq(auto.map((x) => x.speclActSpablMteCn), ALL21.map((s) => `${screen} 문장 ${s}`), 'cpr실제 창체: 자율·자치활동 행 21개')
    ok(rows.filter((x) => x.actScNm !== '자율·자치활동').every((x) => x.speclActSpablMteCn === ''), 'cpr실제 창체: 다른 영역(동아리·청소년단체·스포츠클럽·진로)은 그대로')
  } else {
    eq(rows.map((x) => x[TEXT_COL[screen]]), ALL21.map((s) => `${screen} 문장 ${s}`), `cpr실제 ${screen}: 21행 모두 입력`)
  }

  // 구조 수집: API 이름, 열 정보, 비개인 열 표본만
  const scan = await page.evaluate(() => window.__sgbNeis.scan())
  const sj = JSON.stringify(scan)
  ok(!FAKE.some((f) => sj.includes(f)), `cpr실제 ${screen}: scan에 개인정보 값 없음`, FAKE.filter((f) => sj.includes(f)))
  const kn = scan.known
  const ka = kn && kn.apps.find((x) => x.id === APP[screen])
  ok(kn && kn.activeApp === APP[screen] && kn.how === 'visible' && kn.mdiSelected, `cpr실제 ${screen}: scan activeApp·mdi`, kn && { a: kn.activeApp, how: kn.how, mdi: kn.mdiSelected })
  ok(kn && kn.api.grid.includes('getRowCount') && kn.api.dataSet.includes('setValue') && kn.api.header.includes('cellCount') && kn.api.platform.includes('getAllRunningAppInstances'), `cpr실제 ${screen}: scan api 이름`, kn && kn.api)
  ok(ka && ka.headerProps.cellCount > 0 && ka.headerCols.length === ka.headerProps.cellCount && ka.headerCols.some((h) => h && h.text === '[개인정보]'), `cpr실제 ${screen}: scan 머리글(성명 가림)`, ka && ka.headerCols)
  ok(ka && ka.detailCols.some((c) => c && c.columnName === '[개인정보]') && ka.detailCols.every((c) => !c || !['stuFlnm', 'stdntNm', 'stuHopMteCn'].includes(c.columnName)), `cpr실제 ${screen}: scan 본문 열(개인정보 열 이름 가림)`, ka && ka.detailCols)
  ok(ka && ka.datasetSample.length === 3 && ka.rowStates.length === 3 && kn.apps.filter((x) => x.visible === false).length >= 4, `cpr실제 ${screen}: scan 표본·행 상태·숨은 앱 표시`, ka && { s: ka.datasetSample, st: ka.rowStates })
  ok(ka && ka.datasetSample.every((row) => Object.keys(row).every((c) => !['stuFlnm', 'stdntNm', 'stuBrdt', 'sameFlnm', 'stuInvlNo', 'userId', 'stuHopMteCn', 'clubActDptNm', 'sxdsScCd'].includes(c))), `cpr실제 ${screen}: scan 표본에 개인정보 열 없음`)
  if (screen === '교과평가') eq(ka && ka.levelComboItems && ka.levelComboItems.map((x) => x.label + '=' + x.value).join(','), '매우잘함=A,잘함=B,보통=C,노력요함=D,임의입력=Z', 'cpr실제 교과평가: scan 단계 항목')
  if (screen === '학기말종합의견') ok(ka && ka.datasetSample.every((x) => /^\[비숫자 len=\d+\]$/.test(x.stdntCn) && /^3\/\d+$/.test(x.stdntInfo) && /^\[len=\d+\]$/.test(x.gnrlzOpiCn)), 'cpr실제 학기말: scan 숫자 규칙·글자 수만', ka && ka.datasetSample)
  eq(await personalReads(), 0, `cpr실제 ${screen}: scan 뒤에도 개인정보 열 읽기 0`)
  ok(Buffer.byteLength(sj) < 300 * 1024, `cpr실제 ${screen}: scan < 300KB`, Buffer.byteLength(sj))
}

// 교과평가 · 빈 칸만: 나이스가 채운 평가결과는 그대로, 기존 값 유지
{
  console.log('[cpr 실제 모양] 교과평가 · 빈 칸만')
  await openCpr('교과평가')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 2, 3], { mode: 'empty', save: false }))
  const rows = (await mock('rows', 'm02')).slice(0, 9).map((x) => x.evlCtrCd + '/' + x.evlCtrCn)
  eq(rows, ['B/나이스 기준문 B', 'A/c2-1', 'D/c3-1', 'C/기존 결과', 'A/c2-2', 'D/c3-2', 'B/나이스 기준문 B', 'A/c2-3', 'D/c3-3'], '빈 칸만: 자동 채움 존중 · 2번 기존 값 유지')
  eq([r.autoFilled, r.skipped, r.saved, await page.evaluate(() => window.__saveClicks)], [2, 4, false, 0], '빈 칸만: 자동 2 · 건너뜀 4 · 저장 안 함')
  ok(r.notes.some((n) => n.includes('나이스가 평가결과를 채운 칸 2개')), '빈 칸만: 자동 채움 안내', r.notes)
}

// 교과평가 · 단계 항목 변형
for (const [q, label] of [['&lvl=row', '행마다 항목 (행 선택 후 다시 읽기)'], ['&lvl=itemset', '데이터셋에 묶인 항목'], ['&stdcode=internal', '성취기준 코드 열이 내부 코드 → 성취기준 글자로']]) {
  console.log(`[cpr 실제 모양] 교과평가 · ${label}`)
  await openCpr('교과평가', q)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 21], { mode: 'overwrite', save: false }))
  const rows = await mock('rows', 'm02')
  ok(!r.error && r.filled === 2 && r.cells === 12 && r.verifyFailed === 0, `${label}: 2명 12칸`, r)
  eq([rows[0].evlCtrCd, rows[61].evlCtrCd, rows[62].evlCtrCn], ['B', 'A', 'c3-21'], `${label}: 코드·결과`)
  if (q === '&lvl=row') ok((await mock('selected', 'm02')) != null, `${label}: 행을 고른 뒤 항목을 읽음`)
}
{
  console.log('[cpr 실제 모양] 교과평가 · 단계 코드 없음')
  await openCpr('교과평가', '&lvl=none')
  const snap = await mock('snapshot')
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob('교과평가', [1, 2]))
  ok(ins.levelCodes === null && ins.warnings.includes('level-code-unknown'), '단계 코드 없음: inspect 경고', ins)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 2], { mode: 'overwrite', save: true }))
  eq([r.error, r.cells, r.saved], ['level-code-unknown', 0, false], '단계 코드 없음: 짐작하지 않고 중단')
  ok((await mock('snapshot')) === snap && (await page.evaluate(() => window.__saveClicks)) === 0, '단계 코드 없음: 쓰기·저장 없음')
}
{
  console.log('[cpr 실제 모양] 교과평가 · 과목 확인(sbjtNm)')
  await openCpr('교과평가')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1], { subject: '수학', mode: 'overwrite', save: true }))
  eq(r.error, 'subject-mismatch', '교과평가 과목 다름: 거부')
}

// 행동특성 · 마감
{
  console.log('[cpr 실제 모양] 행동특성 · 마감')
  await openCpr('행동특성', '&closed=1')
  const snap = await mock('snapshot')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('행동특성', [1, 2, 3, 4], { mode: 'overwrite', save: true }))
  eq(r.error, 'closed', '마감: 거부')
  ok(r.notes.some((n) => n.includes('3번')), '마감: 학생 번호 안내', r.notes)
  ok((await mock('snapshot')) === snap && (await page.evaluate(() => window.__saveClicks)) === 0, '마감: 쓰기·저장 없음')
  const ok2 = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('행동특성', [1, 2], { mode: 'overwrite', save: false }))
  ok(!ok2.error && ok2.filled === 2, '마감: 마감 안 된 학생만이면 입력', ok2)
}

// 동아리 · 두 반 섞임 (grd+clsNm)
{
  console.log('[cpr 실제 모양] 동아리 · 두 반')
  await openCpr('동아리활동관리', '&classes=2')
  const snap = await mock('snapshot')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('동아리활동관리', [1, 2, 3], { mode: 'overwrite', save: true }))
  eq(r.error, 'mixed-classes', '동아리 두 반(cpr): 거부')
  ok((await mock('snapshot')) === snap, '동아리 두 반(cpr): 쓰기 없음')
}

// 학기말 · 과목(sbjtCdNm) · 번호 출처
{
  console.log('[cpr 실제 모양] 학기말종합의견 · 과목·번호')
  await openCpr('학기말종합의견', '&semsubj=' + encodeURIComponent('수학'))
  let r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학기말종합의견', [1, 2], { subject: '국어', mode: 'overwrite', save: true }))
  eq(r.error, 'subject-mismatch', '학기말 과목(sbjtCdNm 수학) ↔ 데이터 국어: 거부')
  r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학기말종합의견', [1, 2], { subject: '수학', mode: 'overwrite', save: false }))
  ok(!r.error && r.filled === 2, '학기말 과목 같음: 입력', r)
  await openCpr('학기말종합의견', '&numsrc=cn')
  r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학기말종합의견', [5, 20], { mode: 'overwrite', save: false }))
  const rows = await mock('rows', 'sem')
  ok(!r.error && r.filled === 2 && rows[4].gnrlzOpiCn === '학기말종합의견 문장 5' && rows[19].gnrlzOpiCn === '학기말종합의견 문장 20', '학기말 번호가 stdntCn(숫자만)에 있을 때', r)
  eq(await page.evaluate(() => window.__personalReads.stdntInfo || 0), 0, '학기말: stdntCn으로 번호를 찾으면 stdntInfo는 읽지 않음')
}

// 보이는지 알 수 없을 때(컨트롤 ↔ DOM 연결 없음): MDI 선택 탭 → DOM 표 머리글로 고름
for (const q of ['&noel=1', '&noel=1&nomdi=1']) {
  console.log(`[cpr 실제 모양] 보이는 앱 고르기 ${q}`)
  for (const screen of SCREENS) {
    await openCpr(screen, q)
    const d = await page.evaluate(() => window.__sgbNeis.detect())
    eq([d.screen, d.strategy, d.activeApp], [screen, 'cpr-known', APP[screen]], `${q} ${screen}: 보이는 앱`)
  }
  const key = await visKey()
  const hidden0 = await mock('snapshotExcept', key)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', ALL21, { mode: 'empty', save: true }))
  ok(r.filled === 20 && r.skipped === 1 && r.saved, `${q} 진로: 빈 칸만 20명 입력 + 저장`, r)
  eq(await mock('snapshotExcept', key), hidden0, `${q} 진로: 숨은 앱 그대로`)
}

// 같은 화면이 숨은 탭에 하나 더 ($1 숨김, $2 보임)
{
  console.log('[cpr 실제 모양] 숨은 진로 탭이 하나 더')
  await openCpr('진로활동관리', '&dup=1')
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  eq(d.activeApp, APP['진로활동관리'], '숨은 탭 둘: $2(보이는 탭)')
  const old0 = JSON.stringify(await mock('rows', 'carOld'))
  await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', ALL21, { mode: 'overwrite', save: true }))
  eq(JSON.stringify(await mock('rows', 'carOld')), old0, '숨은 탭 둘: $1 데이터 그대로')
  eq(await page.evaluate(() => window.__saveByApp), { [APP['진로활동관리']]: 1 }, '숨은 탭 둘: $2 저장만')
}

// 중지 (데이터셋 방식도 키 입력으로 멈추고 저장하지 않음)
{
  console.log('[cpr 실제 모양] 중지')
  await openCpr('학생부자료기록')
  const p = page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학생부자료기록', ALL21, { mode: 'overwrite', save: true, delayMs: 400 }))
  await sleep(100)
  await page.keyboard.press('Shift')
  const r = await p
  ok(r.aborted === true && r.filled < 21 && r.saved === false && (await page.evaluate(() => window.__saveClicks)) === 0, '중지(cpr): 멈추고 저장 안 함', r)
}

// ---------- 2) bridge → 서비스 워커 ----------
console.log('[bridge] 웹앱 → 확장 저장소')
const swState = async () => {
  sw = context.serviceWorkers()[0] || sw
  return sw.evaluate(() => chrome.storage.local.get())
}
const app = await context.newPage()
await app.goto(`http://localhost:${PORT}/app.html`)
let st = await until(async () => {
  const s = await swState()
  return s.payloads && s.payloads.length ? s : null
}, 8000)
ok(!!st, 'bridge: 처음 열릴 때 payloads 저장')
if (st) {
  eq(st.payloads.length, 1, 'bridge: payload 1개')
  eq(st.payloads[0].subject, '국어', 'bridge: subject')
  eq(st.payloads[0].rows.length, 3, 'bridge: rows 3')
  ok(!('junk' in st.payloads[0]), 'bridge: 모르는 필드 제거')
  ok(/^http:\/\/localhost:\d+$/.test(st.source), 'bridge: source = origin', st.source)
  ok(typeof st.importedAt === 'number', 'bridge: importedAt')
  ok(!JSON.stringify(st).includes('SECRET'), 'bridge: saenggibu-v2(API 키)는 읽지 않음')
}
// 웹앱이 postMessage로 바로 알림 (mirrorNeis)
await app.evaluate(() => {
  const more = [
    ...window.__seed.payloads,
    { version: 1, createdAt: 1760000001000, kind: 'behavior', rows: [1, 2, 3].map((s) => ({ student: s, text: `행발 ${s}번 문장임.` })) },
    { version: 1, createdAt: 1760000002000, kind: 'creative', subject: '자율', rows: [1, 2, 3].map((s) => ({ student: s, text: `자율 ${s}번 문장임.` })) },
    { version: 1, createdAt: 1760000003000, kind: 'creative', subject: '동아리', rows: [{ student: 1, text: '동아리 김철수 학생은 성실함.' }] },
  ]
  localStorage.setItem('saenggibu-neis', JSON.stringify({ version: 1, payloads: more }))
  window.postMessage({ type: 'saenggibu-neis', payloads: more }, location.origin)
})
st = await until(async () => {
  const s = await swState()
  return s.payloads && s.payloads.length === 4 ? s : null
}, 5000)
ok(!!st, 'bridge: postMessage로 바로 갱신 (4개)')
const badge = await sw.evaluate(() => chrome.action.getBadgeText({}))
eq(badge, '4', 'bridge: 배지 = 4')

// ---------- 3) 끝에서 끝 (팝업 UI) ----------
console.log('[e2e] 나이스 탭 + 팝업')
const mockHtml = await readFile(join(HERE, 'mock-neis.html'), 'utf8')
await context.route('https://sgb-test.neis.go.kr/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mockHtml }))
const neisPage = await context.newPage()
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?screen=' + encodeURIComponent('교과평가'))
await neisPage.waitForLoadState('load')
const popup = await context.newPage()
await popup.goto(`chrome-extension://${extId}/popup/popup.html`)
const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'https://sgb-test.neis.go.kr/*' }))[0]?.id)
ok(typeof tabId === 'number', 'e2e: 나이스 탭 찾음')

// 백그라운드 경유 detect
const det = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'neis-command', tabId, cmd: 'detect' }), tabId)
eq(det.screen, '교과평가', 'e2e: background detect')
ok(det.ready === true, 'e2e: 엔진 주입(MAIN world) 후 표 인식', det)

await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-name').textContent.includes('교과평가'), null, { timeout: 15000 })
ok(true, 'e2e: 팝업 화면 인식 표시')
const payloadCount = await popup.locator('#payloads li').count()
eq(payloadCount, 4, 'e2e: 팝업 데이터 4개')
const nameChip = await popup.locator('#payloads li').nth(3).innerText()
ok(nameChip.includes('이름 의심 1'), 'e2e: 사전 검사 이름 의심', nameChip)
const options = await popup.locator('#fill-payload option').allInnerTexts()
ok(options.length === 2 && options[0] === '과목을 고르세요' && options[1].includes('국어'), 'e2e: 교과평가 → 과목 고르기 + 교과 데이터만', options)
ok(await popup.locator('#btn-fill').isDisabled(), 'e2e: 과목을 고르기 전에는 자동 입력 꺼짐')
const fdet = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'neis-command', tabId, cmd: 'detect', args: { screen: '행동특성' } }), tabId)
ok(fdet.screen === '행동특성' && fdet.detectedScreen === '교과평가' && fdet.ready === false, 'e2e: 화면 지정으로 detect', fdet)

// 구조 수집 내려받기
const [download] = await Promise.all([popup.waitForEvent('download', { timeout: 15000 }), popup.click('#btn-scan')])
const fname = download.suggestedFilename()
ok(/^sgb-neis-scan-subject-eval-\d{8}-\d{4}\.json$/.test(fname), 'e2e: 구조 수집 파일 이름', fname)
const scanText = await readFile(await download.path(), 'utf8')
const scanObj = JSON.parse(scanText)
ok(!NAMES.some((n) => scanText.includes(n)), 'e2e: 구조 수집에 이름 없음')
ok(Buffer.byteLength(scanText) < 300 * 1024, 'e2e: 구조 수집 < 300KB')
ok(scanObj.frames?.length >= 1 && scanObj.frames[0].scan.path === '/edu/mock.do', 'e2e: 구조 수집 프레임/경로', scanObj.frames?.[0]?.scan?.path)

// 자동 입력 (저장 포함)
await popup.selectOption('#fill-payload', { index: 1 })
ok(await popup.locator('#btn-fill').isEnabled(), 'e2e: 과목을 고르면 자동 입력 켜짐')
await popup.click('#btn-fill')
await popup.waitForFunction(() => document.getElementById('log').textContent.includes('명 입력'), null, { timeout: 30000 })
const log = await popup.locator('#log').innerText()
ok(log.includes('3명 입력') && log.includes('저장을 눌렀습니다'), 'e2e: 결과 로그', log)
const vals = await readMock(neisPage, '교과평가')
eq(vals.filter((x) => x.student === 3).map((x) => x.level + '/' + x.result), ['잘함/인물의 삶을 이해함 3', '매우잘함/작품을 감상함 3'], 'e2e: 나이스 칸 입력')
const ec = await counters(neisPage)
ok(ec.save === 1 && ec.confirm === 2, 'e2e: 저장·확인 누름', ec)
const last = await swState()
ok(last.lastRun && last.lastRun.result && last.lastRun.result.filled === 3, 'e2e: 마지막 결과 보관', last.lastRun)
ok(!JSON.stringify(last).includes('학생A'), 'e2e: 확장 저장소에 이름 없음')

// 실제 나이스 모양(cpr, MDI) 탭: 인식 검사 → 미리보기
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?cpr=1&screen=' + encodeURIComponent('행동특성'))
await neisPage.waitForLoadState('load')
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-name').textContent.includes('행동특성'), null, { timeout: 15000 })
const sdetail = await popup.locator('#screen-detail').innerText()
ok(sdetail.includes('나이스 데이터 방식') && sdetail.includes('els_sdlbg00_m00'), 'e2e cpr: 화면 카드에 나이스 데이터 방식·앱', sdetail)
await popup.waitForFunction(() => !document.getElementById('btn-inspect').disabled, null, { timeout: 5000 })
await popup.click('#btn-inspect')
await popup.waitForFunction(() => document.getElementById('log').textContent.includes('인식 검사'), null, { timeout: 30000 })
const ilog = await popup.locator('#log').innerText()
ok(ilog.includes('찾은 학생 3명') && ilog.includes('나이스 데이터 방식') && ilog.includes('els_sdlbg00_m00') && ilog.includes('바꾸지 않습니다'), 'e2e cpr: 인식 검사 요약', ilog)
eq(await neisPage.evaluate(() => Object.keys(window.__writeCols).length), 0, 'e2e cpr: 인식 검사는 쓰지 않음')
await popup.click('#btn-preview')
await popup.waitForFunction(() => document.getElementById('log').textContent.includes('명 입력'), null, { timeout: 30000 })
const plog = await popup.locator('#log').innerText()
ok(plog.includes('2명 입력') && plog.includes('건너뛴 칸 1개') && plog.includes('나이스 데이터 방식') && plog.includes('저장은 누르지 않았습니다'), 'e2e cpr: 미리보기 결과', plog)
eq(await neisPage.evaluate(() => window.__mock.rows('beh').slice(0, 4).map((r) => r.gnrlzOpiCn)), ['행발 1번 문장임.', '기존 행발', '행발 3번 문장임.', ''], 'e2e cpr: 데이터셋에 입력 (빈 칸만)')
eq(await neisPage.evaluate(() => window.__saveClicks), 0, 'e2e cpr: 미리보기는 저장 안 누름')

// 나이스가 아닌 탭에서 열면 안내
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${(await app.evaluate(() => 0)) || (await popup.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0]?.id))}`)
await popup.waitForFunction(() => document.getElementById('screen-name').textContent.length > 0)
ok((await popup.locator('#screen-name').innerText()).includes('나이스 탭에서 열어 주세요'), 'e2e: 나이스 아닌 탭 안내')
ok(await popup.locator('#btn-fill').isDisabled(), 'e2e: 나이스 아닌 탭에서 입력 버튼 꺼짐')

// 지우기
await popup.click('#btn-clear')
await popup.click('#btn-clear')
st = await until(async () => {
  const s = await swState()
  return !s.payloads ? s : null
}, 3000)
ok(!!st, 'e2e: 삭제(두 번 눌러 확인)')

await context.close()
server.close()
await rm(profile, { recursive: true, force: true })

console.log(`\n결과: ${pass} 통과, ${fail} 실패`)
if (fail) {
  console.log('실패: ' + failures.join(' | '))
  process.exit(1)
}
