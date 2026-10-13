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
// 실제 나이스 모양(cpr)에는 자율활동관리도 있음
const CPR_SCREENS = ['교과평가', '학기말종합의견', '행동특성', '학생부자료기록', '자율활동관리', '동아리활동관리', '진로활동관리']
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
const byte = (t) => Buffer.byteLength(t)
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

  // 학생부자료기록: 자율·동아리·진로 화면의 글이 합쳐지는 화면 → 자동 입력 대상 아님
  if (screen === '학생부자료기록') {
    eq(d.blocked, 'not-a-target', `${screen}: detect blocked not-a-target`)
    const before = JSON.stringify(await readMock(page, screen))
    const rr = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor(screen, { mode: 'overwrite', save: true }))
    ok(rr.error === 'not-a-target' && rr.notes.some((n) => n.includes('자동 입력 대상이 아닙니다')), `${screen}: 입력 거부`, rr)
    const ins = await page.evaluate((job) => window.__sgbNeis.inspect(job), jobFor(screen))
    eq(ins.error, 'not-a-target', `${screen}: 인식 검사도 거부`)
    ok(JSON.stringify(await readMock(page, screen)) === before && (await counters(page)).save === 0, `${screen}: 쓰기·저장 없음`)
    continue
  }

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

// 학생부자료기록: 진로·동아리 데이터도 거부 (각 관리 화면에서 입력)
{
  console.log('[엔진] 학생부자료기록 · 진로/동아리도 거부')
  await openMock(page, '학생부자료기록')
  for (const [area, creative] of [['진로', '진로'], ['동아리', '동아리']]) {
    const r = await page.evaluate((job) => window.__sgbNeis.fill(job), jobFor('학생부자료기록', { area, creative, mode: 'append', joiner: ' ', save: true }))
    eq(r.error, 'not-a-target', `학생부자료기록 ${area}: 거부`)
  }
  ok((await readMock(page, '학생부자료기록')).every((x) => !x.text || !x.text.includes('문장')), '학생부자료기록: 쓰기 없음')
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
for (const screen of ['교과평가']) {
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
  자율활동관리: 'edu/sw/els/sdl/ce/els_sdlce00_m00$2',
  동아리활동관리: 'edu/sw/els/sdl/ce/els_sdlce01_m06$1',
  진로활동관리: 'edu/sw/els/sdl/ce/els_sdlce04_m00$2',
}
const TEXT_COL = { 학기말종합의견: 'gnrlzOpiCn', 행동특성: 'gnrlzOpiCn', 학생부자료기록: 'speclActSpablMteCn', 자율활동관리: 'speclActSpablMteCn', 동아리활동관리: 'speclActSpablMteCn', 진로활동관리: 'speclActSpablMteCn' }
const ALL21 = Array.from({ length: 21 }, (_, i) => i + 1)
const FAKE = ['가상학생', '2014-03-', '희망 가상', '가상동아리', 'user1', '홍길동', '김철수', '이영희']
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
const allReads = () => page.evaluate(() => Object.values(window.__personalReads).reduce((n, v) => n + v, 0))
const resetReads = () => page.evaluate(() => (window.__personalReads = {}))
const personalReads = () => page.evaluate(() => Object.entries(window.__personalReads).filter(([c]) => c !== 'stdntInfo').reduce((n, [, v]) => n + v, 0))
const mock = (fn, arg) => page.evaluate(([fn, arg]) => window.__mock[fn](arg), [fn, arg])
const visKey = () => page.evaluate(() => window.__mock.visibleKey)

for (const screen of CPR_SCREENS) {
  console.log(`[cpr 실제 모양] ${screen}`)
  await openCpr(screen)
  const key = await visKey()
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  eq([d.screen, d.strategy, d.knownApp, d.activeApp, d.ready], [screen, 'cpr-known', true, APP[screen], true], `cpr실제 ${screen}: 보이는 앱으로 화면 인식 (제목은 교과평가)`)
  eq(d.rows, screen === '교과평가' ? 63 : screen === '학생부자료기록' ? 105 : 21, `cpr실제 ${screen}: 데이터셋 행 수`)
  if (screen === '학생부자료기록') {
    // 확인만 하는 화면: 인식은 하지만 입력·인식 검사는 거부
    eq(d.blocked, 'not-a-target', 'cpr실제 학생부자료기록: detect blocked')
    const snap = await mock('snapshot')
    const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob(screen, ALL21))
    const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob(screen, ALL21, { mode: 'overwrite', save: true }))
    ok(ins.error === 'not-a-target' && r.error === 'not-a-target', 'cpr실제 학생부자료기록: 거부', { ins: ins.error, r: r.error })
    ok((await mock('snapshot')) === snap && (await page.evaluate(() => window.__saveClicks)) === 0, 'cpr실제 학생부자료기록: 쓰기·저장 없음')
    const scan = await page.evaluate(() => window.__sgbNeis.scan())
    const sj = JSON.stringify(scan)
    ok(!FAKE.some((f) => sj.includes(f)), 'cpr실제 학생부자료기록: scan에 개인정보 값 없음')
    const ka = scan.known.apps.find((x) => x.id === APP[screen])
    const dist = ka && ka.distinct && ka.distinct.actScNm2
    ok(dist && dist.values.some((x) => x.value === '자율·자치활동 동아리활동' && x.count === 21) && dist.distinct === 5, 'cpr실제 학생부자료기록: scan 영역 값 분포(actScNm2)', dist)
    continue
  }

  // 인식 검사: 쓰기 없음 (이 단계부터 개인정보 열 읽기를 셈)
  await resetReads()
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
  // clsNo가 있는 화면은 inspect·fill에서 stdntInfo도 읽지 않음 (학기말만 숫자 규칙으로 읽음)
  if (screen !== '학기말종합의견') eq(await allReads(), 0, `cpr실제 ${screen}: inspect·fill에서 stdntInfo 포함 개인정보 열 읽기 0`)
  ok((await mock('redraws', key)) >= 1, `cpr실제 ${screen}: grid.redraw`)
  const writeCols = await page.evaluate(() => Object.keys(window.__writeCols))
  const allowed = screen === '교과평가' ? ['evlCtrCd', 'evlCtrCn'] : [TEXT_COL[screen]]
  ok(typeof r.modifiedRows === 'number' && r.modifiedRows >= 21 && ins.modifiedRows === 0, `cpr실제 ${screen}: 바뀐 행 수 (인식 검사 0 → 입력 후 ${r.modifiedRows})`, { ins: ins.modifiedRows, r: r.modifiedRows })
  ok(writeCols.every((c) => allowed.includes(c)), `cpr실제 ${screen}: 쓴 열은 ${allowed.join('·')}만 (length·희망분야 안 씀)`, writeCols)
  const rows = await mock('rows', key)
  const states = await mock('states', key)
  if (screen === '교과평가') {
    const codes = rows.map((x) => x.evlCtrCd)
    eq(codes, ALL21.flatMap(() => ['B', 'A', 'D']), 'cpr실제 교과평가: 63행 모두 단계 코드(라벨→코드, 띄어쓰기 무시)')
    eq(rows.map((x) => x.evlCtrCn), ALL21.flatMap((s) => [`c1-${s}`, `c2-${s}`, `c3-${s}`]), 'cpr실제 교과평가: 덮어쓰기 → 나이스 자동 문구도 데이터 평가결과로')
    eq(r.autoFilled, 21, 'cpr실제 교과평가: 자동 채움 21칸 보고')
    ok(states.every((x) => x === 4), 'cpr실제 교과평가: 모든 행 변경 상태(4 UPDATED)')
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
  if (screen === '학기말종합의견') ok(ka && ka.datasetSample.every((x) => x.stdntCn === '[비숫자]' && /^3\/\d+$/.test(x.stdntInfo) && /^\[len=\d+\]$/.test(x.gnrlzOpiCn)), 'cpr실제 학기말: scan 숫자 규칙·글자 수만', ka && ka.datasetSample)
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
  eq([rows[0].evlCtrCd, rows[61].evlCtrCd, rows[62].evlCtrCn], q === '&lvl=row' ? ['B0', 'A1', 'c3-21'] : ['B', 'A', 'c3-21'], `${label}: 코드·결과`)
  if (q === '&lvl=row') eq([await mock('selectCalls', 'm02'), await mock('selected', 'm02')], [6, undefined], `${label}: 행마다 고른 뒤 원래 선택(없음)으로 되돌림`)
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
  await openCpr('자율활동관리')
  const p = page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('자율활동관리', ALL21, { mode: 'overwrite', save: true, delayMs: 400 }))
  await sleep(100)
  await page.keyboard.press('Shift')
  const r = await p
  ok(r.aborted === true && r.filled < 21 && r.saved === false && (await page.evaluate(() => window.__saveClicks)) === 0, '중지(cpr): 멈추고 저장 안 함', r)
}

