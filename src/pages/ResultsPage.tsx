import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Card, CopyText, IssueList, LevelPill, PageHeader, Progress, Spinner, Stat, toast } from '@/components/ui'
import { useActivePlan, useClient, useStore } from '@/store'
import { abortGeneration, buildStudentInput, generateStudents, genState, useGenState } from '@/llm/generateModeB'
import { validateComment, hasErrors, type Issue } from '@/lib/validate'
import { downloadXlsx, uniqueSheetName } from '@/lib/excel'
import { buildSubjectPayloads, neisByteLimit } from '@/lib/neis'
import { flatten, hash, neisBytes, splitSentences } from '@/lib/text'
import { ModeSwitch } from './CommentsPage'
import { LEVEL_SHORT, type Standard, type StudentResult, type SubjectComment } from '@/lib/types'

type View = 'student' | 'subject'
interface Editing {
  student: number
  subject: string
  draft: string
  generatedAt: number // 편집 시작 시점의 결과 버전
}

const keyOf = (student: number, subject: string) => `${student}|${subject}`
const SUBJECT_LIMIT = neisByteLimit('subject', 0)
/** 문장이 바뀌면 복사 표시(붉은색)도 새로 시작하도록 id에 문장 해시를 붙입니다 */
const copyId = (student: number, sc: SubjectComment) => `r-${student}-${sc.subject}-${hash(sc.text)}`

/** 생성 때의 성취기준당 문장 수(1 또는 2). 예전 결과는 문단에서 추정합니다 */
function sentencesOf(r: StudentResult | undefined, fallback: 1 | 2): 1 | 2 {
  if (!r) return fallback
  if (r.sentences) return r.sentences
  let s = 0
  let k = 0
  for (const sc of r.subjects) {
    if (!sc.text.trim()) continue
    s += splitSentences(sc.text).length
    k += sc.standardIds.length
  }
  if (!k) return fallback
  return s / k >= 2 ? 2 : 1 // 내림: 2문장 이상일 때만 2
}

function StandardList({ sc, stdById }: { sc: SubjectComment; stdById: Map<string, Standard> }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
      {sc.standardIds.map((id, i) => {
        const std = stdById.get(id)
        const lv = sc.levels[i]
        return (
          <li key={id + i} className="flex items-center gap-2 text-[12px] min-w-0">
            {lv !== undefined && <LevelPill level={lv} />}
            <span className="font-mono text-accent font-bold truncate" title={std?.text}>{std?.code || std?.text?.slice(0, 12) || '성취기준'}</span>
          </li>
        )
      })}
    </ul>
  )
}

