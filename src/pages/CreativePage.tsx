import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Card, CopyText, IssueList, PageHeader, Spinner, toast } from '@/components/ui'
import { PIIGate, usePIIGate } from '@/components/PIIGate'
import { useActivePlan, useClient, useStore } from '@/store'
import { asArray, generateJSON } from '@/llm/provider'
import { creativePrompt, SYSTEM_TEACHER } from '@/llm/prompts'
import { downloadXlsx } from '@/lib/excel'
import { hasErrors, validateComment } from '@/lib/validate'
import { buildCreativePayloads, neisByteLimit } from '@/lib/neis'
import { flatten, hash, neisBytes } from '@/lib/text'
import type { CreativeInput, CreativeResult } from '@/lib/types'

const CREATIVE_LIMIT = neisByteLimit('creative', 0)
const BASE_AREAS = ['자율', '동아리', '진로'] as const
const AREA_OPTIONS = [...BASE_AREAS, '기타']
const EXPLAIN = '확장 프로그램이 자율·진로는 학생부자료기록 · 진로활동관리에, 동아리는 동아리활동관리에 문장을 채웁니다(날짜 선택 없음).'
/** 평가계획의 영역 이름을 자율/동아리/진로/기타 중 하나로 */
const tagOf = (name?: string) => (!name ? '자율' : name.includes('동아리') ? '동아리' : name.includes('진로') ? '진로' : /자율|자치/.test(name) ? '자율' : '기타')
const clampCount = (n: number) => Math.max(1, Math.min(20, Math.round(n) || 1))

function parseResults(out: unknown): Array<{ original: string; variations: string[] }> {
  return asArray(out).map((x) => ({
    original: flatten(String(x?.original ?? '')),
    variations: (Array.isArray(x?.variations) ? x.variations : []).map((v: unknown) => flatten(String(v ?? ''))).filter(Boolean),
  }))
}