// ---------- 쓰기 안전 (리뷰 반영) ----------
const showTab = (t) => page.evaluate((t) => { for (const s of document.querySelectorAll('section.mdi-tab')) if (s.dataset.tab === t) s.style.display = 'block' }, t)
const hideTab = (t) => page.evaluate((t) => { for (const s of document.querySelectorAll('section.mdi-tab')) if (s.dataset.tab === t) s.style.display = 'none' }, t)
const nothingWritten = async (snap, label) => {
  ok((await mock('snapshot')) === snap, `${label}: 데이터 그대로`)
  eq(await page.evaluate(() => [Object.keys(window.__writeCols).length, window.__saveClicks]), [0, 0], `${label}: 쓰기·저장 0`)
}
{
  console.log('[쓰기 안전] 같은 화면 앱 둘이 보이고 MDI를 못 읽음')
  await openCpr('진로활동관리', '&dup=1&nomdi=1')
  await showTab('진로(이전)')
  await page.evaluate(() => document.querySelectorAll('[data-app]').forEach((s) => (s.style.display = 'block')))
  const snap = await mock('snapshot')
  const d = await page.evaluate(() => window.__sgbNeis.detect({ screen: '진로활동관리' }))
  ok(d.ready === false && d.blocked === 'active-app-ambiguous' && d.warnings.includes('active-app-ambiguous'), '둘 다 보임: detect 막힘', d)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', [1, 2], { mode: 'overwrite', save: true }))
  ok(r.error === 'active-app-ambiguous' && r.warnings.includes('active-app-ambiguous'), '둘 다 보임: fill 거부 + warnings', r)
  await nothingWritten(snap, '둘 다 보임')
}
{
  console.log('[쓰기 안전] MDI 선택 탭(행동특성)과 보이는 앱(진로)이 다름')
  await openCpr('행동특성')
  await showTab('진로활동관리')
  await hideTab('행동특성')
  const snap = await mock('snapshot')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', [1, 2], { mode: 'overwrite', save: true }))
  eq(r.error, 'active-app-ambiguous', 'MDI 충돌: 거부')
  await nothingWritten(snap, 'MDI 충돌')
}
{
  console.log('[쓰기 안전] 교과평가(MDI) + 학기말이 함께 보이는데 학기말 데이터')
  await openCpr('교과평가')
  await showTab('학기말종합의견')
  const snap = await mock('snapshot')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학기말종합의견', [1, 2], { mode: 'overwrite', save: true }))
  eq(r.error, 'screen-mismatch', '두 화면 보임 + 다른 데이터: screen-mismatch')
  await nothingWritten(snap, '두 화면 보임')
}
for (const [vis, forced] of [['진로활동관리', '동아리활동관리'], ['동아리활동관리', '진로활동관리'], ['행동특성', '학기말종합의견']]) {
  console.log(`[쓰기 안전] 화면 지정 ${forced} ≠ 보이는 화면 ${vis}`)
  await openCpr(vis)
  const snap = await mock('snapshot')
  const d = await page.evaluate((s) => window.__sgbNeis.detect({ screen: s }), forced)
  ok(d.ready === false && d.blocked === 'screen-mismatch' && d.detectedScreen === vis && d.warnings.includes('screen-mismatch'), `지정 ${forced}/보임 ${vis}: detect 막힘`, d)
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob(forced, [1, 2]))
  eq(ins.error, 'screen-mismatch', `지정 ${forced}/보임 ${vis}: inspect 오류`)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob(forced, [1, 2], { mode: 'overwrite', save: true }))
  eq(r.error, 'screen-mismatch', `지정 ${forced}/보임 ${vis}: fill 거부`)
  await nothingWritten(snap, `지정 ${forced}/보임 ${vis}`)
}
{
  console.log('[쓰기 안전] 데이터 열이 예상과 다름 (행동특성 clsNo 없음)')
  await page.goto(MOCK('행동특성') + '&cpr=1')
  await page.evaluate(() => {
    const ds = window.__mock.grid('beh').dataSet
    const orig = ds.getColumnNames.bind(ds)
    ds.getColumnNames = () => orig().filter((c) => c !== 'clsNo')
  })
  await page.addScriptTag({ path: ENGINE })
  const snap = await mock('snapshot')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('행동특성', [1, 2, 3], { mode: 'overwrite', save: true }))
  ok(r.warnings.includes('known-columns-missing') && r.strategy !== 'cpr' && r.strategy !== 'cpr-known' && r.saved === false, '열 다름: 다른 cpr 표로 넘어가지 않음', r)
  await nothingWritten(snap, '열 다름')
}
{
  console.log('[쓰기 안전] 성취기준 글자 열이 없어도 코드 열로 (lvl 정상)')
  await page.goto(MOCK('교과평가') + '&cpr=1')
  await page.evaluate(() => {
    const ds = window.__mock.grid('m02').dataSet
    const orig = ds.getColumnNames.bind(ds)
    ds.getColumnNames = () => orig().filter((c) => c !== 'sccesCtrCn')
  })
  await page.addScriptTag({ path: ENGINE })
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1], { mode: 'overwrite', save: false }))
  ok(r.strategy === 'cpr-known' && r.cells === 6 && (await mock('rows', 'm02'))[0].evlCtrCd === 'B', '성취기준 코드 열만: 데이터셋 방식', r)
}
{
  console.log('[쓰기 안전] 1차 cpr 방식도 단계 코드를 짐작하지 않음')
  await page.goto(MOCK('교과평가') + '&cpr=legacy')
  await page.addScriptTag({ path: ENGINE })
  const job = jobFor('교과평가', { mode: 'overwrite', save: true })
  job.rows.forEach((r) => (r.standards[0].level = '아주잘함'))
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), job)
  ok(r.error === 'level-code-unknown' && r.strategy === 'cpr' && r.notes.some((n) => n.includes('아주잘함')), '1차 cpr: 단계 코드 없음 → 중단', r)
  ok((await page.evaluate(() => window.__cprData.every((x) => x.LVL_CD === '' || x.LVL_CD === '3'))) && (await counters(page)).save === 0, '1차 cpr: 쓰기·저장 없음')
}
{
  console.log('[저장] btnSave 비활성 / 안쪽 앱 저장 버튼 숨김')
  await openCpr('진로활동관리')
  await page.evaluate(() => (window.__mock.app('car').lookup('btnSave').enabled = false))
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', [1, 3], { mode: 'overwrite', save: true }))
  ok(r.saved === false && r.notes.includes('저장 버튼이 비활성') && r.cells === 2, '비활성: 저장 안 누름 + 안내', r)
  eq(await page.evaluate(() => window.__saveClicks), 0, '비활성: 화면의 다른 "저장"도 누르지 않음')
  await openCpr('교과평가', '&m02btn=hidden')
  const r2 = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1], { mode: 'overwrite', save: true }))
  ok(r2.saved, '안쪽 저장 버튼 숨김: 저장', r2)
  eq(await page.evaluate(() => window.__saveByApp), { 'edu/sw/els/scr/es/els_scres00_m00$1': 1 }, '안쪽 저장 버튼 숨김: 바깥 앱(m00) btnSave')
}
{
  console.log('[중지] 화면을 누르면 멈춤')
  await openCpr('자율활동관리')
  const p = page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('자율활동관리', ALL21, { mode: 'overwrite', save: true, delayMs: 400 }))
  await sleep(100)
  await page.mouse.click(5, 5)
  const r = await p
  ok(r.aborted === true && r.filled < 21 && r.saved === false && (await page.evaluate(() => window.__saveClicks)) === 0, '누르면 중지: 저장 안 함', r)
}
{
  console.log('[교과평가] 빈 칸만 · 이미 다른 단계')
  await openCpr('교과평가', '&prelvl=1')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [4], { mode: 'empty', save: false }))
  const rows = (await mock('rows', 'm02')).slice(9, 12).map((x) => x.evlCtrCd + '/' + x.evlCtrCn)
  eq(rows, ['B/나이스 기준문 B', 'C/', 'D/c3-4'], '다른 단계(C)가 있는 행은 평가결과를 넣지 않음')
  ok(r.levelConflict === 1 && r.notes.some((n) => n.includes('단계가 이미 있는 행 1개')), '다른 단계: 안내', r)
}
{
  console.log('[인식 검사] 행 선택을 바꾸지 않음 · 단계 옆 열')
  await openCpr('교과평가', '&lvl=row')
  await page.evaluate(() => window.__mock.select('m02', 5))
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob('교과평가', [1, 2]))
  // 인식 검사: 서로 다른 성취기준 두 행을 잠깐 골라 항목을 읽고 원래 선택(5)으로 되돌림
  eq([await mock('selectCalls', 'm02'), await mock('selected', 'm02')], [4, 5], '인식 검사: 두 행을 골랐다가 원래 선택(5)으로')
  ok(JSON.stringify(ins.levelCodes) === JSON.stringify({ 매우잘함: 'A0', 잘함: 'B0', 보통: 'C0', 노력요함: 'D0' }) && ins.levelProbe && ins.levelProbe.restored && ins.notes.some((n) => n.includes('성취기준마다 다릅니다')), '인식 검사: 행을 골라 읽은 단계 코드 + 성취기준마다 다름 안내', ins)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 2], { mode: 'overwrite', save: false }))
  ok(!r.error && r.cells === 12, '행마다 항목: 입력', r)
  eq([await mock('selectCalls', 'm02'), await mock('selected', 'm02')], [11, 5], '입력: 행마다 고르고 원래 선택(5)으로 되돌림')
  await openCpr('교과평가')
  const ins2 = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob('교과평가', [1]))
  eq(ins2.levelSideColumns, { rows: 1, evlCtrNm: 1, evlLvlCd: 1, evlLvlNm: 1 }, '인식 검사: 단계가 있는 행의 단계 이름·성취수준 열')
}