export default function ResultsPage() {
  const plan = useActivePlan()
  const plans = useStore((s) => s.plans)
  const client = useClient()
  const navigate = useNavigate()
  const gen = useGenState()
  const settings = useStore((s) => s.settings)
  const N = useStore((s) => s.studentCount)
  const results = useStore((s) => s.results)
  const updateSubjectText = useStore((s) => s.updateSubjectText)
  const stageNeisPayloads = useStore((s) => s.stageNeisPayloads)
  const clearResults = useStore((s) => s.clearResults)

  const [view, setView] = useState<View>('student')
  const [subj, setSubj] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const pendingScroll = useRef<number | null>(null)

  // 성취기준 조회: 모든 평가계획(활성 계획 우선)
  const stdById = useMemo(() => {
    const m = new Map<string, Standard>()
    for (const p of plans) if (p.id !== plan?.id) for (const s of p.standards) m.set(s.id, s)
    for (const s of plan?.standards ?? []) m.set(s.id, s)
    return m
  }, [plans, plan])

  const okResults = useMemo(() => results.filter((r) => !r.error), [results])
  const errResults = useMemo(() => results.filter((r) => !!r.error), [results])

  // 교과 순서: 평가계획 순서 → 결과에만 있는 교과
  const subjects = useMemo(() => {
    const order: string[] = []
    for (const s of plan?.standards ?? []) if (!order.includes(s.subject)) order.push(s.subject)
    const used = new Set(results.flatMap((r) => r.subjects.map((sc) => sc.subject)))
    for (const r of results) for (const sc of r.subjects) if (!order.includes(sc.subject)) order.push(sc.subject)
    return order.filter((s) => used.has(s))
  }, [plan, results])

  // 같은 교과의 다른 학생 문단(오류 결과 제외)
  const textsBySubject = useMemo(() => {
    const m = new Map<string, Array<{ student: number; text: string }>>()
    for (const r of okResults)
      for (const sc of r.subjects) {
        if (!sc.text.trim()) continue
        const list = m.get(sc.subject) ?? []
        list.push({ student: r.student, text: sc.text })
        m.set(sc.subject, list)
      }
    return m
  }, [okResults])
  const othersFor = (student: number, subject: string) =>
    (textsBySubject.get(subject) ?? []).filter((x) => x.student !== student).map((x) => x.text)

  const issuesMap = useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const r of results)
      for (const sc of r.subjects) {
        const others = (textsBySubject.get(sc.subject) ?? []).filter((x) => x.student !== r.student).map((x) => x.text)
        m.set(keyOf(r.student, sc.subject), validateComment(sc.text, { others, ...SUBJECT_LIMIT }))
      }
    return m
  }, [results, textsBySubject])
  const issuesOf = (student: number, subject: string) => issuesMap.get(keyOf(student, subject)) ?? []

  // 통계(오류 결과 제외)
  const paragraphs = okResults.flatMap((r) => r.subjects.map((sc) => ({ student: r.student, sc })))
  const passCount = paragraphs.filter((p) => issuesOf(p.student, p.sc.subject).length === 0).length
  const needCount = paragraphs.length - passCount
  const statusOf = (r: StudentResult): 'error' | 'check' | 'pass' =>
    r.error ? 'error' : r.subjects.some((sc) => issuesOf(r.student, sc.subject).length > 0) ? 'check' : 'pass'

  const curSubj = subj && subjects.includes(subj) ? subj : (subjects[0] ?? null)

  // 학생 칩 → 학생별 보기에서 해당 카드로 스크롤
  useEffect(() => {
    if (pendingScroll.current === null || view !== 'student') return
    const n = pendingScroll.current
    pendingScroll.current = null
    document.getElementById(`student-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  const jumpTo = (n: number) => {
    pendingScroll.current = n
    if (view !== 'student') setView('student')
    else document.getElementById(`student-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 다시 생성 ----------
  const regenerate = (n: number, sentences: 1 | 2) => {
    if (!plan) return toast('활성 평가계획이 없어 다시 생성할 수 없습니다')
    if (!client) return toast('설정에서 API 키와 모델을 먼저 선택하세요')
    const st = useStore.getState()
    if (!buildStudentInput(plan, st.grades, n).length) return toast(`${n}번은 입력된 성취 수준이 없습니다`)
    if (genState.getSnapshot().running) return toast('이미 평어를 생성하고 있습니다. 끝난 뒤 다시 시도하세요.')
    const prev = st.results.find((r) => r.student === n)
    if (prev?.subjects.some((sc) => sc.edited) && !confirm(`${n}번에는 직접 수정한 문단이 있습니다. 다시 생성하면 수정한 내용이 바뀝니다. 계속할까요?`)) return
    if (editing?.student === n) setEditing(null)
    generateStudents({
      client, plan, grades: st.grades, students: [n], sentences, ending: settings.ending, existing: st.results,
    })
      .then(() => toast(genState.getSnapshot().message))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
  }

  // ---------- 수정 ----------
  const busyStudent = gen.running ? gen.current : null
  const startEdit = (r: StudentResult, sc: SubjectComment) => {
    if (busyStudent === r.student) return toast(`${r.student}번은 지금 생성 중입니다`)
    setEditing({ student: r.student, subject: sc.subject, draft: sc.text, generatedAt: r.generatedAt })
  }
  // 편집 중인 학생이 생성되기 시작하면 편집기를 닫습니다
  useEffect(() => {
    if (editing && busyStudent === editing.student) {
      setEditing(null)
      toast(`${editing.student}번을 생성하고 있어 수정을 취소했습니다`)
    }
  }, [busyStudent, editing])
  const saveEdit = () => {
    if (!editing) return
    const text = flatten(editing.draft)
    if (!text) return toast('내용이 비어 있습니다')
    const now = useStore.getState().results.find((r) => r.student === editing.student)
    if (!now || now.error || now.generatedAt !== editing.generatedAt || genState.getSnapshot().current === editing.student) {
      setEditing(null)
      return toast('그 사이 다시 생성되어 저장하지 않았습니다')
    }
    updateSubjectText(editing.student, editing.subject, text)
    setEditing(null)
    toast('저장했습니다')
  }

  // ---------- Excel ----------
  const levelText = (sc: SubjectComment) =>
    sc.standardIds
      .map((id, i) => {
        const lv = sc.levels[i]
        const name = lv === undefined ? '' : LEVEL_SHORT[lv]
        const code = stdById.get(id)?.code
        return code ? `${code} ${name}` : name
      })
      .filter(Boolean)
      .join(', ')

  const exportExcel = () => {
    if (!okResults.length) return toast('내보낼 평어가 없습니다')
    if (gen.running && !confirm('아직 생성 중입니다. 지금까지 끝난 학생만 Excel에 담습니다. 계속할까요?')) return
    // 오류 결과에만 있는 교과는 빈 열이 되므로 제외
    const okSubjects = subjects.filter((sub) => okResults.some((r) => r.subjects.some((x) => x.subject === sub && x.text.trim())))
    const used = new Set<string>(['학생별'])
    const sheets: Array<{ name: string; rows: Array<Record<string, string | number>> }> = []
    for (const subject of okSubjects) {
      const rows: Array<Record<string, string | number>> = []
      for (const r of okResults) {
        const sc = r.subjects.find((x) => x.subject === subject)
        if (!sc || !sc.text.trim()) continue
        rows.push({ 번호: r.student, 수준: levelText(sc), 평어: sc.text, Bytes: neisBytes(sc.text) })
      }
      if (rows.length) sheets.push({ name: uniqueSheetName(subject, used, '교과'), rows })
    }
    const byStudent = okResults.map((r) => {
      const row: Record<string, string | number> = { 번호: r.student }
      let total = 0
      for (const subject of okSubjects) {
        const t = r.subjects.find((x) => x.subject === subject)?.text ?? ''
        row[`${subject} 평어`] = t
        total += neisBytes(t)
      }
      row['총 Bytes'] = total
      return row
    })
    downloadXlsx(`교과평어_${new Date().toISOString().slice(0, 10)}.xlsx`, [...sheets, { name: '학생별', rows: byStudent }])
    if (errResults.length) toast(`생성 오류 ${errResults.length}명은 제외했습니다`)
  }

  // ---------- 나이스로 보내기 ----------
  const sendNeis = () => {
    const st = useStore.getState()
    const payloads = buildSubjectPayloads(plan, st.results, plans.flatMap((p) => p.standards))
    if (!payloads.length) return toast('나이스로 보낼 평어가 없습니다')
    const errorParas = paragraphs.filter((p) => hasErrors(issuesOf(p.student, p.sc.subject))).length
    const notes: string[] = []
    if (gen.running) notes.push('아직 생성 중입니다. 지금까지 끝난 학생만 담습니다.')
    if (errResults.length) notes.push(`생성 오류 ${errResults.length}명은 제외됩니다.`)
    if (errorParas) notes.push(`검사 오류(이름·허용되지 않는 문자 등)가 있는 문단 ${errorParas}개가 함께 담깁니다.`)
    if (notes.length && !confirm(`${notes.join('\n')}\n그대로 나이스 입력 목록에 담을까요?`)) return
    stageNeisPayloads(['subject'], payloads)
    navigate('/neis')
  }

  const header = (
    <PageHeader
      eyebrow="STEP 3 · 결과 · 방식 B"
      title={<>검사를 통과한 문장만<br />나이스로 보냅니다</>}
      aside={
        <div className="flex flex-col items-end gap-5">
          <ModeSwitch mode="R" />
          <div className="flex gap-7">
            <Stat label="학생" value={okResults.length} of={Math.max(N, okResults.length)} />
            <Stat label="교과 문단" value={paragraphs.length} />
            <Stat label="검사 통과" value={passCount} cls="text-lv0-ink" />
            <Stat label="확인 필요" value={needCount} cls="text-lv2-ink" />
          </div>
        </div>
      }
    />
  )

  const progressCard = gen.running && (
    <Card className="px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
      <Spinner dark />
      <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
        <div className="text-[13px] font-bold">{gen.message}</div>
        <Progress value={gen.total ? (gen.done / gen.total) * 100 : 0} label={<>{gen.done} / {gen.total}명</>} />
      </div>
      <span className="text-[12px] text-muted">끝난 학생부터 아래에 나타납니다</span>
      <button type="button" className="btn btn-sm" onClick={abortGeneration}>중지</button>
    </Card>
  )

  if (!results.length) {
    return (
      <>
        {header}
        {progressCard}
        {gen.running ? (
          <Card className="px-6 py-14 flex flex-col items-center text-center gap-3">
            <Spinner dark />
            <p className="m-0 text-ink-2">첫 학생의 평어를 기다리고 있습니다.</p>
          </Card>
        ) : (
          <Card className="px-6 py-14 flex flex-col items-center text-center gap-3">
            <div className="eyebrow">아직 결과가 없습니다</div>
            <p className="m-0 text-ink-2">성적 입력 화면에서 학생별 성취 수준을 고르고 평어를 생성하면 여기에 모입니다.</p>
            <Link to="/grades" className="btn-primary mt-2">성적 입력으로 가기 →</Link>
          </Card>
        )}
      </>
    )
  }

  const regenButtons = (r: StudentResult, compact = false) => {
    const cur = sentencesOf(r, settings.sentencesPerStandard)
    const other: 1 | 2 = cur === 2 ? 1 : 2
    const busy = gen.running && gen.current === r.student
    return (
      <div className="flex flex-wrap gap-1.5 items-center">
        {busy && <span className="flex items-center gap-1.5 text-[12px] text-muted mr-1"><Spinner dark /> 생성 중</span>}
        <button type="button" className={`btn btn-sm ${r.error ? '!border-ink' : ''}`} onClick={() => regenerate(r.student, cur)} title="이 학생의 모든 교과 평어를 다시 생성합니다">다시 생성</button>
        {!compact && !r.error && (
          <button type="button" className="btn btn-sm" onClick={() => regenerate(r.student, other)} title="이 학생의 모든 교과 평어를 문장 수를 바꿔 다시 생성합니다">{other}문장으로</button>
        )}
      </div>
    )
  }

  const renderParagraph = (r: StudentResult, sc: SubjectComment) => {
    const isEditing = editing?.student === r.student && editing.subject === sc.subject
    if (isEditing) {
      const draft = editing.draft
      const draftIssues = validateComment(flatten(draft), { others: othersFor(r.student, sc.subject), ...SUBJECT_LIMIT })
      return (
        <div className="flex flex-col gap-2 min-w-0">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(null)
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit() }
            }}
            className="field min-h-[120px] leading-[1.65] resize-y"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="text-muted">{neisBytes(flatten(draft))} Bytes · {splitSentences(flatten(draft)).length}문장</span>
            <IssueList issues={draftIssues} />
            <span className="flex-1" />
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>취소</button>
            <button type="button" className="btn-primary !px-4 !py-1.5 text-[13px]" disabled={!flatten(draft)} onClick={saveEdit}>저장</button>
          </div>
        </div>
      )
    }
    const issues = issuesOf(r.student, sc.subject)
    return (
      <div className="flex flex-col gap-2 min-w-0">
        {r.error ? (
          <div className="rounded-[14px] px-4 py-3 bg-surface-2 leading-[1.65] text-muted line-through decoration-muted-2" title="생성 오류로 Excel·나이스에서 제외됩니다">{sc.text || '(문장 없음)'}</div>
        ) : (
          <CopyText id={copyId(r.student, sc)} text={sc.text} />
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span className="text-muted">{neisBytes(sc.text)} Bytes · {splitSentences(sc.text).length}문장</span>
          {r.error ? <span className="font-bold text-lv3-ink">이전 문장 · 제외됨</span> : <IssueList issues={issues} />}
          {sc.edited && <span className="text-muted">직접 수정함</span>}
          <span className="flex-1" />
          {!r.error && busyStudent !== r.student && <button type="button" className="btn btn-sm" onClick={() => startEdit(r, sc)}>수정</button>}
        </div>
      </div>
    )
  }

  const subjectRows = curSubj
    ? results
        .map((r) => ({ r, sc: r.subjects.find((x) => x.subject === curSubj) }))
        .filter(({ r, sc }) => sc || (r.error && !r.subjects.length))
    : []

  return (
    <>
      {header}
      {progressCard}
      {!plan && <Alert kind="warn">활성 평가계획이 없어 다시 생성은 할 수 없습니다. 성취기준 코드는 저장된 평가계획에서 찾아 표시합니다. <Link to="/plan" className="underline font-bold">평가계획</Link></Alert>}
      {errResults.length > 0 && !gen.running && (
        <Alert kind="error">
          생성 오류 {errResults.length}명 ({errResults.map((r) => `${r.student}번`).join(', ')}) · 아래에서 다시 생성하거나 <Link to="/grades" className="underline font-bold">성적 입력</Link>의 "이어서 생성"을 쓰세요. 오류가 난 학생은 Excel과 나이스에서 제외됩니다.
        </Alert>
      )}

      {/* 도구 모음 */}
      <Card className="px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="seg !bg-ground">
          <button type="button" className={`seg-item ${view === 'student' ? 'seg-item-on' : ''}`} onClick={() => setView('student')}>학생별 보기</button>
          <button type="button" className={`seg-item ${view === 'subject' ? 'seg-item-on' : ''}`} onClick={() => setView('subject')}>교과별 보기</button>
        </div>
        <div className="flex-1 min-w-[200px] flex flex-wrap gap-1.5">
          {results.map((r) => {
            const s = statusOf(r)
            const cls = s === 'error' ? 'lv-3' : s === 'check' ? 'lv-2' : 'bg-surface-2 text-ink hover:bg-ground'
            const label = s === 'error' ? '생성 오류' : s === 'check' ? '확인 필요' : '검사 통과'
            return (
              <button key={r.student} type="button" onClick={() => jumpTo(r.student)} title={`${r.student}번 · ${label}`} className={`min-w-9 h-9 px-2 rounded-full text-[13px] font-bold cursor-pointer transition ${cls} ${gen.running && gen.current === r.student ? 'ring-2 ring-accent' : ''}`}>
                {r.student}
              </button>
            )
          })}
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={exportExcel} disabled={!okResults.length}>Excel (.xlsx)</button>
          <button type="button" className="btn-primary" onClick={sendNeis} disabled={!okResults.length}>나이스로 보내기</button>
        </div>
      </Card>

      {view === 'student' &&
        results.map((r) => {
          const stdCount = r.subjects.reduce((a, sc) => a + sc.standardIds.length, 0)
          const bytes = r.subjects.reduce((a, sc) => a + neisBytes(sc.text), 0)
          return (
            <Card key={r.student} className={`overflow-hidden ${r.error ? 'ring-2 ring-lv3-tint' : ''}`}>
              <div id={`student-${r.student}`} className="px-6 py-4 flex flex-wrap items-center gap-x-4 gap-y-2 scroll-mt-4">
                <h2 className="m-0 text-[17px] font-bold">{r.student}번 학생</h2>
                <span className="text-[13px] text-muted">교과 {r.subjects.length}개 · 성취기준 {stdCount}개 · 총 {bytes} Bytes</span>
                {r.error && <span className="pill lv-3">생성 오류</span>}
                <span className="flex-1" />
                {regenButtons(r)}
              </div>
              {r.error && (
                <div className="px-6 pb-4">
                  <Alert kind="error">
                    {r.error}
                    {r.subjects.length > 0 && ' · 아래 이전 문장은 Excel과 나이스에서 제외됩니다.'}
                  </Alert>
                </div>
              )}
              {r.subjects.map((sc) => (
                <article key={sc.subject} className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-x-6 gap-y-3 px-6 py-5 border-t border-line">
                  <div className="flex flex-col gap-2 min-w-0">
                    <div className="font-bold text-[15px]">{sc.subject}</div>
                    <StandardList sc={sc} stdById={stdById} />
                  </div>
                  {renderParagraph(r, sc)}
                </article>
              ))}
            </Card>
          )
        })}

      {view === 'subject' && (
        <Card className="overflow-hidden">
          <div className="px-6 py-4 flex flex-wrap gap-1.5 items-center border-b border-line">
            {subjects.map((s) => {
              const n = okResults.filter((r) => r.subjects.some((x) => x.subject === s && x.text.trim())).length
              const on = s === curSubj
              return (
                <button key={s} type="button" onClick={() => setSubj(s)} className={`rounded-full px-3.5 py-1.5 text-[13px] cursor-pointer transition ${on ? 'bg-ink text-white font-bold' : 'bg-surface-2 hover:bg-ground'}`}>
                  {s} <span className={on ? 'text-white/60' : 'text-muted'}>{n}</span>
                </button>
              )
            })}
            <span className="ml-auto text-[12px] text-muted">문단을 클릭하면 복사되고 붉게 표시됩니다</span>
          </div>
          {!curSubj && <div className="px-6 py-10 text-center text-muted">교과별로 볼 평어가 없습니다. 오류가 난 학생은 학생별 보기에서 다시 생성하세요.</div>}
          {curSubj && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left text-[12px] text-muted">
                  <th className="px-4 py-2.5 font-medium w-14">번호</th>
                  <th className="px-2 py-2.5 font-medium w-[170px]">수준</th>
                  <th className="px-2 py-2.5 font-medium">평어</th>
                  <th className="px-2 py-2.5 font-medium w-16 text-right">Bytes</th>
                  <th className="px-4 py-2.5 font-medium w-[180px]">검사</th>
                </tr>
              </thead>
              <tbody>
                {subjectRows.map(({ r, sc }) => (
                  <tr key={r.student} className="border-t border-line align-top">
                    <td className="px-4 py-3 font-bold">{r.student}</td>
                    {r.error ? (
                      <>
                        <td colSpan={3} className="px-2 py-3">
                          <div className="rounded-[12px] px-3.5 py-2.5 lv-3 flex flex-col gap-1">
                            <span className="font-bold">생성 오류 · 제외됨</span>
                            <span>{r.error}</span>
                            {sc?.text && <span className="line-through opacity-70">{sc.text}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3">{regenButtons(r, true)}</td>
                      </>
                    ) : (
                      sc && (
                        <>
                          <td className="px-2 py-3"><StandardList sc={sc} stdById={stdById} /></td>
                          <td className="px-2 py-2">
                            <CopyText id={copyId(r.student, sc)} text={sc.text} className="!px-3 !py-2" />
                          </td>
                          <td className="px-2 py-3 text-right text-muted tabular-nums">{neisBytes(sc.text)}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1 text-[12px]"><IssueList issues={issuesOf(r.student, sc.subject)} /></div>
                          </td>
                        </>
                      )
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link to="/grades" className="btn btn-sm">← 성적 입력으로</Link>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-sm"
          disabled={gen.running}
          onClick={() => { if (confirm('생성된 교과 평어를 모두 지울까요?')) { setEditing(null); clearResults() } }}
        >
          결과 모두 지우기
        </button>
      </div>
    </>
  )
}
