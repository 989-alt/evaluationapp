import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Card, CopyText, PageHeader, Spinner, toast } from '@/components/ui'
import { useActivePlan, useClient, useStore } from '@/store'
import { asArray, generateJSON } from '@/llm/provider'
import { modeAPrompt, SYSTEM_TEACHER } from '@/llm/prompts'
import { subjectsOf } from '@/lib/plan'
import { downloadXlsx } from '@/lib/excel'
import { LEVEL_KEYS, LEVEL_NAMES, type ModeAResult } from '@/lib/types'
import { hash, sleep } from '@/lib/text'

/** 평어 생성 화면 전환. "결과"는 방식 B로 만든 평어(오류 제외 학생 수)로 돌아가는 길입니다 */
export function ModeSwitch({ mode }: { mode: 'A' | 'B' | 'R' }) {
  const n = useStore((s) => s.results.filter((r) => !r.error).length)
  return (
    <div className="seg">
      <Link to="/comments" className={`seg-item ${mode === 'A' ? 'seg-item-on' : ''}`}>방식 A · 성취기준별 예시</Link>
      <Link to="/grades" className={`seg-item ${mode === 'B' ? 'seg-item-on' : ''}`}>방식 B · 학생별 성적 → 평어</Link>
      <Link to="/results" className={`seg-item ${mode === 'R' ? 'seg-item-on' : ''}`}>{n ? `결과 · ${n}명` : '결과'}</Link>
    </div>
  )
}