// ---------- 3차: 행마다 단계 항목 · 성취기준 짝짓기 · 변경 상태 · 이어쓰기 · 자율활동관리 구간 · 지원하지 않는 화면 ----------
const evalRows = () => mock('rows', 'm02')
{
  console.log('[3차] 교과평가 · 행마다 단계 항목 (selectRows 뒤 불러옴, 콤보로 고르면 나이스가 평가결과 채움)')
  await openCpr('교과평가', '&lvl=row')
  await page.evaluate(() => window.__mock.select('m02', 7))
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 3], { mode: 'empty', save: true }))
  const rows = await evalRows()
  const got = [0, 1, 2, 6, 7, 8].map((i) => rows[i].evlCtrCd + '/' + rows[i].evlCtrCn)
  eq(got, ['B0/나이스 기준문 B0', 'A1/나이스 기준문 A1', 'D2/나이스 기준문 D2', 'B0/나이스 기준문 B0', 'A1/나이스 기준문 A1', 'D2/나이스 기준문 D2'], '행마다: 성취기준마다 다른 코드 · "노력요함 : …" 항목도 찾음 · 나이스가 채운 평가결과 유지(빈 칸만)')
  ok(r.autoFilled === 6 && r.levelUnavailable === 0 && r.saved && r.modifiedRows === 6, '행마다: 자동 채움 6 · 저장 · 바뀐 행 6', r)
  ok((await page.evaluate(() => window.__comboPuts)) === 6, '행마다: 고른 행의 콤보로 골랐음 (나이스 변경 처리)')
  eq(await mock('selected', 'm02'), 7, '행마다: 원래 고른 행(7)으로 되돌림')
  ok(r.notes.some((n) => n.includes('행마다 골라') && n.includes('selectRows')), '행마다: 안내', r.notes)

  await openCpr('교과평가', '&lvl=row')
  const r2 = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [2], { mode: 'overwrite', save: false }))
  const rows2 = await evalRows()
  eq([3, 4, 5].map((i) => rows2[i].evlCtrCd + '/' + rows2[i].evlCtrCn), ['B0/c1-2', 'A1/c2-2', 'D2/c3-2'], '행마다 덮어쓰기: 데이터 평가결과로')
  ok(!r2.error && r2.verifyFailed === 0, '행마다 덮어쓰기: 확인', r2)
}
{
  console.log('[3차] 교과평가 · focusCell로만 항목이 나옴')
  await openCpr('교과평가', '&lvl=rowfocus')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1], { mode: 'overwrite', save: false }))
  const rows = await evalRows()
  ok(!r.error && r.cells === 6 && rows[0].evlCtrCd === 'B0' && rows[2].evlCtrCd === 'D2', 'focusCell: 입력', r)
  ok((await mock('focusCalls', 'm02')) >= 3 && r.notes.some((n) => n.includes('focusCell')), 'focusCell: 방법 기억', r.notes)
}
{
  console.log('[3차] 교과평가 · 한 성취기준은 항목이 안 나옴 → 그 행만 건너뜀')
  await openCpr('교과평가', '&lvl=rowsome')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1, 2], { mode: 'overwrite', save: true }))
  const rows = await evalRows()
  eq([0, 1, 2, 3, 4, 5].map((i) => rows[i].evlCtrCd + '/' + rows[i].evlCtrCn), ['B0/c1-1', 'A1/c2-1', '/', 'B0/c1-2', 'A1/c2-2', '/'], '항목 없는 행: 단계·평가결과 모두 건너뜀')
  ok(!r.error && r.levelUnavailable === 2 && r.saved && r.notes.some((n) => n.includes('건너뛴 행 2개') && n.includes('1, 2번')), '항목 없는 행: levelUnavailable 2 · 나머지 저장', r)
}
{
  console.log('[3차] 교과평가 · 성취기준 코드 열 끝 공백 (sccesCtrCd "6국05-01 ")')
  await openCpr('교과평가', '&stdcode=space')
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob('교과평가', [1, 2]))
  ok(ins.pairingHow && ins.pairingHow.code === 6 && ins.pairingHow.order === 0, '끝 공백: 코드로 짝지음', ins.pairingHow)
}
{
  console.log('[3차] 교과평가 · 성취기준 칸에 코드 없음 (내부 코드 "12임… ") → 순서·영역·본문으로')
  await openCpr('교과평가', '&stdcode=real')
  // 순서
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), cprJob('교과평가', [1, 2]))
  ok(ins.pairingHow && ins.pairingHow.order === 6 && ins.notes.some((n) => n.includes('성취기준을 순서로 맞춤')), '코드 없음: 순서로 짝짓고 안내', ins)
  ok(ins.pairing.length === 6 && ins.pairing.every((x) => x.how === 'order' && x.neisLen > 10 && !/\[/.test(x.neisText)) && ins.pairing[2].area === '문법', '코드 없음: 짝 목록(행·영역·글자 수)', ins.pairing)
  let r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [1], { mode: 'overwrite', save: false }))
  let rows = await evalRows()
  eq([0, 1, 2].map((i) => rows[i].evlCtrCd + '/' + rows[i].evlCtrCn), ['B/c1-1', 'A/c2-1', 'D/c3-1'], '코드 없음: 순서대로 입력')
  ok(r.notes.some((n) => n.includes('순서로 맞춤')), '코드 없음: 입력 결과에도 안내', r.notes)
  // 영역이 있으면 데이터 순서가 달라도 영역으로
  await openCpr('교과평가', '&stdcode=real')
  const areaJob = cprJob('교과평가', [2], { mode: 'overwrite', save: false })
  areaJob.rows[0].standards = [
    { code: '[6국05-03]', level: '보통', criterion: 'c3', area: '문법' },
    { code: '[6국05-01]', level: '잘함', criterion: 'c1', area: '문학' },
    { code: '[6국05-02]', level: '매우잘함', criterion: 'c2', area: '매체' },
  ]
  r = await page.evaluate((j) => window.__sgbNeis.fill(j), areaJob)
  rows = await evalRows()
  eq([3, 4, 5].map((i) => rows[i].evlCtrCd + '/' + rows[i].evlCtrCn), ['B/c1', 'A/c2', 'C/c3'], '코드 없음 + 영역: 영역으로 짝지음')
  // 성취기준 본문이 있으면 본문으로
  await openCpr('교과평가', '&stdcode=real')
  const textJob = cprJob('교과평가', [3], { mode: 'overwrite', save: false })
  textJob.rows[0].standards = [
    { code: '[6국05-02]', level: '매우잘함', criterion: 't2', text: '[6국05-02] 작품의 구성 요소를 이해하며 작품을 감상한다.' },
    { code: '[6국05-01]', level: '잘함', criterion: 't1', text: '작품 속 인물의 삶을 찾고 자신의 삶과 관련지어 이해한다' },
  ]
  const ti = await page.evaluate((j) => window.__sgbNeis.inspect(j), textJob)
  ok(ti.pairingHow.text === 2 && ti.unmatchedStandards.length === 0, '코드 없음 + 본문: 본문으로 짝지음', ti.pairingHow)
  r = await page.evaluate((j) => window.__sgbNeis.fill(j), textJob)
  rows = await evalRows()
  eq([6, 7, 8].map((i) => rows[i].evlCtrCd + '/' + rows[i].evlCtrCn), ['B/t1', 'A/t2', '/'], '코드 없음 + 본문: 맞는 행에만')
  // 개수가 다르고 영역이 없으면 순서로 맞추지 않음
  await openCpr('교과평가', '&stdcode=real')
  const fewJob = cprJob('교과평가', [4], { mode: 'overwrite', save: false })
  fewJob.rows[0].standards = fewJob.rows[0].standards.slice(0, 2)
  const fi = await page.evaluate((j) => window.__sgbNeis.inspect(j), fewJob)
  ok(fi.tasks === 0 && fi.unmatchedStandards.length === 2 && fi.notes.some((n) => n.includes('순서로 맞추지 못한 학생: 4번')), '코드 없음 + 개수 다름: 짝짓지 않음', fi)
}
{
  console.log('[3차] 변경 상태로 안 바뀌면 저장 안 함')
  await openCpr('진로활동관리', '&nostate=1')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('진로활동관리', [1, 3], { mode: 'overwrite', save: true }))
  ok(r.cells === 2 && r.modifiedRows === 0 && r.saved === false && r.notes.some((n) => n.includes('변경 상태로 바뀌지 않아')), 'nostate: 저장 안 누름 + 안내', r)
  eq(await page.evaluate(() => window.__saveClicks), 0, 'nostate: 저장 클릭 0')
}
{
  console.log('[3차] 구조 수집 · 단계 콤보 확인 · 데이터 컨트롤 · 값 분포')
  await openCpr('교과평가', '&lvl=row')
  await resetReads()
  const scan = await page.evaluate(() => window.__sgbNeis.scan())
  const sj = JSON.stringify(scan)
  ok(!FAKE.some((f) => sj.includes(f)), '구조 수집: 개인정보 값 없음 (개인정보 데이터셋·이름 같은 값 제외)', FAKE.filter((f) => sj.includes(f)))
  eq(await personalReads(), 0, '구조 수집: 개인정보 열 읽기 0')
  const lp = scan.known.levelProbe
  ok(lp && lp.itemsAtRest.length === 0 && lp.itemsAfterSelect.map((x) => x.value).join() === 'A0,B0,C0,D0' && lp.rows.length === 2 && lp.rows[1].items.map((x) => x.value).join() === 'A1,B1,C1,D1' && lp.restored === true, '구조 수집: 쉴 때 항목 없음 → 행 0·1을 골라 성취기준마다 다른 항목', lp)
  eq(await mock('selected', 'm02'), undefined, '구조 수집: 원래 선택(없음)으로 되돌림')
  const dcs = scan.known.dataControls[0].list
  const byId = Object.fromEntries(dcs.map((x) => [x.id, x]))
  ok(byId.dsEvlCria && byId.dsEvlCria.rows && byId.dsEvlCria.rows.length === 4 && byId.dsEvlCria.rows[0].evlCtrNm === '매우잘함', '구조 수집: 작은 코드표는 값까지', byId.dsEvlCria)
  ok(byId.dsStdntList && byId.dsStdntList.personal && !byId.dsStdntList.rows && byId.dsStdntList.columnNames.includes('[개인정보]'), '구조 수집: 개인정보 열이 있는 데이터셋은 값 없이', byId.dsStdntList)
  ok(byId.dsPrsn && !byId.dsPrsn.rows && byId.dsPrsn.rowsWithheld === 'name-like', '구조 수집: 이름 같은 값이 있으면 값 없이', byId.dsPrsn)
  ok(byId.dsMain && !byId.dsMain.rows && byId.dsMain.rowCount === 63, '구조 수집: 화면 표 데이터셋은 열·행 수만', byId.dsMain)
  const ka = scan.known.apps.find((x) => x.id === APP['교과평가'])
  ok(ka.distinct.evlLvlCd && ka.distinct.evlLvlCd.values[0].value === '4단계' && ka.distinct.evlLvlCd.values[0].count === 63 && ka.distinct.relmNm, '구조 수집: 범주 열 값 분포', ka.distinct)
  ok(!('sccesCtrCn' in ka.distinct) && !('stdntInfo' in ka.distinct), '구조 수집: 값 분포는 정한 열만')
}
{
  console.log('[3차] 지원하지 않는 화면 (MDI 선택 탭이 알려지지 않은 edu/ 앱)')
  await openCpr('미지원')
  const snap = await mock('snapshot')
  const d = await page.evaluate(() => window.__sgbNeis.detect())
  ok(d.screen === 'unknown' && d.blocked === 'unsupported-screen' && d.mdiSelected === 'edu/sw/els/sdl/zz/els_sdlzz99_m00$1' && !d.ready, '미지원: 제목·숨은 탭으로 짐작하지 않고 unknown', d)
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('동아리활동관리', [1, 2], { mode: 'overwrite', save: true }))
  ok(r.error === 'unsupported-screen' && r.notes.some((n) => n.includes('els_sdlzz99_m00')), '미지원: 화면 지정이 있어도 입력 거부', r)
  ok((await mock('snapshot')) === snap && (await page.evaluate(() => window.__saveClicks)) === 0, '미지원: 쓰기·저장 없음')
  const scan = await page.evaluate(() => window.__sgbNeis.scan())
  const sj = JSON.stringify(scan)
  const u = scan.known.unknownApps.find((x) => x.id === 'edu/sw/els/sdl/zz/els_sdlzz99_m00$1')
  ok(u && u.visible === true && u.buttons.includes('btnSave') && u.inputs.some((x) => x.id === 'txaMemo' && x.bind === 'speclActSpablMteCn') && u.inputs.some((x) => x.id === 'cmbKind'), '미지원: 구조 수집에 버튼·입력 컨트롤·연결 열', u)
  ok(u && u.grids[0].rowCount === 21 && u.grids[0].columnNames.includes('[개인정보]') && u.grids[0].headerCols.some((h) => h && h.text === '[개인정보]') && u.grids[0].detailCols.length === 4, '미지원: 표 열 정보(개인정보 가림)', u && u.grids[0])
  ok(!FAKE.some((f) => sj.includes(f)), '미지원: 구조 수집에 개인정보 없음')
}

