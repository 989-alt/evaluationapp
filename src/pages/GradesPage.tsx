import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Card, PageHeader, Progress, Spinner, toast } from '@/components/ui'
import { ModeSwitch } from './CommentsPage'
import { useActivePlan, useClient, useStore } from '@/store'
import { abortGeneration, generateStudents, useGenState } from '@/llm/generateModeB'
import { subjectsOf } from '@/lib/plan'
import { downloadXlsx, readXlsxRows } from '@/lib/excel'
import { LEVEL_NAMES, LEVEL_SHORT, type Level, type Standard } from '@/lib/types'

const LEVELS: Level[] = [0, 1, 2, 3]
type View = 'student' | 'standard'

function parseLevel(v: string): Level | null {
  const s = String(v ?? '').replace(/\s+/g, '')
  if (!s) return null
  const byName = (LEVEL_SHORT as readonly string[]).indexOf(s)
  if (byName >= 0) return byName as Level
  if (/^[1-4]$/.test(s)) return (Number(s) - 1) as Level
  return null
}

const normHeader = (s: string) => String(s ?? '').replace(/[\s[\]]/g, '')

function isTextInput(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true
  return t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type)
}

/** 모달·오버레이가 열려 있으면 전역 키 입력을 무시합니다 */
const overlayOpen = () => !!document.querySelector('[role=dialog], .fixed.inset-0')

/** Enter를 스스로 처리하는 요소(수준 버튼 제외) */
function ownsEnter(t: EventTarget | null) {
  if (!(t instanceof HTMLElement) || t.closest('[data-level-btn]')) return false
  return !!t.closest('button, a, summary, [role=button]')
}

/** 4단계 수준 버튼 묶음. 선택된 수준을 다시 누르면 해제 */
function LevelButtons({ value, onChange, compact = false, label }: { value: Level | undefined; onChange: (l: Level | null) => void; compact?: boolean; label: string }) {
  return (
    <div className="flex gap-1.5 shrink-0" role="group" aria-label={label}>
      {LEVELS.map((l) => {
        const on = value === l
        return (
          <button
            key={l}
            type="button"
            data-level-btn=""
            aria-pressed={on}
            aria-label={LEVEL_NAMES[l]}
            title={LEVEL_NAMES[l]}
            onClick={() => onChange(on ? null : l)}
            className={`${compact ? 'w-9 h-9 text-[13px]' : 'min-h-[44px] min-w-[68px] px-3 text-[13px]'} rounded-[10px] font-bold border transition cursor-pointer ${on ? `lv-${l} border-transparent` : 'bg-surface border-line text-muted hover:border-ink hover:text-ink'}`}
          >
            {compact ? l + 1 : LEVEL_SHORT[l]}
          </button>
        )
      })}
    </div>
  )
}

