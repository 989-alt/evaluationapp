import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, CopyText, PageHeader, Stat, toast } from '@/components/ui'
import { useActivePlan, useStore } from '@/store'
import { useGenState } from '@/llm/generateModeB'
import { hasErrors, validateComment, type Issue } from '@/lib/validate'
import { downloadXlsx, uniqueSheetName } from '@/lib/excel'
import { buildBehaviorPayload, buildCreativePayloads, buildSubjectPayloads, neisByteLimit } from '@/lib/neis'
import { hash, neisBytes } from '@/lib/text'
import type { BehaviorResult, CreativeAssign, EvalPlan, NeisPayload, StudentResult } from '@/lib/types'

type Kind = NeisPayload['kind']
type Sheet = { name: string; rows: Array<Record<string, string | number>> }
interface Row {
  student: number
  text: string
  copyId: string
  issues: Issue[]
}

const BASE_AREAS = ['자율', '동아리', '진로']
const today = () => new Date().toISOString().slice(0, 10)
/** 다른 화면과 같은 id를 써서 어디서 복사해도 함께 붉게 표시됩니다 */
const COPY_ID: Record<Kind, (student: number, text: string, subject?: string) => string> = {
  subject: (n, t, s) => `r-${n}-${s}-${hash(t)}`,
  behavior: (n, t) => `b-${n}-${hash(t)}`,
  creative: (n, t, s) => `k-${s}-${n}-${hash(t)}`,
}

/** 화면에 보이는 것과 나이스로 보내는 것이 같도록 표시도 payload에서 만듭니다 */
function collect(src: {
  plan: EvalPlan | null
  plans: EvalPlan[]
  results: StudentResult[]
  behaviorResults: BehaviorResult[]
  behaviorCount: number
  creativeAssign: CreativeAssign
  studentCount: number
}) {
  const subject = buildSubjectPayloads(src.plan, src.results, src.plans.flatMap((p) => p.standards))
  // 행발 화면과 같은 범위(학생 수 안의 번호)만 담습니다
  const behavior = buildBehaviorPayload(src.behaviorResults.filter((r) => r.student >= 1 && r.student <= src.behaviorCount))
  const extra = Object.keys(src.creativeAssign).filter((a) => !BASE_AREAS.includes(a)).sort((a, b) => a.localeCompare(b, 'ko'))
  const students = Array.from({ length: src.studentCount }, (_, i) => i + 1)
  const creative = buildCreativePayloads(src.creativeAssign, [...BASE_AREAS, ...extra], students)
  return { subject, behavior: behavior ? [behavior] : [], creative }
}

/** payload 행마다 검사 결과와 복사 id를 붙입니다. 같은 payload의 다른 학생 문장과 중복을 봅니다 */
function rowsOf(p: NeisPayload, behaviorBytes: number): Row[] {
  const limit = neisByteLimit(p.kind, behaviorBytes)
  return p.rows.map((r, i) => ({
    student: r.student,
    text: r.text,
    copyId: COPY_ID[p.kind](r.student, r.text, p.subject),
    issues: validateComment(r.text, { others: p.rows.filter((_, j) => j !== i).map((x) => x.text), ...limit }),
  }))
}

const errorCount = (rows: Row[]) => rows.filter((r) => hasErrors(r.issues)).length

const TEXT_COLUMN: Record<Kind, string> = { subject: '평어', behavior: '행동특성 및 종합의견', creative: '특기사항' }
function sheetsOf(payloads: NeisPayload[], used: Set<string>, prefix = ''): Sheet[] {
  return payloads.map((p) => ({
    name: uniqueSheetName(`${prefix}${p.subject ?? (p.kind === 'behavior' ? '행동특성' : '시트')}`, used),
    rows: p.rows.map((r) => ({ 번호: r.student, [TEXT_COLUMN[p.kind]]: r.text, Bytes: neisBytes(r.text) })),
  }))
}