// --- 이어쓰기 (1학기 글 뒤에 2학기 글) ---
const behText = async (i) => (await mock('rows', 'beh'))[i].gnrlzOpiCn
for (const [joiner, label] of [['', '바로 이어서'], [' ', '띄어쓰기 한 칸'], ['\n', '줄바꿈 한 번'], ['\n\n', '줄바꿈 두 번'], [' / ', '직접 입력']]) {
  console.log(`[3차] 이어쓰기 · 행동특성 · ${label}`)
  await openCpr('행동특성')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('행동특성', [1, 2], { mode: 'append', joiner, save: true }))
  eq([await behText(0), await behText(1)], ['행동특성 문장 1', '기존 행발' + joiner + '행동특성 문장 2'], `이어쓰기 ${label}: 빈 칸은 새 글만, 기존 글 뒤에 이음`)
  ok(r.mode === 'append' && r.joiner === joiner && r.saved && r.cells === 2, `이어쓰기 ${label}: 결과`, r)
  eq(await page.evaluate(() => Object.keys(window.__writeCols)), ['gnrlzOpiCn'], `이어쓰기 ${label}: 글자수(length) 열은 쓰지 않음`)
  if (joiner === '\n') {
    // 다시 실행해도 두 번 붙이지 않음
    const again = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('행동특성', [1, 2], { mode: 'append', joiner, save: true }))
    ok(again.cells === 0 && again.already === 2 && again.saved === false && again.notes.some((n) => n.includes('이미 이어져 있음')), '이어쓰기: 다시 실행 → 이미 이어져 있음', again)
    eq(await behText(1), '기존 행발\n행동특성 문장 2', '이어쓰기: 다시 실행해도 그대로')
  }
}
{
  console.log('[3차] 이어쓰기 · 교과평가·학기말에서는 빈 칸만으로')
  await openCpr('학기말종합의견')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('학기말종합의견', [1, 2], { mode: 'append', joiner: ' ', save: false }))
  const rows = await mock('rows', 'sem')
  ok(r.mode === 'empty' && rows[0].gnrlzOpiCn === '학기말종합의견 문장 1' && rows[1].gnrlzOpiCn === '기존 의견' && r.notes.some((n) => n.includes('이어쓰기는 이 화면에서 쓰지 않습니다')), '학기말: 이어쓰기 → 빈 칸만 + 안내', r)
  await openCpr('교과평가')
  const r2 = await page.evaluate((j) => window.__sgbNeis.fill(j), cprJob('교과평가', [2], { mode: 'append', joiner: ' ', save: false }))
  const e = await evalRows()
  ok(r2.mode === 'empty' && e[3].evlCtrCn === '기존 결과' && r2.notes.some((n) => n.includes('이어쓰기는 이 화면에서 쓰지 않습니다')), '교과평가: 이어쓰기 → 빈 칸만', r2)
}
{
  console.log('[3차] 인식 검사 · 글 길이(바이트)와 참고용 바이트 초과 알림')
  await openCpr('행동특성')
  const long = '가'.repeat(500) // 1500바이트
  const job = cprJob('행동특성', [1, 2], { mode: 'append', joiner: ' ' })
  job.rows[1].text = long
  const snap = await mock('snapshot')
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), job)
  const l2 = ins.lengths.find((x) => x.student === 2)
  ok(ins.referenceBytes === 1500 && l2.existing === byte('기존 행발') && l2.add === 1500 && l2.combined === byte('기존 행발') + 1 + 1500 && l2.over === true && !ins.lengths.find((x) => x.student === 1).over, '인식 검사: 기존·새·합친 바이트', ins.lengths)
  ok(ins.warnings.includes('over-reference-bytes') && ins.notes.some((n) => n.includes('참고용 1500바이트') && n.includes('2번')), '인식 검사: 참고용 초과 알림', ins)
  eq(await mock('snapshot'), snap, '인식 검사: 쓰지 않음')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, save: false })
  ok(!r.error && r.cells === 2, '참고용 초과는 막지 않음', r)
}

