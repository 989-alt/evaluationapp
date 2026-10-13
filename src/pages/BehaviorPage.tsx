import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Card, CopyText, IssueList, PageHeader, Progress, Spinner, Stat, toast } from '@/components/ui'
import { PIIGate, usePIIGate } from '@/components/PIIGate'
import { useClient, useStore } from '@/store'
import { asArray, generateJSON } from '@/llm/provider'
import { behaviorExpandPrompt, behaviorPrompt, SYSTEM_TEACHER } from '@/llm/prompts'
import { downloadXlsx } from '@/lib/excel'
import { hasErrors, validateComment, type Issue } from '@/lib/validate'
import { BEHAVIOR_EXTRA_BYTES, buildBehaviorPayload } from '@/lib/neis'
import { flatten, hash, neisBytes, sleep } from '@/lib/text'
import type { BehaviorResult, BehaviorStudent } from '@/lib/types'

const CATEGORIES: Array<{ key: string; label: string; traits: string[] }> = [
  { key: 'study', label: '학습', traits: ['학습(우수)', '학습(발전가능)', '학습(제안)'] },
  { key: 'character', label: '성격·인성', traits: ['끈기', '예의', '배려', '독서', '교우관계', '규칙준수', '소신', '봉사', '갈등관리', '책임감', '발표', '협력', '유머'] },
  { key: 'arts', label: '예체능', traits: ['음악', '미술', '체육'] },
]
const BATCH = 5
const MAX_EXTRA = BEHAVIOR_EXTRA_BYTES

const shortName = (t: string) => t.replace(/^학습\((.+)\)$/, '$1')
/** 프롬프트에 보낼 특성 이름: "학습(우수)" → "학습 우수" (괄호가 문장에 옮겨지지 않도록) */
const promptName = (t: string) => t.replace(/^학습\((.+)\)$/, '학습 $1')
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function parseBatch(out: unknown): Array<{ id: number; text: string }> {
  const list = asArray(out)
  const res: Array<{ id: number; text: string }> = []
  for (const x of list) {
    const id = parseInt(String(x?.id ?? x?.student ?? '').replace(/\D/g, ''), 10)
    const text = flatten(String(x?.text ?? ''))
    if (Number.isFinite(id) && text) res.push({ id, text })
  }
  return res
}

