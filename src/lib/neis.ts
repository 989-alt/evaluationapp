import { LEVEL_SHORT, type EvalPlan, type NeisPayload, type Standard, type StudentResult } from './types'
import type { ValidateOptions } from './validate'

/**
 * 나이스에는 고정 상한이 없습니다. 분량은 "목표 바이트"로만 다룹니다(교과 평어·행발 모두 설정에서 조정).
 * 행발은 목표 + 150B를 넘으면 참고용 경고만 띄우고, 교과·창체는 바이트 검사를 하지 않습니다.
 */
export const BEHAVIOR_EXTRA_BYTES = 150

/** 종류별 바이트 검사 옵션. 행발만 경고, 교과·창체는 검사 없음 */
export function neisByteLimit(kind: NeisPayload['kind'], behaviorBytes: number): Pick<ValidateOptions, 'maxBytes' | 'maxBytesLevel'> {
  if (kind === 'behavior') return { maxBytes: behaviorBytes + BEHAVIOR_EXTRA_BYTES, maxBytesLevel: 'warn' }
  return {}
}

/**
 * 교과별 나이스 입력 데이터를 만듭니다. 교과마다 payload 1개.
 * - 오류(error)가 있는 결과는 제외합니다(실패한 다시 생성의 이전 문장이 남아 있을 수 있음).
 * - 문장이 빈 교과도 제외합니다.
 * - standards: 결과의 standardIds/levels를 평가계획 성취기준에 대응시킵니다(찾지 못한 성취기준은 건너뜀).
 * `extra`에는 다른 평가계획의 성취기준을 넘겨 계획이 바뀐 경우에도 코드를 찾을 수 있게 합니다.
 */
export function buildSubjectPayloads(plan: EvalPlan | null, results: StudentResult[], extra: Standard[] = []): NeisPayload[] {
  const byId = new Map<string, Standard>()
  for (const s of extra) byId.set(s.id, s)
  for (const s of plan?.standards ?? []) byId.set(s.id, s)

  const ok = results.filter((r) => !r.error).sort((a, b) => a.student - b.student)

  // 교과 순서: 평가계획 순서, 그다음 결과에만 있는 교과
  const order: string[] = []
  for (const s of plan?.standards ?? []) if (!order.includes(s.subject)) order.push(s.subject)
  for (const r of ok) for (const sc of r.subjects) if (!order.includes(sc.subject)) order.push(sc.subject)

  const createdAt = Date.now()
  const out: NeisPayload[] = []
  for (const subject of order) {
    const rows: NeisPayload['rows'] = []
    for (const r of ok) {
      const sc = r.subjects.find((x) => x.subject === subject)
      const text = sc?.text.trim()
      if (!sc || !text) continue
      const standards: NonNullable<NeisPayload['rows'][number]['standards']> = []
      sc.standardIds.forEach((id, i) => {
        const std = byId.get(id)
        const level = sc.levels[i]
        if (!std || level === undefined) return
        standards.push({ code: std.code, level: LEVEL_SHORT[level], criterion: std.criteria[level] ?? '' })
      })
      rows.push({ student: r.student, text, standards })
    }
    if (rows.length) out.push({ version: 1, createdAt, kind: 'subject', subject, rows })
  }
  return out
}