// --- 자율활동관리: 자율 구간 · 동아리 구간 따로 이어쓰기 ---
const EX1 = '레이저서바이벌 체험활동에서 협동의 중요성을 알고 노력함. 교내 화재 발생 시 대피 요령을 터득함.'
const EX2 = '(문화예술부(6-5)) 영화를 시청하며 등장인물의 감정 변화를 파악함.'
const autSet = (i, v) => mock('setText', ['aut', i, 'speclActSpablMteCn', v])
const autGet = async (i) => (await mock('rows', 'aut'))[i].speclActSpablMteCn
const autJob = (aut, club, extra = {}) => ({
  screen: '자율활동관리',
  creative: '자율',
  mode: 'append',
  joiner: ' ',
  delayMs: 0,
  rows: Object.entries(aut).map(([s, text]) => ({ student: Number(s), text })),
  clubRows: club ? Object.entries(club).map(([s, text]) => ({ student: Number(s), text })) : undefined,
  ...extra,
})
{
  console.log('[3차] 자율활동관리 · 구간별 이어쓰기')
  await openCpr('자율활동관리')
  await autSet(0, EX1 + '\n\n' + EX2) // 1번: 예시 (자율 + 동아리)
  await autSet(1, EX1 + '\n\n' + EX2) // 2번: 자율만 이어씀
  await autSet(2, 'a1 문장.\n\na2 문장.\n\n(과학부(6-3)) c1 문장.') // 3번: 세 구간
  await autSet(3, 'x1 문장.\r\n\r\n(체육부(6-1)) y1 문장.') // 4번: CRLF
  await autSet(4, '') // 5번: 빈 칸
  const job = autJob(
    { 1: '자율2 문장.', 2: '자율2 문장.', 3: 'A 문장.', 4: 'X 문장.', 5: '새 자율.' },
    { 1: '동아리2 문장.', 3: 'C 문장.', 4: 'Y 문장.' },
  )
  const ins = await page.evaluate((j) => window.__sgbNeis.inspect(j), job)
  const L = Object.fromEntries(ins.lengths.map((x) => [x.student, x]))
  ok(L[1].sections === 2 && L[1].hasClubSection && L[3].sections === 3 && L[3].hasClubSection && L[5].sections === 0 && L[1].autBytes === byte(EX1) && L[1].clubBytes === byte(EX2) && L[1].addClub === byte('동아리2 문장.'), '자율 인식 검사: 구간 수·동아리 구간·구간별 바이트', ins.lengths)
  ok(!JSON.stringify(ins).includes('레이저') && !JSON.stringify(ins).includes('문화예술부'), '자율 인식 검사: 구간 글자는 보여 주지 않음')
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, save: true })
  eq(await autGet(0), EX1 + ' 자율2 문장.\n\n' + EX2 + ' 동아리2 문장.', '자율 예시: 각 구간 끝에 이어씀 (빈 줄 유지)')
  eq(await autGet(1), EX1 + ' 자율2 문장.\n\n' + EX2, '자율만: 동아리 구간 그대로')
  eq(await autGet(2), 'a1 문장.\n\na2 문장. A 문장.\n\n(과학부(6-3)) c1 문장. C 문장.', '세 구간: 괄호로 동아리 구간 찾음')
  eq(await autGet(3), 'x1 문장. X 문장.\r\n\r\n(체육부(6-1)) y1 문장. Y 문장.', 'CRLF 구분 유지')
  eq(await autGet(4), '새 자율.', '빈 칸: 새 글만')
  ok(r.saved && r.cells === 5 && r.mode === 'append', '자율활동관리: 저장', r)
  eq(await page.evaluate(() => window.__saveByApp), { [APP['자율활동관리']]: 1 }, '자율활동관리: 이 앱의 btnSave')
  // 다시 실행: 구간마다 이미 이어져 있음
  const again = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, save: true })
  ok(again.cells === 0 && again.already === 5 && again.saved === false, '자율 다시 실행: 두 번 붙이지 않음', again)
  eq(await autGet(0), EX1 + ' 자율2 문장.\n\n' + EX2 + ' 동아리2 문장.', '자율 다시 실행: 그대로')
}
{
  console.log('[3차] 자율활동관리 · 동아리 데이터만 (동아리 구간)')
  await openCpr('자율활동관리')
  await autSet(0, EX1 + '\n\n' + EX2)
  await autSet(1, '자율만 있음.')
  const job = { screen: '자율활동관리', creative: '동아리', mode: 'append', joiner: '\n', delayMs: 0, save: false, rows: [{ student: 1, text: '동아리2 문장.' }, { student: 2, text: '동아리 새 문장.' }] }
  const r = await page.evaluate((j) => window.__sgbNeis.fill(j), job)
  eq(await autGet(0), EX1 + '\n\n' + EX2 + '\n동아리2 문장.', '동아리만: 동아리 구간 끝에')
  eq(await autGet(1), '자율만 있음.\n\n동아리 새 문장.', '동아리만 · 동아리 구간 없음: 새 구간')
  ok(r.notes.some((n) => n.includes('괄호가 없어 새 구간으로 추가함') && n.includes('2번')), '동아리만: 부서명 괄호 없음 안내', r.notes)
  const bad = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, mode: 'overwrite' })
  eq(bad.error, 'club-append-only', '동아리 데이터는 이어쓰기로만')
  const wrong = await page.evaluate((j) => window.__sgbNeis.fill(j), { ...job, creative: '진로' })
  eq(wrong.error, 'area-mismatch', '진로 데이터는 자율활동관리에 넣지 않음')
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
ok(await popup.locator('#mode-append-item').isHidden(), 'e2e: 교과평가에서는 이어쓰기 숨김')
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

