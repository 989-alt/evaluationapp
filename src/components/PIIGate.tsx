import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card } from './ui'
import { PII_KIND_LABEL, piiKey, scanPII, type PIIHit } from '@/lib/pii'
import { LEVEL_SHORT, type Standard } from '@/lib/types'
import { useStore } from '@/store'

/** 검사할 입력 하나. label은 어디에서 나온 글인지 보여 주는 이름입니다 */
export interface PIIItem {
  label: string
  text: string
}

interface GateGroup {
  key: string
  hit: PIIHit
  source: string
  labels: string[]
}

/** 찾은 표현을 노란 형광으로 표시합니다 */
export function highlightPII(text: string, hits: Array<Pick<PIIHit, 'start' | 'end' | 'reason'>>): ReactNode {
  const out: ReactNode[] = []
  let at = 0
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    if (h.start < at) continue
    if (h.start > at) out.push(text.slice(at, h.start))
    out.push(<mark key={h.start} className="pii" title={h.reason}>{text.slice(h.start, h.end)}</mark>)
    at = h.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

/** 찾은 곳 앞뒤 일부만 보여 줍니다(PDF 전체 글 등 긴 입력). 줄바꿈은 같은 길이의 공백으로 바꿔 위치를 유지합니다 */
function snippet(source: string, hit: PIIHit, pad = 28): ReactNode {
  const a = Math.max(0, hit.start - pad)
  const b = Math.min(source.length, hit.end + pad)
  const part = source.slice(a, b).replace(/\s/g, ' ')
  return (
    <>
      {a > 0 && '…'}
      {highlightPII(part, [{ start: hit.start - a, end: hit.end - a, reason: hit.reason }])}
      {b < source.length && '…'}
    </>
  )
}

/** 입력 목록을 검사하고, 이미 "보내도 괜찮음"으로 확인한 표현은 따로 셉니다 */
export function usePIIGate(items: PIIItem[]) {
  const confirmed = useStore((s) => s.piiConfirmed)
  const confirm = useStore((s) => s.confirmPII)
  const unconfirm = useStore((s) => s.unconfirmPII)
  const sig = items.map((i) => `${i.label}\u0001${i.text}`).join('\u0002')
  // 입력 글이 바뀔 때만 다시 검사합니다
  const groups = useMemo(() => groupHits(items), [sig])
  const open = groups.filter((g) => !confirmed[g.key])
  const suppressed = groups.filter((g) => confirmed[g.key])
  return {
    open,
    suppressed,
    /** 남은 확인 필요 표현이 없으면 true(찾은 것이 없을 때 포함) */
    ok: open.length === 0,
    confirmAll: () => confirm(open.map((g) => g.key)),
    recheck: () => unconfirm(suppressed.map((g) => g.key)),
  }
}
export type PIIGateState = ReturnType<typeof usePIIGate>

function groupHits(items: PIIItem[]): GateGroup[] {
  const map = new Map<string, GateGroup>()
  for (const it of items) {
    for (const hit of scanPII(it.text)) {
      const key = piiKey(hit)
      const g = map.get(key)
      if (g) g.labels.push(it.label)
      else map.set(key, { key, hit, source: it.text, labels: [it.label] })
    }
  }
  return [...map.values()]
}

/** 스캔 없이 바로 판단할 때(평가계획 업로드처럼 화면에 그리기 전에 정해야 할 때) */
export function unconfirmedCount(items: PIIItem[]): number {
  const confirmed = useStore.getState().piiConfirmed
  return groupHits(items).filter((g) => !confirmed[g.key]).length
}

const MAX_ROWS = 40

/**
 * 생성 버튼 가까이에 두는 개인정보 확인 카드.
 * 찾은 것이 없으면 아무것도 그리지 않고, 확인을 마치면 한 줄로 줄어듭니다.
 * 생성 버튼은 gate.ok가 false인 동안 막습니다.
 */
export function PIIGate({ gate, reminder = true, what = '평어 생성' }: { gate: PIIGateState; reminder?: boolean; what?: string }) {
  const total = gate.open.reduce((a, g) => a + g.labels.length, 0)
  return (
    <>
      {reminder && <PaidKeyReminder />}
      {gate.open.length > 0 ? (
        <Card className="pii-card p-6 flex flex-col gap-3.5" id="pii-gate">
          <div className="eyebrow">AI로 보내기 전 개인정보 확인</div>
          <div className="flex flex-wrap items-center gap-2.5">
            <mark className="pii pii-badge">확인 필요</mark>
            <h2 className="m-0 text-[17px] font-bold">개인정보로 보이는 표현 {total}곳</h2>
          </div>
          <p className="m-0 text-[13px] text-muted leading-[1.6]">
            AI 제공사로 보내기 전에 앱이 직접 찾아낸 표현입니다(AI를 쓰지 않음). 실제 학생·교사 이름이나 연락처라면 해당 칸에서 지우거나 번호·일반 표현으로 바꾼 뒤 다시 시도하세요.
          </p>
          <ul className="m-0 p-0 list-none max-h-[300px] overflow-auto rounded-[14px] bg-surface-2">
            {gate.open.slice(0, MAX_ROWS).map((g) => (
              <li key={g.key} className="grid grid-cols-[auto_1fr] md:grid-cols-[minmax(0,180px)_88px_1fr] gap-x-3 gap-y-1 items-baseline px-4 py-2.5 border-t border-line first:border-t-0">
                <span className="text-[12px] text-muted truncate" title={g.labels.join(', ')}>
                  {g.labels[0]}
                  {g.labels.length > 1 && ` 외 ${g.labels.length - 1}곳`}
                </span>
                <span className="pill pii-note justify-self-start">{PII_KIND_LABEL[g.hit.kind]}</span>
                <span className="col-span-2 md:col-span-1 text-[13px] leading-[1.6] break-all">{snippet(g.source, g.hit)}</span>
              </li>
            ))}
          </ul>
          {gate.open.length > MAX_ROWS && <div className="text-[12px] text-muted">외 {gate.open.length - MAX_ROWS}개 표현이 더 있습니다.</div>}
          <label className="flex gap-2.5 items-start rounded-[12px] pii-note px-3.5 py-3 cursor-pointer text-[13px] font-bold">
            <input type="checkbox" checked={false} onChange={gate.confirmAll} className="mt-0.5 w-4 h-4 accent-ink" />
            <span>
              개인정보가 아니거나 보내도 괜찮은 내용입니다. 그대로 진행합니다
              <span className="block font-normal text-ink-2">체크하면 {what}을 시작할 수 있고, 같은 표현은 다음부터 묻지 않습니다.</span>
            </span>
          </label>
        </Card>
      ) : gate.suppressed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted px-1">
          <span className="pill lv-0">개인정보 확인함</span>
          <span>보내도 괜찮다고 확인한 표현 {gate.suppressed.length}개는 다시 묻지 않습니다.</span>
          <button type="button" className="underline cursor-pointer" onClick={gate.recheck}>다시 검사</button>
        </div>
      ) : null}
    </>
  )
}