function IssueBadge({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <span className="pill lv-0">검사 통과</span>
  const err = hasErrors(issues)
  return (
    <span className={`pill ${err ? 'lv-3' : 'lv-2'} cursor-help`} title={issues.map((i) => i.message).join('\n')}>
      {err ? '오류' : '확인'} {issues.length}
    </span>
  )
}

function Meta({ row }: { row: Row }) {
  return (
    <div className="flex flex-col items-end gap-1.5 text-[12px]">
      <span className="text-muted tabular-nums">{neisBytes(row.text)} Bytes</span>
      <IssueBadge issues={row.issues} />
    </div>
  )
}

/** 번호 · 문장 · 바이트/검사 표 */
function RowsTable({ rows }: { rows: Row[] }) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <div key={r.student} className="grid grid-cols-[48px_1fr_110px] gap-x-4 items-start px-6 py-3 border-t border-line">
          <span className="pt-2.5 font-bold tabular-nums">{r.student}번</span>
          <CopyText id={r.copyId} text={r.text} className="!px-3.5 !py-2.5" />
          <Meta row={r} />
        </div>
      ))}
    </div>
  )
}

function Tabs({ items, cur, onPick }: { items: Array<{ key: string; n: number }>; cur: string; onPick: (k: string) => void }) {
  return (
    <div className="px-6 py-3.5 flex flex-wrap gap-1.5 items-center border-t border-line">
      {items.map(({ key, n }) => {
        const on = key === cur
        return (
          <button key={key} type="button" onClick={() => onPick(key)} className={`rounded-full px-3.5 py-1.5 text-[13px] cursor-pointer transition ${on ? 'bg-ink text-white font-bold' : 'bg-surface-2 hover:bg-ground'}`}>
            {key} <span className={on ? 'text-white/60' : 'text-muted'}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

function Section({
  id, eyebrow, title, count, edit, onExcel, onSend, disabled, children,
}: {
  id: string
  eyebrow: string
  title: string
  count: ReactNode
  edit: { to: string; label: string }
  onExcel: () => void
  onSend: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <Card id={id} className="overflow-hidden scroll-mt-4">
      <div className="px-6 py-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex-1 min-w-[220px]">
          <div className="eyebrow mb-1">{eyebrow}</div>
          <h2 className="m-0 text-[18px] font-bold">{title} <span className="text-[14px] font-normal text-muted">{count}</span></h2>
        </div>
        <Link to={edit.to} className="text-[13px] text-ink-2 underline underline-offset-2 hover:text-ink">{edit.label}</Link>
        <button type="button" className="btn btn-sm" onClick={onExcel} disabled={disabled}>Excel (.xlsx)</button>
        <button type="button" className="btn-primary" onClick={onSend} disabled={disabled}>나이스로 보내기</button>
      </div>
      {children}
    </Card>
  )
}

function Empty({ text, to, label }: { text: string; to: string; label: string }) {
  return (
    <div className="px-6 py-10 border-t border-line flex flex-col items-center text-center gap-3">
      <p className="m-0 text-muted">{text}</p>
      <Link to={to} className="btn btn-sm">{label}</Link>
    </div>
  )
}

export default function CollectPage() {
  const navigate = useNavigate()
  const gen = useGenState()
  const plan = useActivePlan()
  const plans = useStore((s) => s.plans)
  const results = useStore((s) => s.results)
  const behaviorResults = useStore((s) => s.behaviorResults)
  const behaviorCount = useStore((s) => s.behaviorStudents.length)
  const creativeAssign = useStore((s) => s.creativeAssign)
  const studentCount = useStore((s) => s.studentCount)
  const behaviorBytes = useStore((s) => s.settings.behaviorBytes)
  const stageNeisPayloads = useStore((s) => s.stageNeisPayloads)

  const [view, setView] = useState<'student' | 'subject'>('student')
  const [subj, setSubj] = useState<string | null>(null)
  const [area, setArea] = useState<string | null>(null)
  const [closed, setClosed] = useState<Set<number>>(new Set())

  const data = useMemo(
    () => collect({ plan, plans, results, behaviorResults, behaviorCount, creativeAssign, studentCount }),
    [plan, plans, results, behaviorResults, behaviorCount, creativeAssign, studentCount],
  )

  const subjectRows = useMemo(() => data.subject.map((p) => ({ subject: p.subject ?? '', rows: rowsOf(p, behaviorBytes) })), [data, behaviorBytes])
  const behaviorRows = useMemo(() => (data.behavior[0] ? rowsOf(data.behavior[0], behaviorBytes) : []), [data, behaviorBytes])
  const creativeRows = useMemo(() => data.creative.map((p) => ({ area: p.subject ?? '', rows: rowsOf(p, behaviorBytes) })), [data, behaviorBytes])

  // 학생별 보기: 학생 → 교과 문단
  const byStudent = useMemo(() => {
    const m = new Map<number, Array<{ subject: string; row: Row }>>()
    for (const { subject, rows } of subjectRows)
      for (const row of rows) m.set(row.student, [...(m.get(row.student) ?? []), { subject, row }])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [subjectRows])

  const errResults = results.filter((r) => !!r.error).length
  const paragraphCount = subjectRows.reduce((a, s) => a + s.rows.length, 0)
  const creativeCount = creativeRows.reduce((a, s) => a + s.rows.length, 0)
  const curSubj = subjectRows.find((s) => s.subject === subj) ?? subjectRows[0]
  const curArea = creativeRows.find((s) => s.area === area) ?? creativeRows[0]

  // ---------- 확인 문구 ----------
  const notesFor = (kind: Kind): string[] => {
    const notes: string[] = []
    if (kind === 'subject') {
      if (gen.running) notes.push('교과 평어를 아직 생성 중입니다. 지금까지 끝난 학생만 담습니다.')
      if (errResults) notes.push(`교과 평어 생성 오류 ${errResults}명은 제외됩니다.`)
      const n = subjectRows.reduce((a, s) => a + errorCount(s.rows), 0)
      if (n) notes.push(`검사 오류(이름·허용되지 않는 문자 등)가 있는 교과 문단 ${n}개가 함께 담깁니다.`)
    }
    if (kind === 'behavior') {
      const n = errorCount(behaviorRows)
      if (n) notes.push(`검사 오류(이름·허용되지 않는 문자 등)가 있는 행발 ${n}명이 함께 담깁니다.`)
    }
    if (kind === 'creative') {
      const n = creativeRows.reduce((a, s) => a + errorCount(s.rows), 0)
      if (n) notes.push(`검사 오류(이름·허용되지 않는 문자 등)가 있는 창체 ${n}명이 함께 담깁니다.`)
    }
    return notes
  }

  // ---------- 나이스로 보내기 ----------
  const send = (kinds: Kind[]) => {
    // 누르는 순간의 저장소로 다시 만들어 createdAt과 내용이 최신이 되게 합니다
    const st = useStore.getState()
    const fresh = collect({
      plan: st.plans.find((p) => p.id === st.activePlanId) ?? null,
      plans: st.plans, results: st.results, behaviorResults: st.behaviorResults, behaviorCount: st.behaviorStudents.length,
      creativeAssign: st.creativeAssign, studentCount: st.studentCount,
    })
    // 비어 있는 종류는 건드리지 않습니다(이미 담아 둔 데이터를 지우지 않도록)
    const ready = kinds.filter((k) => fresh[k].length)
    if (!ready.length) return toast('나이스로 보낼 문장이 없습니다')
    const notes = ready.flatMap(notesFor)
    if (notes.length && !confirm(`${notes.join('\n')}\n그대로 나이스 입력 목록에 담을까요?`)) return
    stageNeisPayloads(ready, ready.flatMap((k) => fresh[k]))
    navigate('/neis')
  }

  // ---------- Excel ----------
  const exportExcel = (kinds: Kind[]) => {
    const ready = kinds.filter((k) => data[k].length)
    if (!ready.length) return toast('내보낼 문장이 없습니다')
    if (ready.includes('subject') && gen.running && !confirm('교과 평어를 아직 생성 중입니다. 지금까지 끝난 학생만 Excel에 담습니다. 계속할까요?')) return
    const used = new Set<string>()
    const sheets: Sheet[] = []
    if (ready.includes('subject')) sheets.push(...sheetsOf(data.subject, used))
    if (ready.includes('behavior')) sheets.push(...sheetsOf(data.behavior, used))
    if (ready.includes('creative')) sheets.push(...sheetsOf(data.creative, used, '창체 '))
    const name = ready.length > 1 ? '생기부_모아보기' : ready[0] === 'subject' ? '교과평어' : ready[0] === 'behavior' ? '행동특성및종합의견' : '창의적체험활동'
    downloadXlsx(`${name}_${today()}.xlsx`, sheets)
  }

  const total = paragraphCount + behaviorRows.length + creativeCount
  const allOpen = closed.size === 0

  return (
    <>
      <PageHeader
        eyebrow="STEP 3.5 · 모아보기"
        title={<>완성된 평어를 한곳에서 보고<br />나이스로 보냅니다</>}
        aside={
          <div className="flex gap-7">
            <Stat label="교과 문단" value={paragraphCount} />
            <Stat label="행발 학생" value={behaviorRows.length} />
            <Stat label="창체 배정 합계" value={creativeCount} />
          </div>
        }
      />

      {/* 도구 모음 */}
      <Card className="px-6 py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex flex-wrap gap-1.5">
          {[
            { id: 'collect-subject', label: '교과 평어', n: paragraphCount },
            { id: 'collect-behavior', label: '행발', n: behaviorRows.length },
            { id: 'collect-creative', label: '창체', n: creativeCount },
          ].map((c) => (
            <button key={c.id} type="button" onClick={() => document.getElementById(c.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="rounded-full px-3.5 py-1.5 text-[13px] cursor-pointer transition bg-surface-2 hover:bg-ground">
              {c.label} <span className="text-muted tabular-nums">{c.n}</span>
            </button>
          ))}
        </div>
        <span className="flex-1 min-w-[180px] text-[12px] text-muted">문장을 클릭하면 복사되고 붉게 표시됩니다 · 다시 보내면 같은 종류의 이전 데이터는 바뀝니다</span>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => exportExcel(['subject', 'behavior', 'creative'])} disabled={!total}>전체 Excel</button>
          <button type="button" className="btn-primary" onClick={() => send(['subject', 'behavior', 'creative'])} disabled={!total}>전부 나이스로 보내기</button>
        </div>
      </Card>

      {/* 교과 평어 */}
      <Section
        id="collect-subject"
        eyebrow="교과학습발달상황"
        title="교과 평어"
        count={<>{byStudent.length}명 · {paragraphCount}문단{gen.running && ' · 생성 중'}{errResults > 0 && ` · 생성 오류 ${errResults}명 제외`}</>}
        edit={{ to: '/results', label: '결과 페이지에서 수정·재생성 →' }}
        onExcel={() => exportExcel(['subject'])}
        onSend={() => send(['subject'])}
        disabled={!paragraphCount}
      >
        {!paragraphCount ? (
          <Empty text="아직 완성된 교과 평어가 없습니다. 성적을 입력하고 평어를 생성하면 여기에 모입니다." to="/grades" label="성적 입력으로 가기 →" />
        ) : (
          <>
            <div className="px-6 py-3.5 flex flex-wrap items-center gap-3 border-t border-line">
              <div className="seg !bg-ground">
                <button type="button" className={`seg-item ${view === 'student' ? 'seg-item-on' : ''}`} onClick={() => setView('student')}>학생별</button>
                <button type="button" className={`seg-item ${view === 'subject' ? 'seg-item-on' : ''}`} onClick={() => setView('subject')}>교과별</button>
              </div>
              <span className="flex-1" />
              {view === 'student' && (
                <button type="button" className="btn btn-sm" onClick={() => setClosed(allOpen ? new Set(byStudent.map(([n]) => n)) : new Set())}>{allOpen ? '모두 접기' : '모두 펼치기'}</button>
              )}
            </div>

            {view === 'student' &&
              byStudent.map(([n, list]) => {
                const open = !closed.has(n)
                const bytes = list.reduce((a, x) => a + neisBytes(x.row.text), 0)
                const issues = list.flatMap((x) => x.row.issues)
                const toggle = () => {
                  const next = new Set(closed)
                  if (open) next.add(n)
                  else next.delete(n)
                  setClosed(next)
                }
                return (
                  <div key={n} className="border-t border-line">
                    <button type="button" onClick={toggle} aria-expanded={open} className="w-full text-left px-6 py-3 bg-surface-2 hover:bg-ground cursor-pointer flex items-center gap-3 transition">
                      <span className="text-[12px] w-3">{open ? '▾' : '▸'}</span>
                      <b className="text-[15px]">{n}번</b>
                      <span className="text-[13px] text-muted">교과 {list.length}개 · 총 {bytes} Bytes</span>
                      <span className="flex-1" />
                      <IssueBadge issues={issues} />
                    </button>
                    {open &&
                      list.map(({ subject, row }) => (
                        <div key={subject} className="grid grid-cols-[120px_1fr_110px] gap-x-4 items-start px-6 py-3 border-t border-line">
                          <span className="pt-2.5 font-bold truncate" title={subject}>{subject}</span>
                          <CopyText id={row.copyId} text={row.text} className="!px-3.5 !py-2.5" />
                          <Meta row={row} />
                        </div>
                      ))}
                  </div>
                )
              })}

            {view === 'subject' && curSubj && (
              <>
                <Tabs items={subjectRows.map((s) => ({ key: s.subject, n: s.rows.length }))} cur={curSubj.subject} onPick={setSubj} />
                <RowsTable rows={curSubj.rows} />
              </>
            )}
          </>
        )}
      </Section>

      {/* 행발 */}
      <Section
        id="collect-behavior"
        eyebrow="행동특성 및 종합의견"
        title="행발"
        count={<>{behaviorRows.length}명</>}
        edit={{ to: '/behavior', label: '행발에서 수정·재생성 →' }}
        onExcel={() => exportExcel(['behavior'])}
        onSend={() => send(['behavior'])}
        disabled={!behaviorRows.length}
      >
        {behaviorRows.length ? (
          <RowsTable rows={behaviorRows} />
        ) : (
          <Empty text="아직 완성된 행동특성 및 종합의견이 없습니다. 특성을 고르고 생성하면 여기에 모입니다." to="/behavior" label="행발로 가기 →" />
        )}
      </Section>

      {/* 창체 */}
      <Section
        id="collect-creative"
        eyebrow="창의적 체험활동"
        title="창체"
        count={<>{creativeRows.map((s) => `${s.area} ${s.rows.length}명`).join(' · ') || '배정 없음'}</>}
        edit={{ to: '/creative', label: '창체에서 배정 고치기 →' }}
        onExcel={() => exportExcel(['creative'])}
        onSend={() => send(['creative'])}
        disabled={!creativeCount}
      >
        {curArea ? (
          <>
            <Tabs items={creativeRows.map((s) => ({ key: s.area, n: s.rows.length }))} cur={curArea.area} onPick={setArea} />
            <RowsTable rows={curArea.rows} />
          </>
        ) : (
          <Empty text="아직 학생에게 배정한 창체 문장이 없습니다. 변형 문장을 만들고 학생에게 배정하면 여기에 모입니다." to="/creative" label="창체로 가기 →" />
        )}
      </Section>
    </>
  )
}