// 이어쓰기 · 이음 고르기 → 기억 (chrome.storage.local fillPrefs)
ok(await popup.locator('#mode-append-item').isVisible(), 'e2e: 행동특성에서는 이어쓰기 보임')
ok(await popup.locator('#joiner-row').isHidden(), 'e2e: 이어쓰기 전에는 이음 숨김')
await popup.click('#mode-append-item')
ok(await popup.locator('#joiner-row').isVisible(), 'e2e: 이어쓰기면 이음 보임')
await popup.selectOption('#fill-joiner', 'custom')
ok(await popup.locator('#joiner-custom-row').isVisible(), 'e2e: 직접 입력 칸')
await popup.fill('#joiner-custom', ' // ')
await popup.selectOption('#fill-joiner', 'nl1')
await sleep(200)
{
  const fp = (await swState()).fillPrefs || {}
  eq([fp.mode, fp.joiner, fp.custom], ['append', 'nl1', ' // '], 'e2e: 입력 방식·이음 저장')
}
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-name').textContent.includes('행동특성'), null, { timeout: 15000 })
ok((await popup.evaluate(() => [document.querySelector('input[name=mode]:checked').value, document.getElementById('fill-joiner').value, document.getElementById('joiner-custom').value].join('|'))) === 'append|nl1| // ', 'e2e: 팝업을 다시 열어도 기억')
await popup.waitForFunction(() => !document.getElementById('btn-preview').disabled, null, { timeout: 5000 })
await popup.click('#btn-preview')
await popup.waitForFunction(() => document.getElementById('log').textContent.includes('입력 방식'), null, { timeout: 30000 })
const alog = await popup.locator('#log').innerText()
ok(alog.includes('입력 방식: 이어쓰기 · 줄바꿈 한 번') && alog.includes('이미 이어져 있음'), 'e2e: 이어쓰기 결과 로그 (방식 요약 · 이미 이어진 칸)', alog)
eq(await neisPage.evaluate(() => window.__mock.rows('beh').slice(0, 3).map((r) => r.gnrlzOpiCn)), ['행발 1번 문장임.', '기존 행발\n행발 2번 문장임.', '행발 3번 문장임.'], 'e2e: 이어쓰기 (줄바꿈 한 번)')