export default function BehaviorPage() {
  const client = useClient()
  const navigate = useNavigate()
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const students = useStore((s) => s.behaviorStudents)
  const setStudents = useStore((s) => s.setBehaviorStudents)
  const results = useStore((s) => s.behaviorResults)
  const setResults = useStore((s) => s.setBehaviorResults)
  const stageNeisPayloads = useStore((s) => s.stageNeisPayloads)

  const target = settings.behaviorBytes
  const maxBytes = target + MAX_EXTRA

  const [countDraft, setCountDraft] = useState(String(students.length))
  const [bytesDraft, setBytesDraft] = useState(String(target))
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [pending, setPending] = useState<number[]>([]) // 이번 실행에서 아직 끝나지 않은 번호
  const [regen, setRegen] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ student: number; draft: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)

  useEffect(
    () => () => {
      if (!abortRef.current) return
      abortRef.current.abort()
      toast('다른 화면으로 이동해 행발 생성을 중지했습니다')
    },
    [],
  )
  useEffect(() => setCountDraft(String(students.length)), [students.length])
  useEffect(() => setBytesDraft(String(target)), [target])

  const N = students.length
  const ids = useMemo(() => Array.from({ length: N }, (_, i) => i + 1), [N])
  const entered = useMemo(() => students.filter((s) => Object.keys(s.checks).length > 0), [students])
  // 개인정보 검사: AI로 보내는 특성 이름(예전 데이터·직접 추가한 특성 포함). 번호는 보내도 되는 정보입니다
  const traitNames = useMemo(() => [...new Set(students.flatMap((s) => Object.keys(s.checks)))], [students])
  const gate = usePIIGate(traitNames.map((t) => ({ label: `행발 특성 "${t}"`, text: promptName(t) })))

  // ---------- 입력 ----------
  const setCount = (n: number) => {
    const next = clamp(Math.round(n), 1, 60)
    const byId = new Map(students.map((s) => [s.id, s]))
    const list: BehaviorStudent[] = []
    for (let i = 1; i <= next; i++) list.push(byId.get(i) ?? { id: i, checks: {} })
    setStudents(list)
    if (next < students.length) {
      const cur = useStore.getState().behaviorResults
      if (cur.some((r) => r.student > next)) setResults(cur.filter((r) => r.student <= next))
    }
    setCountDraft(String(next))
  }
  const commitCount = () => {
    const n = Number(countDraft)
    if (countDraft.trim() === '' || !Number.isFinite(n)) return setCountDraft(String(students.length))
    setCount(n)
  }
  const commitBytes = () => {
    const n = Number(bytesDraft)
    if (!Number.isFinite(n) || bytesDraft.trim() === '') return setBytesDraft(String(target))
    const v = clamp(Math.round(n), 100, 3000)
    setSettings({ behaviorBytes: v })
    setBytesDraft(String(v))
  }
  const cycle = (id: number, trait: string) => {
    setStudents(
      students.map((s) => {
        if (s.id !== id) return s
        const checks = { ...s.checks }
        const cur = (checks[trait] as number | undefined) ?? 0
        if (cur === 0) checks[trait] = 1
        else if (cur === 1) checks[trait] = 2
        else delete checks[trait]
        return { ...s, checks }
      }),
    )
  }
  const clearChecks = (id: number) => setStudents(students.map((s) => (s.id === id ? { ...s, checks: {} } : s)))

  // ---------- 결과 파생 ----------
  const shown = useMemo(() => {
    const set = new Set(ids)
    return results.filter((r) => set.has(r.student)).sort((a, b) => a.student - b.student)
  }, [results, ids])

  const issuesMap = useMemo(() => {
    const m = new Map<number, Issue[]>()
    for (const r of shown) {
      const others = shown.filter((x) => x.student !== r.student).map((x) => x.text)
      m.set(r.student, validateComment(r.text, { maxBytes, maxBytesLevel: 'warn', others }))
    }
    return m
  }, [shown, maxBytes])
  const issuesOf = (n: number) => issuesMap.get(n) ?? []
  const passCount = shown.filter((r) => issuesOf(r.student).length === 0).length
  const needCount = shown.length - passCount

  const mergeResults = (items: BehaviorResult[]) => {
    const cur = useStore.getState().behaviorResults
    const touched = new Set(items.map((i) => i.student))
    setResults([...cur.filter((r) => !touched.has(r.student)), ...items].sort((a, b) => a.student - b.student))
  }

  const traitsOf = (s: BehaviorStudent) =>
    Object.entries(s.checks).map(([name, st]) => ({ name: promptName(name), status: st === 1 ? '긍정' : '지도필요' }))

  // ---------- 생성 ----------
  const start = (targets: BehaviorStudent[]) => {
    if (running || regen !== null) return
    if (!client) return setError('설정에서 API 키와 모델을 먼저 선택하세요.')
    if (!targets.length) return setError('특성을 고른 학생이 없습니다. 학생 카드에서 특성을 클릭해 고르세요.')
    if (!gate.ok) return setError('개인정보로 보이는 표현을 먼저 확인해 주세요.')
    const have = new Set(results.map((r) => r.student))
    const overwrite = targets.filter((s) => have.has(s.id)).length
    if (overwrite && !confirm(`이미 결과가 있는 ${overwrite}명은 새 문장으로 바뀝니다(직접 수정한 내용 포함). 계속할까요?`)) return
    setError('')
    setEditing(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    void run(targets, ctrl, client)
  }

  /** 목표보다 60B 넘게 짧은 문단은 한 번 더 요청해 보강합니다(실패하면 원문 유지) */
  const expandShort = async (items: BehaviorResult[], c: NonNullable<typeof client>, signal: AbortSignal): Promise<BehaviorResult[]> => {
    const { behaviorBytes, ending } = useStore.getState().settings
    const short = items.filter((i) => neisBytes(i.text) < behaviorBytes - 60)
    if (!short.length || signal.aborted) return items
    try {
      setMessage(`분량 보강 중… (${short.map((s) => s.student).join(', ')}번)`)
      const out = await generateJSON<unknown>(c, {
        system: SYSTEM_TEACHER,
        prompt: behaviorExpandPrompt(short.map((s) => ({ id: s.student, text: s.text })), behaviorBytes, ending),
        temperature: 0.7,
        maxTokens: 8000,
        signal,
      })
      const fixed = new Map(parseBatch(out).map((p) => [p.id, p.text]))
      return items.map((i) => {
        const t = fixed.get(i.student)
        // 보강 결과가 원문보다 길 때만 채택
        return t && neisBytes(t) > neisBytes(i.text) ? { ...i, text: t } : i
      })
    } catch {
      return items
    }
  }

  const run = async (targets: BehaviorStudent[], ctrl: AbortController, c: NonNullable<typeof client>) => {
    const batches: BehaviorStudent[][] = []
    for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH))
    const wait = /pro/.test(c.model) ? 20000 : 2500
    let done = 0
    let got = 0
    let missing: number[] = []
    let failed = false
    setRunning(true)
    setPending(targets.map((t) => t.id))
    setProgress({ done: 0, total: targets.length })
    try {
      for (let b = 0; b < batches.length; b++) {
        if (ctrl.signal.aborted) break
        const batch = batches[b]
        setMessage(`행동특성 및 종합의견 생성 중… (${b + 1} / ${batches.length}번째 묶음)`)
        if (b > 0) {
          await sleep(wait, ctrl.signal)
          if (ctrl.signal.aborted) break
        }
        const payload = batch.map((s) => ({ id: s.id, traits: traitsOf(s) }))
        let out: unknown
        try {
          out = await generateJSON<unknown>(c, {
            system: SYSTEM_TEACHER,
            prompt: behaviorPrompt(payload, useStore.getState().settings.behaviorBytes, useStore.getState().settings.ending),
            temperature: 0.8,
            maxTokens: 8000,
            signal: ctrl.signal,
          })
        } catch (e) {
          if (ctrl.signal.aborted) break
          const msg = e instanceof Error ? e.message : String(e)
          const later = batches.slice(b + 1).flat().map((s) => s.id)
          setError(
            `${batch.map((s) => s.id).join(', ')}번 묶음 오류: ${msg}` +
              (later.length ? ` 이후 ${later.join(', ')}번은 시작하지 못했습니다.` : '') +
              (missing.length ? ` 앞 묶음에서 ${missing.join(', ')}번은 결과를 받지 못했습니다.` : '') +
              ' 결과가 없는 학생은 "결과 없는 학생만 생성"으로 이어서 생성하세요.',
          )
          toast(`오류: ${msg}`)
          failed = true
          break
        }
        const parsed = parseBatch(out)
        const allowed = new Set(batch.map((s) => s.id))
        let items: BehaviorResult[] = []
        for (const p of parsed) if (allowed.has(p.id) && !items.some((i) => i.student === p.id)) items.push({ student: p.id, text: p.text })
        items = await expandShort(items, c, ctrl.signal)
        mergeResults(items)
        got += items.length
        missing = [...missing, ...batch.filter((s) => !items.some((i) => i.student === s.id)).map((s) => s.id)]
        done += batch.length
        setProgress({ done, total: targets.length })
        setPending((p) => p.filter((id) => !allowed.has(id)))
      }
      if (ctrl.signal.aborted) toast(`중지했습니다 · ${got}명 완료`)
      else if (failed) {
        // 오류 메시지는 위에서 이미 설정함
      } else if (missing.length) {
        setError(`${missing.join(', ')}번은 결과를 받지 못했습니다. 해당 학생만 다시 생성하세요.`)
        toast(`${got}명 완료 · ${missing.length}명은 결과 없음`)
      } else if (got) {
        toast(`${got}명 생성 완료`)
        setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      }
    } finally {
      setRunning(false)
      setPending([])
      setMessage('')
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const regenerate = async (n: number) => {
    if (running || regen !== null) return toast('이미 생성하고 있습니다. 끝난 뒤 다시 시도하세요.')
    if (!client) return toast('설정에서 API 키와 모델을 먼저 선택하세요')
    if (!gate.ok) return toast('개인정보로 보이는 표현을 먼저 확인해 주세요')
    const s = useStore.getState().behaviorStudents.find((x) => x.id === n)
    if (!s || !Object.keys(s.checks).length) return toast(`${n}번은 고른 특성이 없어 다시 생성할 수 없습니다`)
    if (editing?.student === n) setEditing(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRegen(n)
    try {
      const out = await generateJSON<unknown>(client, {
        system: SYSTEM_TEACHER,
        prompt: behaviorPrompt([{ id: n, traits: traitsOf(s) }], settings.behaviorBytes, settings.ending),
        temperature: 0.9,
        maxTokens: 4000,
        signal: ctrl.signal,
      })
      const hit = parseBatch(out).find((p) => p.id === n) ?? parseBatch(out)[0]
      if (!hit) throw new Error('AI 응답에서 문장을 찾지 못했습니다')
      mergeResults(await expandShort([{ student: n, text: hit.text }], client, ctrl.signal))
      setError('')
      toast(`${n}번을 다시 생성했습니다`)
    } catch (e) {
      if (!ctrl.signal.aborted) toast(e instanceof Error ? e.message : String(e))
    } finally {
      setRegen(null)
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  // ---------- 수정 ----------
  const startEdit = (r: BehaviorResult) => {
    if (pending.includes(r.student) || regen === r.student) return toast(`${r.student}번은 지금 생성 중입니다`)
    setEditing({ student: r.student, draft: r.text })
  }
  const saveEdit = () => {
    if (!editing) return
    const text = flatten(editing.draft)
    if (!text) return toast('내용이 비어 있습니다')
    if (pending.includes(editing.student) || regen === editing.student) {
      setEditing(null)
      return toast('그 사이 다시 생성되어 저장하지 않았습니다')
    }
    mergeResults([{ student: editing.student, text }])
    setEditing(null)
    toast('저장했습니다')
  }

  // ---------- 내보내기 ----------
  const exportExcel = () => {
    if (!shown.length) return toast('내보낼 문장이 없습니다')
    downloadXlsx(
      `행동특성및종합의견_${new Date().toISOString().slice(0, 10)}.xlsx`,
      [{ name: '행동특성', rows: shown.map((r) => ({ 번호: r.student, '행동특성 및 종합의견': r.text, Bytes: neisBytes(r.text) })) }],
    )
  }
  const sendNeis = () => {
    const payload = buildBehaviorPayload(shown)
    if (!payload) return toast('나이스로 보낼 문장이 없습니다')
    const errs = shown.filter((r) => hasErrors(issuesOf(r.student))).length
    const notes: string[] = []
    if (running) notes.push('아직 생성 중입니다. 지금까지 끝난 학생만 담습니다.')
    if (errs) notes.push(`검사 오류(바이트 초과·허용되지 않는 문자 등)가 있는 ${errs}명이 함께 담깁니다.`)
    if (notes.length && !confirm(`${notes.join('\n')}\n그대로 나이스 입력 목록에 담을까요?`)) return
    stageNeisPayloads(['behavior'], [payload])
    navigate('/neis')
  }

  const missingEntered = entered.filter((s) => !results.some((r) => r.student === s.id))
  const busy = running || regen !== null

  return (
    <>
      <PageHeader
        eyebrow="행동특성 및 종합의견"
        title={<>특성을 클릭해서 고르면<br />{target}바이트 내외로 씁니다</>}
        aside={
          shown.length > 0 ? (
            <div className="flex gap-7">
              <Stat label="완료" value={shown.length} of={students.length} />
              <Stat label="검사 통과" value={passCount} cls="text-lv0-ink" />
              <Stat label="확인 필요" value={needCount} cls="text-lv2-ink" />
            </div>
          ) : undefined
        }
      />

      {/* 설정 */}
      <Card className="px-6 py-5 flex flex-wrap items-center gap-x-8 gap-y-4">
        <label className="flex items-center gap-3">
          <span className="font-bold">학생 수</span>
          <input
            type="number" min={1} max={60} value={countDraft}
            onChange={(e) => setCountDraft(e.target.value)}
            onBlur={commitCount}
            onKeyDown={(e) => { if (e.key === 'Enter') commitCount() }}
            className="field !w-20 !py-1.5 text-right"
          />
          <span className="text-[12px] text-muted">1 ~ 60명</span>
        </label>
        <label className="flex items-center gap-3">
          <span className="font-bold">목표 바이트</span>
          <input
            type="number" min={100} max={3000} step={50} value={bytesDraft}
            onChange={(e) => setBytesDraft(e.target.value)}
            onBlur={commitBytes}
            onKeyDown={(e) => { if (e.key === 'Enter') commitBytes() }}
            className="field !w-24 !py-1.5 text-right"
          />
          <span className="text-[12px] text-muted">한글 1자 = 3Byte · 상한 없음, {maxBytes}B를 넘으면 참고 경고</span>
        </label>
        <div className="flex-1 min-w-[260px] flex flex-wrap items-center justify-end gap-2 text-[13px]">
          <span className="text-muted">특성 칩 클릭</span>
          <span className="pill lv-1">1번: 긍정</span>
          <span className="pill lv-2">2번: 지도 필요</span>
          <span className="text-muted">3번: 해제</span>
        </div>
      </Card>

      {/* 결과 */}
      {(shown.length > 0 || running) && (
        <div ref={resultsRef} className="scroll-mt-4 flex flex-col gap-5">
          <Card className="px-6 py-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            <h2 className="m-0 text-[17px] font-bold">생성 결과</h2>
            <span className="text-[13px] text-muted">문장을 클릭하면 복사되고 붉게 표시됩니다</span>
            <span className="flex-1" />
            <button type="button" className="btn btn-sm" onClick={exportExcel} disabled={!shown.length}>Excel (.xlsx)</button>
            <button type="button" className="btn btn-sm" disabled={busy || !shown.length} onClick={() => { if (confirm('생성된 행동특성 및 종합의견을 모두 지울까요?')) { setEditing(null); setResults([]) } }}>결과 지우기</button>
            <button type="button" className="btn-primary" onClick={sendNeis} disabled={!shown.length}>나이스로 보내기</button>
          </Card>
          {shown.map((r) => {
            const bytes = neisBytes(r.text)
            const issues = issuesOf(r.student)
            const isEditing = editing?.student === r.student
            const working = pending.includes(r.student) || regen === r.student
            const ratio = Math.min(100, (bytes / maxBytes) * 100)
            const barCls = bytes > maxBytes ? 'bg-lv3-ink' : bytes >= target - 100 ? 'bg-lv0-ink' : 'bg-lv2-ink'
            return (
              <Card key={r.student} className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-x-6 gap-y-3 px-6 py-5">
                <div className="flex flex-col gap-2 min-w-0">
                  <div className="font-bold text-[17px]">{r.student}번</div>
                  <div className="text-[12px] text-muted tabular-nums">{bytes} / {target} Bytes</div>
                  <div className="h-1.5 rounded-full bg-ground overflow-hidden"><div className={`h-full ${barCls}`} style={{ width: `${ratio}%` }} /></div>
                  {working && <span className="flex items-center gap-1.5 text-[12px] text-muted"><Spinner dark /> 생성 중</span>}
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                  {isEditing ? (
                    <>
                      <textarea
                        autoFocus
                        value={editing.draft}
                        onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditing(null)
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit() }
                        }}
                        className="field min-h-[160px] leading-[1.65] resize-y"
                      />
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                        <span className="text-muted tabular-nums">{neisBytes(flatten(editing.draft))} Bytes</span>
                        <IssueList issues={validateComment(flatten(editing.draft), { maxBytes, maxBytesLevel: 'warn', others: shown.filter((x) => x.student !== r.student).map((x) => x.text) })} />
                        <span className="flex-1" />
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>취소</button>
                        <button type="button" className="btn-primary !px-4 !py-1.5 text-[13px]" disabled={!flatten(editing.draft)} onClick={saveEdit}>저장</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <CopyText id={`b-${r.student}-${hash(r.text)}`} text={r.text} />
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                        <span className="text-muted tabular-nums">{bytes} Bytes</span>
                        <IssueList issues={issues} />
                        <span className="flex-1" />
                        <button type="button" className="btn btn-sm" disabled={working} onClick={() => startEdit(r)}>수정</button>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => regenerate(r.student)}>다시 생성</button>
                      </div>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* 학생 카드 */}
      <div className="flex flex-col gap-4">
        {students.map((s) => {
          const n = Object.keys(s.checks).length
          return (
            <Card key={s.id} className="px-6 py-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="font-bold text-[15px]">No.{s.id}</span>
                <span className={`pill ${n ? 'lv-1' : 'bg-surface-2 text-muted'}`}>선택 {n}개</span>
                {results.some((r) => r.student === s.id) && <span className="pill lv-0">결과 있음</span>}
                <span className="flex-1" />
                {n > 0 && <button type="button" className="btn btn-sm" onClick={() => clearChecks(s.id)}>지우기</button>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,7fr)_minmax(0,2fr)] gap-x-6 gap-y-4">
                {CATEGORIES.map((cat) => (
                  <div key={cat.key} className="min-w-0">
                    <div className="text-[12px] font-bold text-muted mb-2">{cat.label}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {cat.traits.map((t) => {
                        const st = s.checks[t] ?? 0
                        const cls = st === 1 ? 'lv-1 border-transparent font-bold' : st === 2 ? 'lv-2 border-transparent font-bold' : 'bg-surface-2 text-ink-2 border-line hover:border-ink'
                        const state = st === 1 ? '긍정' : st === 2 ? '지도 필요' : '선택 안 함'
                        return (
                          <button
                            key={t}
                            type="button"
                            disabled={running}
                            onClick={() => cycle(s.id, t)}
                            aria-label={`${s.id}번 ${t} · ${state}`}
                            title={`${t} · ${state}`}
                            className={`rounded-[10px] border px-3 py-2 text-[13px] cursor-pointer select-none transition disabled:cursor-not-allowed disabled:opacity-60 ${cls}`}
                          >
                            {cat.key === 'study' ? shortName(t) : t}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )
        })}
      </div>

      <PIIGate gate={gate} what="행발 생성" />

      {/* 하단 고정 바 */}
      <div className="sticky bottom-4 z-20 bg-ink text-white rounded-[20px] px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)]">
        {running ? (
          <>
            <Spinner />
            <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
              <div className="text-[13px] font-bold">{message}</div>
              <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} label={<span className="text-white/70">{progress.done} / {progress.total}명</span>} />
            </div>
            <button type="button" className="btn btn-sm" onClick={stop}>중지</button>
          </>
        ) : (
          <>
            <div className="flex-1 min-w-[220px]">
              <div className="font-bold">생성 준비</div>
              <div className="text-[12px] text-white/60">특성을 고른 학생만 · {BATCH}명씩 묶어 요청 · 번호와 특성만 전송 · 목표 {target}바이트</div>
              {!gate.ok && <div className="text-[12px] mt-1"><mark className="pii">확인 필요</mark> 위 카드에서 개인정보로 보이는 표현을 확인하면 생성할 수 있습니다</div>}
              {error && <div className="text-[12px] text-accent mt-1">{error} {!client && <Link to="/settings" className="underline">설정으로 가기</Link>}</div>}
              {!client && !error && <div className="text-[12px] text-accent mt-1">API 키와 모델이 필요합니다. <Link to="/settings" className="underline">설정으로 가기</Link></div>}
            </div>
            {entered.length > 0 && missingEntered.length > 0 && missingEntered.length < entered.length && (
              <button type="button" className="btn !bg-transparent !text-white !border-white/30 hover:!border-white" disabled={busy || !gate.ok} onClick={() => start(missingEntered)}>
                결과 없는 {missingEntered.length}명만 생성
              </button>
            )}
            <button type="button" className="btn-accent" disabled={busy || !entered.length || !gate.ok} onClick={() => start(entered)}>
              {regen !== null ? <><Spinner /> {regen}번 생성 중</> : <>특성을 고른 {entered.length}명 생성</>}
            </button>
          </>
        )}
      </div>
      {!entered.length && !shown.length && (
        <Alert kind="info">학생 카드에서 특성 칩을 한 번 누르면 긍정(파랑), 두 번 누르면 지도 필요(살구)로 표시됩니다. 이름은 입력하지 않으며 번호로만 요청합니다.</Alert>
      )}
    </>
  )
}