/** Google 무료 키 안내(막지는 않음). 설정에서 "결제가 연결된 유료 키입니다"를 체크하면 사라집니다 */
export function PaidKeyReminder() {
  const settings = useStore((s) => s.settings)
  if (settings.provider !== 'google' || !settings.apiKey || settings.paidKeyConfirmed) return null
  return (
    <div className="rounded-[12px] pii-note px-3.5 py-2.5 text-[13px]">
      <b>Google 무료 키 주의</b> · 결제 계정이 연결되지 않은 키는 입력 내용이 Google 제품 개선에 쓰이고 사람이 검토할 수 있습니다.{' '}
      <Link to="/settings" className="underline font-bold">설정에서 유료 키인지 확인</Link>
    </div>
  )
}

/** 성취기준에서 AI로 보내는 글(본문·평가 요소·영역·수준별 기준)과 교과명을 검사 입력으로 만듭니다 */
export function standardItems(stds: Array<Pick<Standard, 'subject' | 'code' | 'text' | 'element' | 'area' | 'criteria'>>): PIIItem[] {
  const out: PIIItem[] = []
  const subjects = [...new Set(stds.map((s) => s.subject).filter(Boolean))]
  if (subjects.length) out.push({ label: '교과명', text: subjects.join(', ') })
  for (const s of stds) {
    const base = [s.subject, s.code].filter(Boolean).join(' ') || '성취기준'
    if (s.text) out.push({ label: `${base} · 성취기준`, text: s.text })
    if (s.element) out.push({ label: `${base} · 평가 요소`, text: s.element })
    if (s.area) out.push({ label: `${base} · 영역`, text: s.area })
    s.criteria.forEach((c, i) => {
      if (c) out.push({ label: `${base} · ${LEVEL_SHORT[i]} 기준`, text: c })
    })
  }
  return out
}
