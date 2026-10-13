import type { CreativeArea, EvalPlan, Standard } from './types'
import { uid } from './text'

interface RawPlan {
  school?: string
  grade?: string
  semester?: string
  year?: string
  subjects?: Array<{ name: string; standards?: Array<Partial<Standard> & { criteria?: unknown }> }>
  creative?: CreativeArea[]
  warnings?: string[]
}

export function normalizePlan(raw: RawPlan, fileName: string): EvalPlan {
  const standards: Standard[] = []
  const warnings: string[] = [...(raw.warnings ?? [])]
  for (const subj of raw.subjects ?? []) {
    for (const st of subj.standards ?? []) {
      const c = Array.isArray(st.criteria) ? st.criteria.map((x) => String(x ?? '').trim()) : []
      while (c.length < 4) c.push('')
      if (c.some((x) => !x)) warnings.push(`${st.code ?? ''} 기준 문장이 비어 있는 수준이 있습니다`)
      standards.push({
        id: uid(),
        subject: String(subj.name ?? '').trim() || '기타',
        code: String(st.code ?? '').trim(),
        text: String(st.text ?? '').trim(),
        unit: st.unit ? String(st.unit).trim() : undefined,
        area: st.area ? String(st.area).trim() : undefined,
        element: st.element ? String(st.element).trim() : undefined,
        method: st.method ? String(st.method).trim() : undefined,
        period: st.period ? String(st.period).trim() : undefined,
        criteria: [c[0], c[1], c[2], c[3]],
      })
    }
  }
  const grade = raw.grade ? String(raw.grade) : ''
  const sem = raw.semester ? String(raw.semester) : ''
  const year = raw.year ? String(raw.year) : ''
  const title = [grade, sem].filter(Boolean).join(' ') + (year ? ` (${year})` : '') || fileName.replace(/\.pdf$/i, '')
  return {
    id: uid(),
    title,
    school: raw.school ? String(raw.school) : undefined,
    grade, semester: sem,
    createdAt: Date.now(),
    standards,
    creative: (raw.creative ?? []).map((c) => ({ area: String(c.area ?? ''), goal: c.goal, elements: c.elements, method: c.method, period: c.period })),
    warnings,
  }
}

export function subjectsOf(plan: EvalPlan): string[] {
  const seen: string[] = []
  for (const s of plan.standards) if (!seen.includes(s.subject)) seen.push(s.subject)
  return seen
}

export function emptyStandard(subject: string): Standard {
  return { id: uid(), subject, code: '', text: '', criteria: ['', '', '', ''] }
}
