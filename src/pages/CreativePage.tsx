import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Card, CopyText, PageHeader, Spinner, toast } from '@/components/ui'
import { useActivePlan, useClient, useStore } from '@/store'
import { generateJSON } from '@/llm/provider'
import { creativePrompt, SYSTEM_TEACHER } from '@/llm/prompts'
import { downloadXlsx } from '@/lib/excel'
import { validateComment, type Issue } from '@/lib/validate'
import { neisBytes } from '@/lib/text'
import type { CreativeInput, CreativeResult } from '@/lib/types'

function hash(t: string) {
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const flatten = (t: string) => t.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
const clampCount = (n: number) => Math.max(1, Math.min(20, Math.round(n) || 1))

function parseResults(out: unknown): Array<{ original: string; variations: string[] }> {
  const raw: any = out
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : raw && typeof raw === 'object' && 'variations' in raw ? [raw] : []
  return list.map((x) => ({
    original: flatten(String(x?.original ?? '')),
    variations: (Array.isArray(x?.variations) ? x.variations : []).map((v: unknown) => flatten(String(v ?? ''))).filter(Boolean),
  }))
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <span className="font-bold text-lv0-ink">검사 통과</span>
  return (
    <>
      {issues.map((it, i) => (
        <span key={i} className={`font-bold ${it.level === 'error' ? 'text-lv3-ink' : 'text-lv2-ink'}`}>{it.message}</span>
      ))}
    </>
  )
}

export default function CreativePage() {
  const plan = useActivePlan()
  const client = useClient()
  const settings = useStore((s) => s.settings)
  const inputs = useStore((s) => s.creativeInputs)
  const setInputs = useStore((s) => s.setCreativeInputs)
  const results = useStore((s) => s.creativeResults)
  const setResults = useStore((s) => s.setCreativeResults)

  const [area, setArea] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  const areas = useMemo(() => plan?.creative ?? [], [plan])
  const curArea = areas.find((a) => a.area === area) ?? areas[0] ?? null

  const patch = (i: number, p: Partial<CreativeInput>) => setInputs(inputs.map((x, k) => (k === i ? { ...x, ...p } : x)))
  const remove = (i: number) => setInputs(inputs.length > 1 ? inputs.filter((_, k) => k !== i) : [{ text: '', count: inputs[0]?.count ?? 3 }])
  const add = () => setInputs([...inputs, { text: '', count: inputs[inputs.length - 1]?.count ?? 3 }])

  const filled = inputs.map((x) => ({ text: flatten(x.text), count: clampCount(x.count) })).filter((x) => x.text)
  const totalWanted = filled.reduce((a, x) => a + x.count, 0)

  const generate = async () => {
    if (running) return
    if (!client) return setError('설정에서 API 키와 모델을 먼저 선택하세요.')
    if (!filled.length) return setError('원문 문장을 하나 이상 입력하세요.')
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
          <Alert kind="info">
            어떤 학생에게 어떤 문장을 쓸지는 선생님이 직접 정합니다. 마음에 드는 문장을 클릭해 복사한 뒤 나이스 학생부 화면에 붙여 넣으세요. 이 앱은 학생 배정이나 나이스 자동 입력을 하지 않습니다.
          </Alert>
          {results.map((r, i) => (
            <Card key={i} className="overflow-hidden">
              <div className="px-6 py-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="pill bg-surface-2 text-muted">원문 {i + 1}</span>
                <span className="flex-1 min-w-[200px] text-ink-2">{r.original}</span>
                <span className="text-[12px] text-muted">{r.variations.length}개</span>
              </div>
              {r.variations.map((v, j) => {
                const issues = validateComment(v)
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

      {!results.length && (
        <Alert kind="info">
          생성된 문장은 선생님이 학생별로 직접 골라 나이스에 붙여 넣습니다. 이 화면에서는 학생 배정이나 나이스 보내기를 하지 않습니다.
        </Alert>
      )}

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
            </div>
            <button type="button" className="btn-accent" disabled={!filled.length} onClick={generate}>변형 문장 {totalWanted}개 생성</button>
          </>
        )}
      </div>
    </>
  )
}