// 자율활동관리: 자율 데이터 + 동아리 문장도 같은 칸의 동아리 구간에
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?cpr=1&screen=' + encodeURIComponent('자율활동관리'))
await neisPage.waitForLoadState('load')
await neisPage.evaluate(() => (window.__mock.rows('aut'), window.__mock.setText(['aut', 0, 'speclActSpablMteCn', '1학기 자율.\n\n(과학부(6-3)) 1학기 동아리.'])))
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-name').textContent.includes('자율활동관리'), null, { timeout: 15000 })
const aopts = await popup.locator('#fill-payload option').allInnerTexts()
ok(aopts.length === 3 && aopts[0] === '데이터를 고르세요' && aopts.some((o) => o.includes('자율')) && aopts.some((o) => o.includes('동아리')), 'e2e 자율: 자율·동아리 데이터', aopts)
const autIdx = await popup.evaluate(() => Array.from(document.querySelectorAll('#fill-payload option')).findIndex((o) => o.textContent.includes('자율')))
await popup.selectOption('#fill-payload', { index: autIdx })
ok(await popup.locator('#club-row').isVisible(), 'e2e 자율: 동아리 구간 이어쓰기 선택 보임')
await popup.check('#fill-club')
await popup.click('#btn-preview')
await popup.waitForFunction(() => document.getElementById('log').textContent.includes('입력 방식'), null, { timeout: 30000 })
eq(await neisPage.evaluate(() => window.__mock.rows('aut')[0].speclActSpablMteCn), '1학기 자율.\n자율 1번 문장임.\n\n(과학부(6-3)) 1학기 동아리.\n동아리 김철수 학생은 성실함.', 'e2e 자율: 구간마다 이어씀')
eq(await neisPage.evaluate(() => window.__mock.rows('aut')[1].speclActSpablMteCn), '기존 자율\n자율 2번 문장임.', 'e2e 자율: 동아리 문장 없는 학생은 자율 구간만')