export default function CreativePage() {
  const plan = useActivePlan()
  const client = useClient()
  const settings = useStore((s) => s.settings)
  const inputs = useStore((s) => s.creativeInputs)
  const setInputs = useStore((s) => s.setCreativeInputs)
  const results = useStore((s) => s.creativeResults)
  const navigate = useNavigate()
  const studentCount = useStore((s) => s.studentCount)
  const setStudentCount = useStore((s) => s.setStudentCount)
  const assign = useStore((s) => s.creativeAssign)
  const setAssign = useStore((s) => s.setCreativeAssign)
  const setAssignBulk = useStore((s) => s.setCreativeAssignBulk)
  const clearAssign = useStore((s) => s.clearCreativeAssign)
  const stageNeisPayloads = useStore((s) => s.stageNeisPayloads)
  const [tab, setTab] = useState<string>('자율')
  const setResults = useStore((s) => s.setCreativeResults)

  const [area, setArea] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      if (!abortRef.current) return
      abortRef.current.abort()
      toast('다른 화면으로 이동해 창체 문장 생성을 중지했습니다')
    },
    [],
  )

  const areas = useMemo(() => plan?.creative ?? [], [plan])
  const curArea = areas.find((a) => a.area === area) ?? areas[0] ?? null

  const patch = (i: number, p: Partial<CreativeInput>) => setInputs(inputs.map((x, k) => (k === i ? { ...x, ...p } : x)))
  const remove = (i: number) => setInputs(inputs.length > 1 ? inputs.filter((_, k) => k !== i) : [{ text: '', count: inputs[0]?.count ?? 3, area: inputs[0]?.area }])
  const add = () => setInputs([...inputs, { text: '', count: inputs[inputs.length - 1]?.count ?? 3, area: tagOf(curArea?.area) }])

  const filled = inputs.map((x) => ({ text: flatten(x.text), count: clampCount(x.count) })).filter((x) => x.text)
  const totalWanted = filled.reduce((a, x) => a + x.count, 0)
  // 개인정보 검사: AI로 보내는 원문 문장
  const gate = usePIIGate(filled.map((x, i) => ({ label: `원문 ${inputs.findIndex((y) => flatten(y.text) === x.text) + 1 || i + 1}`, text: x.text })))

  const generate = async () => {
    if (running) return
    if (!client) return setError('설정에서 API 키와 모델을 먼저 선택하세요.')
    if (!filled.length) return setError('원문 문장을 하나 이상 입력하세요.')
    if (!gate.ok) return setError('개인정보로 보이는 표현을 먼저 확인해 주세요.')
    setError('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    try {
      const out = await generateJSON<unknown>(client, {
        system: SYSTEM_TEACHER,
        prompt: creativePrompt(filled, settings.ending),
        temperature: 0.9,
        maxTokens: 8000,
        signal: ctrl.signal,
      })
      const parsed = parseResults(out)
      const used = new Set<number>()
      const sameLength = parsed.length === filled.length
      const next: CreativeResult[] = filled.map((f, i) => {
        let j = parsed.findIndex((p, k) => !used.has(k) && p.original === f.text)
        if (j < 0 && sameLength && !used.has(i)) j = i
        if (j >= 0) used.add(j)
        return { original: f.text, variations: j >= 0 ? parsed[j].variations.slice(0, f.count) : [] }
      })
      if (next.every((r) => !r.variations.length)) throw new Error('AI 응답에서 문장을 찾지 못했습니다. 다시 시도해 주세요.')
      setResults(next)
      const short = next.filter((r, i) => r.variations.length < filled[i].count).length
      toast(short ? `생성 완료 · ${short}개 문장은 요청보다 적게 만들어졌습니다` : '생성 완료')
    } catch (e) {
      if (ctrl.signal.aborted) toast('중지했습니다')
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  const exportExcel = () => {
    const rows: Array<Record<string, string | number>> = []
    for (const r of results) for (const v of r.variations) rows.push({ 원문: r.original, '변형 문장': v, Bytes: neisBytes(v) })
    if (!rows.length) return toast('내보낼 문장이 없습니다')
    downloadXlsx(`창의적체험활동_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: '창체 문장', rows }])
  }

  const variationCount = results.reduce((a, r) => a + r.variations.length, 0)

  // ---- 학생 배정 ----
  const areaOfResult = (r: CreativeResult) => inputs.find((x) => flatten(x.text) === r.original)?.area ?? '자율'
  const poolOf = (a: string) => Array.from(new Set(results.filter((r) => areaOfResult(r) === a).flatMap((r) => r.variations)))
  const tabs = [...BASE_AREAS, ...Array.from(new Set([...inputs.map((x) => x.area ?? '자율'), ...Object.keys(assign)])).filter((a) => !(BASE_AREAS as readonly string[]).includes(a))] as string[]
  const students = Array.from({ length: studentCount }, (_, i) => i + 1)
  const cur = tabs.includes(tab) ? tab : '자율'
  const pool = poolOf(cur)
  const curAssign = assign[cur] ?? {}
  const textOf = (a: string, n: number) => (assign[a]?.[n] ?? '')
  const filledCount = (a: string) => students.filter((n) => flatten(textOf(a, n))).length
  const isEdited = (t: string) => !!t && !pool.includes(t)

  const autoAssign = (redo: boolean) => {
    if (!pool.length) return toast(`${cur} 영역으로 지정된 변형 문장이 없습니다`)
    if (redo && !confirm(`${cur} 영역의 배정을 모두 새로 정합니다(직접 수정한 문장 포함). 계속할까요?`)) return
    const offset = Math.floor(Math.random() * pool.length)
    const entries: Array<[number, string]> = []
    for (const n of students) {
      const t = curAssign[n] ?? ''
      if (!redo && t && isEdited(t)) continue // 직접 수정한 칸은 보존
      entries.push([n, pool[(offset + n - 1) % pool.length]])
    }
    setAssignBulk(cur, entries)
    toast(pool.length < studentCount ? `문장 ${pool.length}개를 ${studentCount}명에게 돌려 배정했습니다(같은 문장이 반복됩니다)` : '배정했습니다')
  }

  const countsLabel = [...BASE_AREAS, ...tabs.filter((a) => !(BASE_AREAS as readonly string[]).includes(a) && filledCount(a) > 0)]
    .map((a) => `${a} ${filledCount(a)}명`).join(' · ')
  const totalAssigned = tabs.reduce((a, t) => a + filledCount(t), 0)
  const sendNeis = () => {
    const payloads = buildCreativePayloads(assign, tabs, students)
    if (!payloads.length) return toast('나이스로 보낼 배정이 없습니다')
    let errs = 0
    for (const p of payloads)
      p.rows.forEach((r, i) => { if (hasErrors(validateComment(r.text, { others: p.rows.filter((_, j) => j !== i).map((x) => x.text) }))) errs++ })
    if (errs && !confirm(`검사 오류(허용되지 않는 문자·이름 의심 등)가 있는 ${errs}명이 함께 담깁니다.\n그대로 나이스 입력 목록에 담을까요?`)) return
    stageNeisPayloads(['creative'], payloads)
    navigate('/neis')
  }

  return (
    <>
      <PageHeader eyebrow="창의적 체험활동" title={<>우리 반 활동 문장을 적으면<br />비슷한 문장을 여러 개 만듭니다</>} />

      <Card className="px-6 py-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-[17px] font-bold flex-1">원문 문장</h2>
          <span className="text-[12px] text-muted">문장마다 만들 개수(1 ~ 20)를 정합니다</span>
        </div>
        <div className="flex flex-col gap-2.5">
          {inputs.map((x, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="w-6 pt-3 text-right text-[12px] text-muted tabular-nums">{i + 1}</span>
              <textarea
                value={x.text}
                onChange={(e) => patch(i, { text: e.target.value })}
                rows={2}
                placeholder="예: 학급 회의에서 의견을 정리하여 발표함."
                className="field flex-1 resize-y leading-[1.6]"
                aria-label={`원문 문장 ${i + 1}`}
              />
              <label className="flex items-center gap-1.5 pt-2.5 text-[13px] text-ink-2 whitespace-nowrap">
                영역
                <select value={x.area ?? '자율'} onChange={(e) => patch(i, { area: e.target.value })} className="field !w-auto !py-1.5 text-[13px]" aria-label={`원문 문장 ${i + 1} 영역`}>
                  {AREA_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 pt-2.5 text-[13px] text-ink-2 whitespace-nowrap">
                개수
                <input
                  type="number" min={1} max={20} value={x.count}
                  onChange={(e) => patch(i, { count: e.target.value === '' ? ('' as unknown as number) : Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
                  onBlur={() => patch(i, { count: clampCount(x.count) })}
                  className="field !w-16 !py-1.5 text-right"
                />
              </label>
              <button type="button" className="btn btn-sm mt-1.5" onClick={() => remove(i)} aria-label={`${i + 1}번 문장 삭제`}>삭제</button>
            </div>
          ))}
        </div>
        <div className="flex">
          <button type="button" className="btn btn-sm" onClick={add}>+ 문장 추가</button>
        </div>

        {/* 평가계획 참고 */}
        {areas.length > 0 && curArea && (
          <div className="rounded-[14px] bg-surface-2 px-4 py-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-muted mr-1">평가계획 참고</span>
              {areas.map((a) => {
                const on = a.area === curArea.area
                return (
                  <button key={a.area} type="button" onClick={() => setArea(a.area)} className={`rounded-full px-3.5 py-1.5 text-[13px] cursor-pointer transition ${on ? 'bg-ink text-white font-bold' : 'bg-surface hover:bg-ground'}`}>{a.area}</button>
                )
              })}
              <span className="text-[12px] text-muted">참고용이며 생성에는 전송되지 않습니다</span>
            </div>
            <div className="flex flex-col gap-2 text-[13px] text-ink-2">
              {curArea.goal && <p className="m-0"><span className="font-bold text-ink">목표</span> {curArea.goal}</p>}
              {!!curArea.elements?.length && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-bold text-ink">평가 요소</span>
                  {curArea.elements.map((el, i) => <span key={i} className="pill bg-surface text-ink-2 !font-medium">{el}</span>)}
                </div>
              )}
              {(curArea.method || curArea.period) && <p className="m-0 text-muted">{[curArea.method, curArea.period].filter(Boolean).join(' · ')}</p>}
            </div>
          </div>
        )}
        {!plan && <Alert kind="info">평가계획을 올리면 창체 영역별 목표와 평가 요소를 여기에 참고로 보여 드립니다. <Link to="/plan" className="underline">평가계획</Link></Alert>}
        {error && <Alert kind="error">{error} {!client && <Link to="/settings" className="underline font-bold">설정으로 가기</Link>}</Alert>}
      </Card>

      {results.length > 0 && (
        <>
          <Card className="px-6 py-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            <h2 className="m-0 text-[17px] font-bold">변형 문장 <span className="font-medium text-accent">{variationCount}개</span></h2>
            <span className="text-[13px] text-muted">문장을 클릭하면 복사되고 붉게 표시됩니다</span>
            <span className="flex-1" />
            <button type="button" className="btn btn-sm" onClick={() => { if (confirm('생성된 문장을 모두 지울까요?')) setResults([]) }} disabled={running}>결과 지우기</button>
            <button type="button" className="btn-primary" onClick={exportExcel}>Excel (.xlsx)</button>
          </Card>
          {results.map((r, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="px-6 py-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="pill bg-surface-2 text-muted">원문 {i + 1}</span>
                <span className="flex-1 min-w-[200px] text-ink-2">{r.original}</span>
                <span className="text-[12px] text-muted">{r.variations.length}개</span>
              </div>
              {r.variations.map((v, j) => {
                const issues = validateComment(v, CREATIVE_LIMIT)
                return (
                  <div key={j} className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-6 py-3 border-t border-line items-center">
                    <CopyText id={`c-${i}-${j}-${hash(v)}`} text={v} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] md:w-[200px]">
                      <span className="text-muted tabular-nums">{neisBytes(v)} Bytes</span>
                      <IssueList issues={issues} />
                    </div>
                  </div>
                )
              })}
              {!r.variations.length && <div className="px-6 py-4 border-t border-line text-[13px] text-muted">이 문장은 결과를 받지 못했습니다. 다시 생성해 보세요.</div>}
            </Card>
          ))}
        </>
      )}

      {!results.length && !totalAssigned && <Alert kind="info">생성한 문장을 학생에게 배정해 나이스로 보낼 수 있습니다. {EXPLAIN}</Alert>}

      {(results.length > 0 || totalAssigned > 0) && (
        <Card className="px-6 py-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="m-0 text-[17px] font-bold flex-1">학생 배정 · 나이스로 보내기</h2>
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
              학생 수
              <input type="number" min={1} max={60} value={studentCount} onChange={(e) => setStudentCount(Number(e.target.value) || 1)} className="field !w-16 !py-1.5 text-right" />
            </label>
          </div>
          <p className="m-0 text-[13px] text-muted">{EXPLAIN}</p>
          <div className="flex flex-wrap items-center gap-2">
            {tabs.map((a) => {
              const on = a === cur
              return (
                <button key={a} type="button" onClick={() => setTab(a)} className={`rounded-full px-3.5 py-1.5 text-[13px] cursor-pointer transition ${on ? 'bg-ink text-white font-bold' : 'bg-surface-2 hover:bg-ground'}`}>
                  {a} <span className="tabular-nums opacity-70">{filledCount(a)}</span>
                </button>
              )
            })}
            <span className="flex-1" />
            <span className="text-[12px] text-muted">{cur} 변형 문장 {pool.length}개 · 배정 {filledCount(cur)} / {studentCount}명</span>
            <button type="button" className="btn btn-sm" onClick={() => autoAssign(false)} disabled={!pool.length}>자동 배정</button>
            {filledCount(cur) > 0 && <button type="button" className="btn btn-sm" onClick={() => autoAssign(true)} disabled={!pool.length}>다시 배정</button>}
            <button type="button" className="btn btn-sm" disabled={!filledCount(cur)} onClick={() => { if (confirm(`${cur} 영역의 배정을 모두 비울까요?`)) clearAssign(cur) }}>모두 비우기</button>
          </div>
          {!pool.length && <Alert kind="warn">{cur} 영역으로 지정된 변형 문장이 없습니다. 원문의 영역을 바꾸고 다시 생성하거나, 아래 칸에 직접 입력하세요.</Alert>}
          <div className="flex flex-col">
            {students.map((n) => {
              const t = curAssign[n] ?? ''
              const others = students.filter((m) => m !== n).map((m) => flatten(textOf(cur, m))).filter(Boolean)
              const issues = t.trim() ? validateComment(t, { others }) : []
              return (
                <div key={n} className="grid grid-cols-[40px_1fr] md:grid-cols-[40px_minmax(0,260px)_1fr_150px_56px] gap-x-3 gap-y-1.5 items-start py-2.5 border-t border-line first:border-t-0">
                  <span className="pt-2 text-right text-[13px] font-bold tabular-nums">{n}번</span>
                  <select
                    value={pool.includes(t) ? t : ''}
                    onChange={(e) => setAssign(cur, n, e.target.value)}
                    className="field !py-1.5 text-[13px] min-w-0"
                    aria-label={`${n}번 문장 선택`}
                  >
                    <option value="">{isEdited(t) ? '직접 수정한 문장' : '문장 선택'}</option>
                    {pool.map((v, k) => <option key={k} value={v}>{k + 1}. {v.length > 36 ? `${v.slice(0, 36)}…` : v}</option>)}
                  </select>
                  <textarea
                    value={t}
                    onChange={(e) => setAssign(cur, n, e.target.value)}
                    rows={2}
                    className="field resize-y leading-[1.6] text-[13px] col-span-2 md:col-span-1"
                    aria-label={`${n}번 문장`}
                    placeholder="문장을 고르거나 직접 입력"
                  />
                  <div className="flex flex-col gap-0.5 text-[12px] col-span-2 md:col-span-1">
                    {t.trim() ? (
                      <>
                        <span className="text-muted tabular-nums">{neisBytes(flatten(t))} Bytes{isEdited(t) && <b className="ml-1.5 text-ink-2">(수정)</b>}</span>
                        <IssueList issues={issues} />
                      </>
                    ) : <span className="text-muted">비어 있음</span>}
                  </div>
                  <button type="button" className="btn btn-sm" disabled={!t} onClick={() => setAssign(cur, n, '')} aria-label={`${n}번 비우기`}>비우기</button>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-muted flex-1">다시 보내면 이전에 담은 창체 데이터는 바뀝니다</span>
            <button type="button" className="btn-primary" onClick={sendNeis} disabled={!totalAssigned}>나이스로 보내기 ({countsLabel})</button>
          </div>
        </Card>
      )}

      <PIIGate gate={gate} what="변형 문장 생성" />

      {/* 하단 고정 바 */}
      <div className="sticky bottom-4 z-20 bg-ink text-white rounded-[20px] px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)]">
        {running ? (
          <>
            <Spinner />
            <div className="flex-1 min-w-[220px]">
              <div className="font-bold">문장을 만드는 중…</div>
              <div className="text-[12px] text-white/60">요청 1회로 {filled.length}개 원문 · {totalWanted}문장을 만듭니다</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => abortRef.current?.abort()}>중지</button>
          </>
        ) : (
          <>
            <div className="flex-1 min-w-[220px]">
              <div className="font-bold">생성 준비</div>
              <div className="text-[12px] text-white/60">원문 {filled.length}개 × 지정 개수 = {totalWanted}문장 · 요청 1회 · 학생 정보는 전송하지 않음</div>
              {!gate.ok && <div className="text-[12px] mt-1"><mark className="pii">확인 필요</mark> 위 카드에서 개인정보로 보이는 표현을 확인하면 생성할 수 있습니다</div>}
            </div>
            <button type="button" className="btn-accent" disabled={!filled.length || !gate.ok} onClick={generate}>변형 문장 {totalWanted}개 생성</button>
          </>
        )}
      </div>
    </>
  )
}
