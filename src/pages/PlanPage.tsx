import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Card, PageHeader, Spinner, toast } from '@/components/ui'
import { PaidKeyReminder, PIIGate, unconfirmedCount, usePIIGate, type PIIItem } from '@/components/PIIGate'
import { useActivePlan, useClient, useStore } from '@/store'
import { generateJSON, PROVIDER_PDF } from '@/llm/provider'
import { PLAN_EXTRACT_PROMPT, SYSTEM_TEACHER } from '@/llm/prompts'
import { fileToBase64, pdfToText } from '@/lib/pdf'
import { emptyStandard, normalizePlan, sanitizePlan, subjectsOf } from '@/lib/plan'
import { LEVEL_SHORT, type Standard } from '@/lib/types'

export default function PlanPage() {
  const client = useClient()
  const plans = useStore((s) => s.plans)
  const plan = useActivePlan()
  const addPlan = useStore((s) => s.addPlan)
  const updatePlan = useStore((s) => s.updatePlan)
  const removePlan = useStore((s) => s.removePlan)
  const setActivePlan = useStore((s) => s.setActivePlan)

  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const [subject, setSubject] = useState<string>('')
  const fileRef = useRef<HTMLInputElement>(null)
  const jsonRef = useRef<HTMLInputElement>(null)

  const subjects = useMemo(() => (plan ? subjectsOf(plan) : []), [plan])
  const curSubject = subjects.includes(subject) ? subject : subjects[0] ?? ''
  const rows = plan ? plan.standards.filter((s) => s.subject === curSubject) : []

  // 개인정보 확인을 기다리는 PDF (글자를 뽑아 검사한 뒤 AI로 보냅니다)
  const [pending, setPending] = useState<{ file: File; text: string } | null>(null)
  const pendingItems = useMemo(() => (pending ? pdfItems(pending.text) : []), [pending])
  const gate = usePIIGate(pendingItems)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (!client) {
      setError('먼저 설정에서 API 키와 모델을 선택해 주세요.')
      return
    }
    setError('')
    setPending(null)
    // 모든 제공사에서 글자를 먼저 뽑아 개인정보를 검사합니다(OpenAI는 이 글자를 그대로 보냄)
    setBusy('파일 읽는 중…')
    let text = ''
    try {
      text = await pdfToText(file)
    } catch {
      text = ''
    }
    setBusy('')
    if (!text.trim()) toast('글자가 없는 스캔본이라 개인정보 검사를 하지 못했습니다')
    if (unconfirmedCount(pdfItems(text)) > 0) {
      setPending({ file, text })
      return
    }
    await extract(file, text)
  }

  const extract = async (file: File, text: string) => {
    if (!client) return
    setPending(null)
    setError('')
    try {
      setBusy('파일 읽는 중…')
      const opts: { pdfBase64?: string; pdfText?: string } = {}
      if (PROVIDER_PDF[client.provider]) opts.pdfBase64 = await fileToBase64(file)
      else opts.pdfText = text
      setBusy('AI가 평가계획을 읽는 중… (10~30초)')
      const raw = await generateJSON<any>(client, { system: SYSTEM_TEACHER, prompt: PLAN_EXTRACT_PROMPT, ...opts, temperature: 0.1, maxTokens: 16000 })
      // Gemini가 가끔 원소 하나짜리 배열로 감싸 돌려줍니다
      const p = normalizePlan(Array.isArray(raw) ? raw[0] ?? {} : raw ?? {}, file.name)
      if (!p.standards.length) throw new Error('성취기준을 찾지 못했습니다. 평가 계획표 PDF가 맞는지 확인해 주세요.')
      addPlan(p)
      setSubject('')
      toast(`성취기준 ${p.standards.length}개 추출 완료`)
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setBusy('')
    }
  }

  const patchStd = (id: string, patch: Partial<Standard>) => {
    if (!plan) return
    updatePlan(plan.id, { standards: plan.standards.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }
  const patchCriterion = (id: string, i: number, v: string) => {
    const s = plan?.standards.find((x) => x.id === id)
    if (!s) return
    const c = [...s.criteria] as Standard['criteria']
    c[i] = v
    patchStd(id, { criteria: c })
  }
  const addStd = () => {
    if (!plan) return
    const subj = curSubject || prompt('교과명을 입력하세요') || ''
    if (!subj) return
    updatePlan(plan.id, { standards: [...plan.standards, emptyStandard(subj)] })
    setSubject(subj)
  }
  const delStd = (id: string) => plan && updatePlan(plan.id, { standards: plan.standards.filter((s) => s.id !== id) })

  const exportJson = () => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `평가계획_${plan.title}.json`
    a.click()
  }
  const importJson = async (file: File | undefined) => {
    if (!file) return
    try {
      const p = JSON.parse(await file.text())
      if (!p || !Array.isArray(p.standards)) throw new Error('형식이 다릅니다')
      addPlan(sanitizePlan(p, file.name))
      toast('평가계획을 불러왔습니다')
    } catch (e: any) {
      setError(`JSON 불러오기 실패: ${e.message}`)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="STEP 1 · 평가계획"
        title={<>평가 계획표를 올리면<br />성취기준과 기준 문장을 읽어 둡니다</>}
        aside={
          <div className="flex items-center gap-1.5 text-[13px]">
            <span className="pill bg-ink text-white px-3 py-1.5">1 업로드</span>
            <span className={`pill px-3 py-1.5 ${plan ? 'bg-ink text-white' : 'bg-surface'}`}>2 검수</span>
            <span className="pill bg-surface px-3 py-1.5">3 평어 생성</span>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2 p-6 flex flex-col gap-4">
          <div className="flex justify-between items-baseline gap-3 flex-wrap">
            <h2 className="m-0 text-[17px] font-bold">평가 계획표 업로드</h2>
            <span className="text-[12px] text-muted">PDF · 한글에서 저장한 PDF {client && !PROVIDER_PDF[client.provider] ? '· (GPT는 텍스트 추출 후 전송)' : '· 스캔본 이미지 PDF'}</span>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]) }}
            onClick={() => !busy && fileRef.current?.click()}
            className={`rounded-2xl p-6 text-center cursor-pointer transition border-2 border-dashed ${drag ? 'border-ink bg-ground' : 'border-line bg-surface-2 hover:bg-ground'}`}
          >
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
            {busy ? (
              <div className="flex items-center justify-center gap-3 py-2"><Spinner dark /> <span>{busy}</span></div>
            ) : (
              <>
                <div className="font-bold">PDF를 여기에 끌어다 놓거나 클릭해서 선택</div>
                <div className="text-[12px] text-muted mt-1">AI가 교과 · 성취기준 · 4수준 평가 기준 · 창체 표를 읽어 표로 정리합니다</div>
              </>
            )}
          </div>
          {!client && <Alert kind="warn">먼저 <Link className="underline" to="/settings">설정</Link>에서 API 키와 모델을 선택해 주세요.</Alert>}
          {!pending && <PaidKeyReminder />}
          {pending && (
            <>
              <PIIGate gate={gate} what="평가계획 추출" />
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex-1 min-w-[200px] text-[13px] text-muted truncate">대기 중: {pending.file.name}</span>
                <button type="button" className="btn" onClick={() => setPending(null)}>취소</button>
                <button type="button" className="btn-primary" disabled={!gate.ok || !!busy} onClick={() => void extract(pending.file, pending.text)}>
                  {gate.ok ? '확인했습니다, 추출 시작' : '위 내용을 확인해 주세요'}
                </button>
              </div>
            </>
          )}
          {error && <Alert kind="error">{error}</Alert>}
          {plan && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                <Stat label="학년 · 학기" value={[plan.grade, plan.semester].filter(Boolean).join(' ') || plan.title} small />
                <Stat label="교과" value={String(subjects.length)} />
                <Stat label="성취기준 · 기준문" value={<>{plan.standards.length} <span className="text-[14px] text-muted">/ {plan.standards.length * 4}</span></>} />
                <Stat label="창체" value={plan.creative.map((c) => c.area).join(' · ') || '없음'} small />
              </div>
              {plan.warnings && plan.warnings.length > 0 && (
                <Alert kind="warn">
                  <div className="font-bold mb-1">검토할 항목 {plan.warnings.length}개</div>
                  <ul className="m-0 pl-4">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </Alert>
              )}
            </>
          )}
        </Card>

        <Card className="p-6 flex flex-col gap-3">
          <div className="eyebrow">저장된 평가계획</div>
          <div className="flex flex-col gap-2">
            {plans.length === 0 && <div className="text-[13px] text-muted">아직 없습니다. PDF를 올리면 여기에 학기별로 쌓입니다.</div>}
            {plans.map((p) => (
              <div key={p.id} onClick={() => setActivePlan(p.id)} className={`rounded-[14px] bg-ground p-3.5 cursor-pointer flex items-start gap-2 ${p.id === plan?.id ? 'border-[1.5px] border-ink' : 'border-[1.5px] border-transparent'}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate">{p.title}</div>
                  <div className="text-[12px] text-muted">{p.standards.length}개 성취기준 · {new Date(p.createdAt).toLocaleDateString()}{p.id === plan?.id ? ' · 사용 중' : ''}</div>
                </div>
                <button type="button" className="text-muted hover:text-lv3-ink text-[12px]" onClick={(e) => { e.stopPropagation(); if (confirm(`"${p.title}"을 삭제할까요?`)) removePlan(p.id) }}>삭제</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-auto">
            <button type="button" className="btn btn-sm flex-1" onClick={exportJson} disabled={!plan}>JSON 내보내기</button>
            <button type="button" className="btn btn-sm flex-1" onClick={() => jsonRef.current?.click()}>불러오기</button>
            <input ref={jsonRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { importJson(e.target.files?.[0]); e.target.value = '' }} />
          </div>
        </Card>
      </div>

      {plan && (
        <Card className="overflow-hidden">
          <div className="px-6 py-5 flex flex-wrap items-center gap-3">
            <h2 className="m-0 text-[17px] font-bold flex-1 min-w-[160px]">추출 결과 검수</h2>
            <div className="flex flex-wrap gap-1.5">
              {subjects.map((s) => {
                const n = plan.standards.filter((x) => x.subject === s).length
                return (
                  <button key={s} type="button" onClick={() => setSubject(s)} className={`rounded-full px-3.5 py-1.5 text-[13px] ${curSubject === s ? 'bg-ink text-white font-bold' : 'bg-surface border border-line hover:border-ink'}`}>
                    {s} {n}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[900px]">
              <thead>
                <tr className="text-muted text-[12px] text-left">
                  <th className="px-6 py-2.5 font-medium w-[230px] border-t border-line">성취기준</th>
                  <th className="px-3 py-2.5 font-medium w-[170px] border-t border-line">단원 · 영역 · 평가요소</th>
                  <th className="px-3 py-2.5 font-medium w-[120px] border-t border-line">평가 방법</th>
                  <th className="px-3 py-2.5 font-medium border-t border-line">수준별 평가 기준 (클릭해서 수정)</th>
                  <th className="px-3 py-2.5 font-medium w-[70px] border-t border-line">시기</th>
                  <th className="px-3 py-2.5 font-medium w-[40px] border-t border-line"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => (
                  <tr key={s.id} className={`border-t border-line align-top ${i % 2 ? 'bg-surface-2' : ''}`}>
                    <td className="px-6 py-4">
                      <input value={s.code} onChange={(e) => patchStd(s.id, { code: e.target.value })} placeholder="[6국05-01]" className="font-mono text-[12px] text-accent font-bold bg-transparent outline-none w-full" />
                      <Auto value={s.text} onChange={(v) => patchStd(s.id, { text: v })} placeholder="성취기준 본문" />
                    </td>
                    <td className="px-3 py-4 text-ink-2">
                      <Auto value={s.unit ?? ''} onChange={(v) => patchStd(s.id, { unit: v })} placeholder="단원" />
                      <Auto value={s.area ?? ''} onChange={(v) => patchStd(s.id, { area: v })} placeholder="영역" className="text-[12px] text-muted" />
                      <Auto value={s.element ?? ''} onChange={(v) => patchStd(s.id, { element: v })} placeholder="평가 요소" className="mt-1.5" />
                    </td>
                    <td className="px-3 py-4 text-ink-2"><Auto value={s.method ?? ''} onChange={(v) => patchStd(s.id, { method: v })} placeholder="평가 방법" /></td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        {s.criteria.map((c, li) => (
                          <div key={li} className="flex gap-2.5 items-start px-2.5 py-1.5 rounded-[10px]">
                            <span className={`pill lv-${li} w-[60px] justify-center text-[11px] shrink-0`}>{LEVEL_SHORT[li]}</span>
                            <Auto value={c} onChange={(v) => patchCriterion(s.id, li, v)} placeholder={`${LEVEL_SHORT[li]} 기준 문장`} className={c ? '' : 'bg-lv3-tint rounded px-1'} />
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-4 text-ink-2"><Auto value={s.period ?? ''} onChange={(v) => patchStd(s.id, { period: v })} placeholder="월" /></td>
                    <td className="px-3 py-4"><button type="button" className="text-muted hover:text-lv3-ink" title="삭제" onClick={() => delStd(s.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 border-t border-line flex flex-wrap items-center gap-3">
            <button type="button" className="btn" onClick={addStd}>+ 성취기준 직접 추가</button>
            <span className="flex-1 text-[12px] text-muted">수정하면 바로 저장됩니다</span>
            <Link to="/comments" className="btn-primary">검수 완료, 평어 생성으로 →</Link>
          </div>
        </Card>
      )}
    </>
  )
}

/** PDF 글자를 쪽별 검사 입력으로 나눕니다(pdfToText의 쪽 구분 기준) */
function pdfItems(text: string): PIIItem[] {
  return text
    .split('\n\n--- page ---\n\n')
    .map((t, i) => ({ label: `PDF ${i + 1}쪽`, text: t }))
    .filter((x) => x.text.trim())
}

function Stat({ label, value, small = false }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <div className="rounded-[14px] bg-ground p-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`font-light tracking-[-0.02em] leading-[1.1] ${small ? 'text-[16px]' : 'text-[28px]'}`}>{value}</div>
    </div>
  )
}

/** auto-growing textarea that looks like text */
function Auto({ value, onChange, placeholder, className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' }}
      ref={(t) => { if (t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px' } }}
      rows={1}
      className={`block w-full resize-none bg-transparent outline-none leading-[1.5] focus:bg-white focus:rounded px-0.5 ${className}`}
    />
  )
}
