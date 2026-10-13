import { LEVEL_SHORT, type EvalPlan, type NeisPayload, type Standard, type StudentResult } from './types'
import type { ValidateOptions } from './validate'

/**
 * 나이스 입력 상한(한글 3B). 교과 학기말 종합의견·창체 특기사항 문단은 1500B를 넉넉한 상한으로 보고 경고만 합니다.
 * 기재요령(학교급·항목별 글자 수)을 확인한 뒤 조정하세요.
 */
export const NEIS_MAX_BYTES = { subject: 1500, creative: 1500 } as const
/** 행동특성 및 종합의견은 목표 바이트 + 150B를 넘으면 오류로 봅니다 */
export const BEHAVIOR_EXTRA_BYTES = 150

/** 종류별 바이트 검사 옵션. 행발은 오류, 교과·창체는 경고 */
export function neisByteLimit(kind: NeisPayload['kind'], behaviorBytes: number): Pick<ValidateOptions, 'maxBytes' | 'maxBytesLevel'> {
  if (kind === 'behavior') return { maxBytes: behaviorBytes + BEHAVIOR_EXTRA_BYTES, maxBytesLevel: 'error' }
  return { maxBytes: NEIS_MAX_BYTES[kind], maxBytesLevel: 'warn' }
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