// 학생부자료기록: 확인만 / 지원하지 않는 화면 안내
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?cpr=1&screen=' + encodeURIComponent('학생부자료기록'))
await neisPage.waitForLoadState('load')
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-status').textContent.includes('확인만'), null, { timeout: 15000 })
ok(await popup.locator('#btn-fill').isDisabled(), 'e2e 학생부자료기록: 확인만 · 입력 버튼 꺼짐')
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?cpr=1&screen=' + encodeURIComponent('미지원'))
await neisPage.waitForLoadState('load')
await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`)
await popup.waitForFunction(() => document.getElementById('screen-status').textContent.includes('지원하지 않는'), null, { timeout: 15000 })
ok((await popup.locator('#screen-status').innerText()).includes('els_sdlzz99_m00'), 'e2e 미지원: 앱 id와 구조 수집 안내')
{
  // content script가 3차 구조 수집 필드를 그대로 넘기는지 (단계 콤보 확인 · 데이터 컨트롤 · 값 분포 · 알려지지 않은 앱)
  const um = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'neis-command', tabId, cmd: 'scan' }), tabId)
  const uk = um.frames[0].scan.known
  ok(uk.unknownApps.length === 1 && uk.unknownApps[0].inputs.some((x) => x.id === 'txaMemo'), 'e2e 구조 수집: 알려지지 않은 앱 정보 전달', uk.unknownApps)
  await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?cpr=1&lvl=row&screen=' + encodeURIComponent('교과평가'))
  await neisPage.waitForLoadState('load')
  const sm = await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: 'neis-command', tabId, cmd: 'scan' }), tabId)
  const kk = sm.frames[0].scan.known
  ok(kk.levelProbe && kk.levelProbe.rows.length === 2 && kk.levelProbe.restored && kk.levelProbe.itemsAfterSelect.length === 4, 'e2e 구조 수집: 단계 콤보 확인 전달', kk.levelProbe)
  ok(kk.dataControls[0].list.some((x) => x.id === 'dsEvlCria' && x.rows && x.rows.length === 4) && kk.apps.some((a) => a.distinct && a.distinct.evlLvlCd), 'e2e 구조 수집: 데이터 컨트롤·값 분포 전달')
  ok(!FAKE.some((f) => JSON.stringify(sm).includes(f)), 'e2e 구조 수집: 개인정보 없음')
}

// 예전 엔진(0.1.0)이 남은 탭: 인식·구조 수집·입력 모두 engine-outdated
await neisPage.goto('https://sgb-test.neis.go.kr/edu/mock.do?screen=' + encodeURIComponent('행동특성'))
await neisPage.waitForLoadState('load')
await neisPage.evaluate(() => {
  window.__sgbNeis = { version: '0.1.0' }
  window.addEventListener('message', (e) => {
    const d = e.data
    if (e.source === window && d && typeof d.__sgb === 'string')
      window.postMessage({ __sgbReply: d.__sgb, result: d.cmd === 'ping' ? { ok: true, version: '0.1.0' } : { error: 'unknown-command' } }, '*')
  })
})
const outd = async (cmd, args) => popup.evaluate(([tabId, cmd, args]) => chrome.runtime.sendMessage({ type: 'neis-command', tabId, cmd, args }), [tabId, cmd, args])
eq((await outd('detect')).error, 'engine-outdated', 'e2e 예전 엔진: detect')
eq((await outd('scan')).error, 'engine-outdated', 'e2e 예전 엔진: 구조 수집은 빈 파일 대신 오류')
eq((await outd('fill', { screen: '행동특성', mode: 'overwrite', save: true, delayMs: 0, rows: [{ student: 1, text: '예전 엔진 글' }] })).error, 'engine-outdated', 'e2e 예전 엔진: 입력 거부')
ok((await readMock(neisPage, '행동특성')).every((x) => !x.text.includes('예전 엔진')) && (await counters(neisPage)).save === 0, 'e2e 예전 엔진: 쓰기·저장 없음')

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