export default function CommentsPage() {
  const plan = useActivePlan()
  const client = useClient()
  const settings = useStore((s) => s.settings)
  const selected = useStore((s) => s.modeASelected)
  const counts = useStore((s) => s.modeACounts)
  const results = useStore((s) => s.modeAResults)
  const setModeA = useStore((s) => s.setModeA)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState(0)
  const [two, setTwo] = useState(settings.sentencesPerStandard === 2)
  const [manual, setManual] = useState('')

  const subjects = useMemo(() => (plan ? subjectsOf(plan) : []), [plan])
  const stds = plan?.standards ?? []
  const filtered = stds.filter((s) => !query || (s.code + s.text + (s.element ?? '')).includes(query))
  const sel = new Set(selected.filter((id) => stds.some((s) => s.id === id) || id.startsWith('manual:')))
  const toggle = (id: string) => setModeA({ modeASelected: sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id] })
  const total = counts.reduce((a, b) => a + b, 0)
  const chosen = stds.filter((s) => sel.has(s.id))
  const manualStds = selected.filter((id) => id.startsWith('manual:')).map((id) => ({ id, subject: '직접 입력', code: '', text: id.slice(7), criteria: ['', '', '', ''] as [string, string, string, string] }))
  const allChosen = [...chosen, ...manualStds]

  const run = async () => {
    if (!client) return setError('설정에서 API 키와 모델을 먼저 선택하세요.')
    if (!allChosen.length) return setError('성취기준을 하나 이상 선택하세요.')
    setError('')
    const acc: ModeAResult[] = []
    try {
      for (let i = 0; i < allChosen.length; i++) {
        setBusy(`평어 생성 중… (${i + 1}/${allChosen.length})`)
        if (i > 0) await sleep(/pro/.test(client.model) ? 20000 : 2500)
        const s = allChosen[i]
        const out = await generateJSON<unknown>(client, {
          system: SYSTEM_TEACHER, prompt: modeAPrompt([s], counts, two ? 2 : 1, settings.ending), temperature: 0.8,
        })
        const list = asArray(out)
        const r = list.find((x) => x?.standardId === s.id) ?? list[0]
        const levels = normalizeLevels(r?.levels)
        if (LEVEL_KEYS.every((k) => !levels[k].length)) throw new Error('AI 응답에서 평어를 찾지 못했습니다. 다시 시도해 주세요.')
        acc.push({ standardId: s.id, code: s.code, text: s.text, levels })
        setModeA({ modeAResults: [...acc] })
      }
      setTab(0)
      toast('생성 완료')
    } catch (e: any) {
      setError(e.message ?? String(e))
      if (acc.length) setModeA({ modeAResults: [...acc] })
    } finally {
      setBusy('')
    }
  }

  const exportExcel = () => {
    const rows: Array<Record<string, string>> = []
    for (const r of results) for (const k of LEVEL_KEYS) for (const t of r.levels[k]) rows.push({ 성취기준: r.code, 내용: r.text, 수준: LEVEL_NAMES[LEVEL_KEYS.indexOf(k)], 평어: t })
    downloadXlsx(`성취기준별_평어_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: '평어', rows }])
  }

  const cur = results[tab]

  return (
    <>
      <PageHeader eyebrow="STEP 2 · 평어 생성" title={<>성취기준을 고르면<br />수준별 예시 평어를 만듭니다</>} aside={<ModeSwitch mode="A" />} />
      {!plan && <Alert kind="warn">평가계획이 없습니다. <Link to="/plan" className="underline">평가계획</Link>을 먼저 올리면 성취기준을 손으로 입력할 필요가 없습니다. 없이도 아래 "직접 입력"으로 쓸 수 있습니다.</Alert>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2 overflow-hidden flex flex-col">
          <div className="px-6 py-5 flex flex-wrap items-center gap-2.5">
            <h2 className="m-0 text-[17px] font-bold flex-1 min-w-[160px]">성취기준 선택 <span className="font-medium text-accent">{allChosen.length}개</span></h2>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="코드 · 내용 검색" className="field !w-[200px] !py-1.5 !rounded-full" />
            <button type="button" className="btn btn-sm" onClick={() => setModeA({ modeASelected: sel.size === stds.length + manualStds.length ? manualStds.map((m) => m.id) : [...stds.map((s) => s.id), ...manualStds.map((m) => m.id)] })}>{sel.size >= stds.length && stds.length ? '전체 해제' : '전체 선택'}</button>
          </div>
          <div className="flex flex-col">
            {subjects.map((subj) => {
              const list = filtered.filter((s) => s.subject === subj)
              if (!list.length) return null
              const n = list.filter((s) => sel.has(s.id)).length
              const isOpen = open[subj] ?? true
              return (
                <div key={subj}>
                  <button type="button" onClick={() => setOpen({ ...open, [subj]: !isOpen })} className="w-full text-left px-6 py-2.5 bg-surface-2 font-bold flex items-center gap-2 border-t border-line">
                    <span className="text-[12px]">{isOpen ? '▾' : '▸'}</span>{subj} <span className="font-medium text-muted">{n} / {list.length}</span>
                  </button>
                  {isOpen && list.map((s) => (
                    <label key={s.id} className={`flex gap-3 items-start px-6 py-3.5 border-t border-line cursor-pointer ${sel.has(s.id) ? '' : 'text-muted'}`}>
                      <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggle(s.id)} className="mt-1 w-4 h-4 accent-ink" />
                      <span className="flex-1">
                        <span className="font-mono text-[12px] text-accent font-bold">{s.code}</span> {s.text}
                        <span className="block text-[12px] text-muted">{[s.element, s.period].filter(Boolean).join(' · ')}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )
            })}
            <div className="px-6 py-3.5 border-t border-line flex flex-col gap-2">
              {manualStds.map((m) => (
                <label key={m.id} className="flex gap-3 items-start cursor-pointer"><input type="checkbox" checked onChange={() => toggle(m.id)} className="mt-1 w-4 h-4 accent-ink" /><span className="flex-1"><span className="font-mono text-[12px] text-accent font-bold">직접 입력</span> {m.text}</span></label>
              ))}
              <div className="flex gap-2">
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="성취기준을 직접 입력 (평가계획에 없는 항목)" className="field !py-1.5" onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) { setModeA({ modeASelected: [...selected, 'manual:' + manual.trim()] }); setManual('') } }} />
                <button type="button" className="btn btn-sm" onClick={() => { if (manual.trim()) { setModeA({ modeASelected: [...selected, 'manual:' + manual.trim()] }); setManual('') } }}>추가</button>
              </div>
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-6 flex flex-col gap-3.5">
            <h2 className="m-0 text-[17px] font-bold">수준별 생성 개수</h2>
            <div className="flex flex-col gap-2">
              {LEVEL_NAMES.map((n, i) => (
                <label key={n} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-[12px] lv-${i}`}>
                  <span className="font-bold">{n}</span>
                  <input type="number" min={0} max={20} value={counts[i]} onChange={(e) => { const c = [...counts] as typeof counts; c[i] = Math.max(0, Math.min(20, Number(e.target.value) || 0)); setModeA({ modeACounts: c }) }} className="w-14 px-2 py-1.5 rounded-lg bg-white text-right outline-none" />
                </label>
              ))}
            </div>
            <label className="flex gap-2 items-center text-[13px]"><input type="checkbox" checked={two} onChange={(e) => setTwo(e.target.checked)} className="w-4 h-4 accent-ink" />성취기준당 2문장으로</label>
            <div className="text-[12px] text-muted pt-2.5 border-t border-line">{allChosen.length}개 × {total}문장 = {allChosen.length * total}문장 · 요청 {allChosen.length}회</div>
            {error && <Alert kind="error">{error}</Alert>}
            <button type="button" className="btn-primary !py-3.5 text-[15px]" onClick={run} disabled={!!busy}>{busy ? <><Spinner /> {busy}</> : '평어 생성'}</button>
          </Card>
          <Card className="px-6 py-5 text-[13px] flex flex-col gap-2">
            <div className="eyebrow">항상 적용되는 규칙</div>
            <ul className="m-0 pl-4 text-ink-2 flex flex-col gap-1">
              <li>해당 수준의 평가 기준 문장이 근거</li>
              <li>"-{settings.ending === '함' ? '함' : '하였음'}." 명사형 종결, 주어 생략</li>
              <li>온점·반점 외 특수문자 없음</li>
              <li>같은 수준 안에서 표현 중복 없음</li>
            </ul>
          </Card>
        </div>
      </div>

      {results.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex overflow-x-auto px-3 pt-2 gap-1 border-b border-line items-center">
            {results.map((r, i) => (
              <button key={r.standardId} type="button" onClick={() => setTab(i)} className={`px-4 py-3 whitespace-nowrap border-b-2 ${tab === i ? 'border-ink font-bold' : 'border-transparent text-muted'}`}>{r.code || '직접'} {r.text.slice(0, 14)}…</button>
            ))}
            <span className="ml-auto px-4 text-[12px] text-muted whitespace-nowrap">문장을 클릭하면 복사되고 붉게 표시됩니다</span>
          </div>
          {cur && (
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              {LEVEL_KEYS.map((k, i) => (
                <div key={k} className="rounded-2xl overflow-hidden bg-surface-2">
                  <div className={`px-3.5 py-2.5 font-bold flex justify-between items-center text-lv${i}-ink`} style={{ color: `var(--color-lv${i}-ink)` }}>
                    <span className="inline-flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: `var(--color-lv${i}-ink)` }} />{LEVEL_NAMES[i]}</span><span className="font-medium text-[12px]">{cur.levels[k].length}</span>
                  </div>
                  <div className="flex flex-col">
                    {cur.levels[k].map((t, j) => <CopyText key={j} id={`a-${cur.standardId}-${k}-${j}-${hash(t)}`} text={t} className="!rounded-none !bg-transparent border-t border-line" />)}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="px-6 py-3.5 border-t border-line flex flex-wrap gap-2 items-center">
            <button type="button" className="btn btn-sm" onClick={exportExcel}>Excel로 저장</button>
            <span className="flex-1" />
            <button type="button" className="btn btn-sm" onClick={() => { if (confirm('결과를 지울까요?')) setModeA({ modeAResults: [] }) }}>결과 지우기</button>
          </div>
        </Card>
      )}
    </>
  )
}

function normalizeLevels(l: any): ModeAResult['levels'] {
  const out: any = {}
  for (const k of LEVEL_KEYS) out[k] = Array.isArray(l?.[k]) ? l[k].map((x: any) => String(x).trim()).filter(Boolean) : []
  return out
}