export default function GradesPage() {
  const plan = useActivePlan()
  const client = useClient()
  const navigate = useNavigate()
  const gen = useGenState()
  const settings = useStore((s) => s.settings)
  const N = useStore((s) => s.studentCount)
  const grades = useStore((s) => s.grades)
  const setStudentCount = useStore((s) => s.setStudentCount)
  const setGrade = useStore((s) => s.setGrade)
  const setGradesBulk = useStore((s) => s.setGradesBulk)

  const [view, setView] = useState<View>('student')
  const [activeStudent, setActiveStudent] = useState(1)
  const [activeStdId, setActiveStdId] = useState<string | null>(null)
  const [cur, setCur] = useState(1) // 성취기준별 보기의 현재 학생
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [two, setTwo] = useState(settings.sentencesPerStandard === 2)
  const [error, setError] = useState('')
  const [importInfo, setImportInfo] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const curRowRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const pendingFocus = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const [nDraft, setNDraft] = useState<string | null>(null)
  const results = useStore((s) => s.results)

  const subjects = useMemo(() => (plan ? subjectsOf(plan) : []), [plan])
  const ordered = useMemo<Standard[]>(() => (plan ? subjects.flatMap((sub) => plan.standards.filter((s) => s.subject === sub)) : []), [plan, subjects])
  const total = ordered.length
  const students = useMemo(() => Array.from({ length: N }, (_, i) => i + 1), [N])
  const student = Math.min(activeStudent, N)
  const std = ordered.find((s) => s.id === activeStdId) ?? ordered[0]
  const curStudent = Math.min(cur, N)

  const doneOf = (n: number) => ordered.filter((s) => grades[n]?.[s.id] !== undefined).length
  const complete = students.filter((n) => total > 0 && doneOf(n) === total).length
  const entered = students.filter((n) => doneOf(n) > 0)
  // 이어서 생성: 결과가 없거나 오류가 난 학생
  const remaining = entered.filter((n) => {
    const r = results.find((x) => x.student === n)
    return !r || !!r.error
  })
  const canResume = remaining.length > 0 && entered.some((n) => results.some((r) => r.student === n))
  const failed = results.filter((r) => r.error && r.student <= N).length
  const liveChecked = [...checked].filter((n) => n <= N)

  // 학생 수가 줄면 선택 목록에서 범위 밖 번호 제거
  useEffect(() => {
    setChecked((c) => ([...c].some((n) => n > N) ? new Set([...c].filter((n) => n <= N)) : c))
  }, [N])

  // 학생별 보기: 학생 이동 후 첫 행 포커스
  useEffect(() => {
    if (!pendingFocus.current || !ordered[0]) return
    pendingFocus.current = false
    rowRefs.current[ordered[0].id]?.focus()
  }, [student, ordered])

  const goStudent = (n: number, focusFirst = false) => {
    const next = Math.max(1, Math.min(N, n))
    if (next === student) {
      if (focusFirst) rowRefs.current[ordered[0]?.id ?? '']?.focus()
      return
    }
    pendingFocus.current = focusFirst
    setActiveStudent(next)
  }

  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>, idx: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const s = ordered[idx]
    if (/^[1-4]$/.test(e.key)) {
      e.preventDefault()
      setGrade(student, s.id, (Number(e.key) - 1) as Level)
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      // 수준 버튼에 포커스가 있어도 Enter는 버튼을 다시 누르지 않고 다음 행으로 이동
      e.preventDefault()
      if (idx + 1 < ordered.length) rowRefs.current[ordered[idx + 1].id]?.focus()
      else if (e.key === 'Enter' && student < N) goStudent(student + 1, true)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (idx > 0) rowRefs.current[ordered[idx - 1].id]?.focus()
    }
  }

  // 성취기준별 보기: 1~4 입력 → 현재 학생에 수준 지정 후 다음 학생, Enter 건너뜀
  useEffect(() => {
    if (view !== 'standard' || !std) return
    const h = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTextInput(e.target) || overlayOpen()) return
      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault()
        setGrade(curStudent, std.id, (Number(e.key) - 1) as Level)
        if (curStudent < N) setCur(curStudent + 1)
        else toast('마지막 학생입니다')
      } else if (e.key === 'Enter') {
        if (ownsEnter(e.target)) return
        e.preventDefault()
        if (curStudent < N) setCur(curStudent + 1)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // 화살표는 학생 목록 안(또는 포커스 없음)일 때만 가로챔 — 페이지 스크롤을 막지 않음
        const a = document.activeElement
        if (a && a !== document.body && !gridRef.current?.contains(a)) return
        e.preventDefault()
        setCur(e.key === 'ArrowDown' ? Math.min(N, curStudent + 1) : Math.max(1, curStudent - 1))
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [view, std, curStudent, N, setGrade])

  useEffect(() => {
    if (view === 'standard') curRowRefs.current[curStudent]?.scrollIntoView({ block: 'nearest' })
  }, [view, curStudent])

  const selectStd = (id: string) => {
    setActiveStdId(id)
    setCur(1)
  }
  const stdIdx = std ? ordered.indexOf(std) : -1

  // ---------- Excel ----------
  const onExcel = async (file: File) => {
    if (!plan) return
    try {
      const rows = await readXlsxRows(file)
      const header = rows[0] ?? []
      const colMap: Array<string[] | null> = header.map((h, i) => {
        if (i === 0) return null
        const k = normHeader(h)
        if (!k) return null
        const hits = ordered.filter((s) => {
          const code = normHeader(s.code)
          return !!code && (k === code || k === normHeader(s.subject) + '-' + code)
        })
        return hits.length ? hits.map((s) => s.id) : null
      })
      const unmatched = header.filter((h, i) => i > 0 && String(h).trim() && !colMap[i])
      const entries: Array<[number, string, Level | null]> = []
      const seen = new Set<number>()
      let maxStudent = 0
      for (const r of rows.slice(1)) {
        const n = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''), 10)
        if (!Number.isFinite(n) || n < 1 || n > 60) continue
        for (let i = 1; i < r.length; i++) {
          const ids = colMap[i]
          if (!ids) continue
          const lv = parseLevel(r[i])
          if (lv === null) continue
          for (const id of ids) entries.push([n, id, lv])
          seen.add(n)
          maxStudent = Math.max(maxStudent, n)
        }
      }
      if (!entries.length) {
        setImportInfo({ kind: 'warn', text: '채울 수 있는 칸을 찾지 못했습니다. 첫 줄은 "번호, 국어-[6국05-01], …" 형식이고 칸에는 매우잘함/잘함/보통/노력요함 또는 1~4가 들어가야 합니다.' })
        return
      }
      if (maxStudent > N) setStudentCount(maxStudent)
      setGradesBulk(entries)
      setImportInfo({
        kind: unmatched.length ? 'warn' : 'ok',
        text: `${seen.size}명 · ${entries.length}칸을 채웠습니다.` + (unmatched.length ? ` 평가계획에서 찾지 못한 열: ${unmatched.join(', ')}` : ''),
      })
      toast('성적표로 채웠습니다')
    } catch (e: unknown) {
      setImportInfo({ kind: 'warn', text: '파일을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) })
    }
  }

  const downloadTemplate = () => {
    const rows = students.map((n) => {
      const r: Record<string, string | number> = { 번호: n }
      for (const s of ordered) {
        const lv = grades[n]?.[s.id]
        r[`${s.subject}-${s.code}`] = lv === undefined ? '' : LEVEL_SHORT[lv]
      }
      return r
    })
    downloadXlsx('성적표_양식.xlsx', [{ name: '성적', rows }])
  }

  // ---------- 생성 ----------
  const start = (list: number[], confirmOverwrite = true) => {
    if (!plan) return
    if (!client) return setError('설정에서 API 키와 모델을 먼저 선택하세요.')
    if (gen.running) return setError('이미 생성 중입니다.')
    const targets = list.filter((n) => doneOf(n) > 0)
    if (!targets.length) return setError('수준을 하나 이상 입력한 학생이 없습니다.')
    const st = useStore.getState()
    const overwrite = st.results.filter((r) => targets.includes(r.student)).length
    if (confirmOverwrite && overwrite && !confirm(`이미 생성된 ${overwrite}명의 평어를 새로 생성한 평어로 바꿉니다. 계속할까요?`)) return
    setError('')
    generateStudents({
      client, plan, grades: st.grades, students: targets, sentences: two ? 2 : 1, ending: settings.ending, existing: st.results,
    }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
    navigate('/results')
  }

  if (!plan) {
    return (
      <>
        <PageHeader eyebrow="STEP 2 · 평어 생성 · 방식 B" title={<>학생마다 성취기준별 수준을 고르면<br />교과별 평어를 모아 씁니다</>} aside={<ModeSwitch mode="B" />} />
        <Alert kind="warn">평가계획이 없습니다. <Link to="/plan" className="underline font-bold">평가계획</Link>을 먼저 올리면 성취기준이 여기에 표로 펼쳐집니다.</Alert>
      </>
    )
  }

  return (
    <>
      <PageHeader eyebrow="STEP 2 · 평어 생성 · 방식 B" title={<>학생마다 성취기준별 수준을 고르면<br />교과별 평어를 모아 씁니다</>} aside={<ModeSwitch mode="B" />} />

      {/* 상단 컨트롤 */}
      <Card className="px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="seg !bg-ground">
          <button type="button" className={`seg-item ${view === 'student' ? 'seg-item-on' : ''}`} onClick={() => setView('student')}>학생별 보기</button>
          <button type="button" className={`seg-item ${view === 'standard' ? 'seg-item-on' : ''}`} onClick={() => setView('standard')}>성취기준별 보기</button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          학생 수
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            inputMode="numeric"
            value={nDraft ?? String(N)}
            onChange={(e) => {
              const v = e.target.value
              setNDraft(v)
              if (/^\d+$/.test(v) && Number(v) >= 1) setStudentCount(Math.min(60, Number(v)))
            }}
            onBlur={() => setNDraft(null)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="field !w-[72px] !py-1.5 text-right"
          />
          명
        </label>
        <div className="flex-1 min-w-[200px]">
          <Progress value={N ? (complete / N) * 100 : 0} label={<>입력 완료 <b className="text-ink">{complete}</b> / {N}명</>} />
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={downloadTemplate} title="현재 입력값이 담긴 성적표 양식을 내려받습니다">양식 받기</button>
          <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>Excel 성적표로 채우기</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onExcel(f); e.target.value = '' }} />
        </div>
      </Card>
      {importInfo && <Alert kind={importInfo.kind}>{importInfo.text}</Alert>}
      {!total && <Alert kind="warn">활성 평가계획에 성취기준이 없습니다. <Link to="/plan" className="underline font-bold">평가계획</Link>에서 성취기준을 추가하세요.</Alert>}

      {total > 0 && view === 'student' && (
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-5 items-start">
          {/* 학생 목록 */}
          <Card className="p-2 lg:sticky lg:top-4 max-h-[70vh] overflow-auto">
            <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-1 gap-1">
              {students.map((n) => {
                const d = doneOf(n)
                const on = n === student
                return (
                  <button key={n} type="button" onClick={() => goStudent(n)} className={`flex items-center justify-between gap-2 rounded-[12px] px-3 py-2 text-left cursor-pointer transition ${on ? 'bg-ink text-white font-bold' : 'hover:bg-surface-2'}`}>
                    <span>{n}번</span>
                    <span className={`text-[11px] font-bold rounded-full px-1.5 ${on ? 'text-white/70' : d === total ? 'lv-0' : d ? 'text-ink-2' : 'text-muted-2'}`}>{d}/{total}</span>
                  </button>
                )
              })}
            </div>
          </Card>

          {/* 교과별 카드 */}
          <div className="flex flex-col gap-4 min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="m-0 text-[22px] font-bold">{student}번 학생</h2>
              <span className="text-[13px] text-muted">{doneOf(student)} / {total} 선택</span>
              <span className="flex-1" />
              <span className="text-[12px] text-muted">행을 누른 뒤 키보드 1 2 3 4 · Enter 다음 행</span>
              <button type="button" className="btn btn-sm" disabled={student <= 1} onClick={() => goStudent(student - 1)}>← 이전 학생</button>
              <button type="button" className="btn btn-sm" disabled={student >= N} onClick={() => goStudent(student + 1)}>다음 학생 →</button>
            </div>
            {subjects.map((sub) => {
              const list = ordered.filter((s) => s.subject === sub)
              const n = list.filter((s) => grades[student]?.[s.id] !== undefined).length
              return (
                <Card key={sub} className="overflow-hidden">
                  <div className="px-6 py-4 flex flex-wrap items-center gap-2.5 border-b border-line">
                    <h3 className="m-0 text-[17px] font-bold">{sub}</h3>
                    <span className="text-[13px] text-muted">{n} / {list.length} 선택</span>
                    <span className="flex-1" />
                    <span className="text-[12px] text-muted">이 교과 전체를</span>
                    {LEVELS.map((l) => (
                      <button key={l} type="button" className={`pill lv-${l} cursor-pointer hover:opacity-80`} onClick={() => setGradesBulk(list.map((s) => [student, s.id, l]))}>{LEVEL_SHORT[l]}</button>
                    ))}
                    <button type="button" className="btn btn-sm !py-0.5" onClick={() => setGradesBulk(list.map((s) => [student, s.id, null]))}>지우기</button>
                  </div>
                  {list.map((s) => {
                    const idx = ordered.indexOf(s)
                    return (
                      <div
                        key={s.id}
                        ref={(el) => { rowRefs.current[s.id] = el }}
                        tabIndex={0}
                        onKeyDown={(e) => onRowKey(e, idx)}
                        className="flex flex-col md:flex-row md:items-center gap-3 px-6 py-3 border-t border-line first:border-t-0 outline-none focus:bg-surface-2 focus:shadow-[inset_3px_0_0_var(--color-accent)] focus-within:bg-surface-2"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-[12px] text-accent font-bold">{s.code}</span> {s.text}
                          {s.element && <span className="block text-[12px] text-muted">{s.element}</span>}
                        </div>
                        <LevelButtons label={`${s.code || s.subject} 성취 수준`} value={grades[student]?.[s.id]} onChange={(l) => setGrade(student, s.id, l)} />
                      </div>
                    )
                  })}
                </Card>
              )
            })}
            <div className="flex justify-between">
              <button type="button" className="btn" disabled={student <= 1} onClick={() => goStudent(student - 1)}>← {Math.max(1, student - 1)}번</button>
              <button type="button" className="btn-primary" disabled={student >= N} onClick={() => goStudent(student + 1, true)}>{Math.min(N, student + 1)}번 학생 →</button>
            </div>
          </div>
        </div>
      )}

      {total > 0 && view === 'standard' && std && (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5 items-start">
          {/* 성취기준 목록 */}
          <Card className="p-2 lg:sticky lg:top-4 max-h-[70vh] overflow-auto">
            {subjects.map((sub) => (
              <div key={sub} className="mb-1">
                <div className="px-3 pt-2.5 pb-1 text-[12px] font-bold text-muted">{sub}</div>
                {ordered.filter((s) => s.subject === sub).map((s) => {
                  const on = s.id === std.id
                  const d = students.filter((n) => grades[n]?.[s.id] !== undefined).length
                  return (
                    <button key={s.id} type="button" onClick={() => selectStd(s.id)} className={`w-full flex items-center gap-2 rounded-[12px] px-3 py-2 text-left cursor-pointer transition ${on ? 'bg-ink text-white' : 'hover:bg-surface-2'}`}>
                      <span className="flex-1 min-w-0">
                        <span className={`block font-mono text-[12px] font-bold ${on ? 'text-white' : 'text-accent'}`}>{s.code || '코드 없음'}</span>
                        <span className={`block truncate text-[12px] ${on ? 'text-white/70' : 'text-muted'}`}>{s.element || s.text}</span>
                      </span>
                      <span className={`text-[11px] font-bold rounded-full px-1.5 shrink-0 ${on ? 'text-white/70' : d === N ? 'lv-0' : d ? 'text-ink-2' : 'text-muted-2'}`}>{d}/{N}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </Card>

          <Card className="overflow-hidden min-w-0">
            <div className="px-6 py-5 border-b border-line flex flex-col gap-1.5">
              <div className="text-[12px] font-bold text-muted">{std.subject}</div>
              <div className="text-[16px] leading-[1.5]"><span className="font-mono text-[13px] text-accent font-bold">{std.code}</span> {std.text}</div>
              <div className="text-[12px] text-muted">{[std.unit, std.area, std.element, std.method, std.period].filter(Boolean).join(' · ')}</div>
              <details className="text-[12px] mt-1">
                <summary className="cursor-pointer text-ink-2">수준별 평가 기준 보기</summary>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                  {LEVELS.map((l) => <div key={l} className={`rounded-[10px] px-3 py-2 lv-${l}`}><b>{LEVEL_SHORT[l]}</b> {std.criteria[l] || '기준 없음'}</div>)}
                </div>
              </details>
            </div>
            <div className="px-6 py-3 bg-surface-2 border-b border-line flex flex-wrap items-center gap-2.5">
              <label className="flex items-center gap-2 text-[13px] cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-ink" checked={liveChecked.length === N && N > 0} onChange={(e) => setChecked(e.target.checked ? new Set(students) : new Set())} />
                전체 선택
              </label>
              <span className="text-[13px] text-ink-2">선택한 <b>{liveChecked.length}</b>명을 →</span>
              {LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  disabled={!liveChecked.length}
                  className={`pill lv-${l} cursor-pointer hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed`}
                  onClick={() => setGradesBulk(liveChecked.map((n) => [n, std.id, l]))}
                >
                  {LEVEL_SHORT[l]}
                </button>
              ))}
              <span className="flex-1" />
              <span className="text-[12px] text-muted">키보드: 1 2 3 4 입력 · Enter 다음 학생</span>
            </div>
            <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-line">
              {[students.slice(0, Math.ceil(N / 2)), students.slice(Math.ceil(N / 2))].map((col, ci) => (
                <div key={ci} className="flex flex-col">
                  {col.map((n) => {
                    const isCur = n === curStudent
                    return (
                      <div
                        key={n}
                        ref={(el) => { curRowRefs.current[n] = el }}
                        onClick={() => setCur(n)}
                        className={`flex items-center gap-3 px-5 py-1.5 border-b border-line cursor-pointer ${isCur ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-ink"
                          aria-label={`${n}번 선택`}
                          checked={checked.has(n)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { const c = new Set(checked); if (e.target.checked) c.add(n); else c.delete(n); setChecked(c) }}
                        />
                        <span className={`w-10 ${isCur ? 'font-bold' : 'text-ink-2'}`}>{n}번</span>
                        <span className="flex-1" />
                        <LevelButtons compact label={`${n}번 수준`} value={grades[n]?.[std.id]} onChange={(l) => { setGrade(n, std.id, l); setCur(n) }} />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="px-6 py-3.5 flex justify-between items-center gap-2">
              <button type="button" className="btn btn-sm" disabled={stdIdx <= 0} onClick={() => selectStd(ordered[stdIdx - 1].id)}>← 이전 성취기준</button>
              <span className="text-[12px] text-muted">{stdIdx + 1} / {total}</span>
              <button type="button" className="btn-primary !py-1.5 text-[13px]" disabled={stdIdx >= total - 1} onClick={() => selectStd(ordered[stdIdx + 1].id)}>다음 성취기준 →</button>
            </div>
          </Card>
        </div>
      )}

      {/* 하단 고정 바 */}
      <div className="sticky bottom-4 z-20 bg-ink text-white rounded-[20px] px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)]">
        {gen.running ? (
          <>
            <Spinner />
            <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
              <div className="text-[13px] font-bold">{gen.message}</div>
              <Progress value={gen.total ? (gen.done / gen.total) * 100 : 0} label={<span className="text-white/70">{gen.done} / {gen.total}명</span>} />
            </div>
            <Link to="/results" className="btn btn-sm !bg-transparent !text-white !border-white/30 hover:!border-white">결과 보기</Link>
            <button type="button" className="btn btn-sm" onClick={abortGeneration}>중지</button>
          </>
        ) : (
          <>
            <div className="flex-1 min-w-[220px]">
              <div className="font-bold">생성 준비</div>
              <div className="text-[12px] text-white/60">미선택 성취기준은 건너뜀 · 학생 1명당 요청 1회 · 번호만 전송 · 학생 간 문장 중복 없음</div>
              {failed > 0 && <div className="text-[12px] text-accent mt-1">오류가 난 학생 {failed}명 · "이어서 생성"으로 다시 시도할 수 있습니다</div>}
              {error && <div className="text-[12px] text-accent mt-1">{error} {!client && <Link to="/settings" className="underline">설정으로 가기</Link>}</div>}
            </div>
            <label className="flex items-center gap-2 text-[13px] cursor-pointer">
              <input type="checkbox" checked={two} onChange={(e) => setTwo(e.target.checked)} className="w-4 h-4 accent-accent" />
              성취기준당 2문장
            </label>
            {view === 'student' && (
              <button type="button" className="btn !bg-transparent !text-white !border-white/30 hover:!border-white" disabled={doneOf(student) === 0} onClick={() => start([student])}>
                이 학생만 생성
              </button>
            )}
            {canResume && (
              <button type="button" className="btn !bg-transparent !text-white !border-white/30 hover:!border-white" onClick={() => start(remaining, false)} title={failed ? `오류 ${failed}명 포함` : undefined}>
                이어서 생성 (남은 {remaining.length}명)
              </button>
            )}
            <button type="button" className="btn-accent" disabled={!entered.length} onClick={() => start(entered)}>입력된 {entered.length}명 평어 생성</button>
          </>
        )}
      </div>
    </>
  )
}
