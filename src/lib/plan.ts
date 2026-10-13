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

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
const four = (c: unknown): Standard['criteria'] => {
  const a = Array.isArray(c) ? c.map((x) => String(x ?? '')) : []
  while (a.length < 4) a.push('')
  return [a[0], a[1], a[2], a[3]]
}

/**
 * 저장되었거나 불러온 평가계획의 빠진 필드를 채웁니다(id는 유지).
 * creative·criteria·text가 없는 계획이 화면을 깨뜨리지 않게 합니다.
 */
export function repairPlan(p: any): EvalPlan {
  const src = isObj(p) ? p : {}
  return {
    ...src,
    id: String(src.id || uid()),
    title: String(src.title ?? ''),
    school: src.school == null ? undefined : String(src.school),
    grade: src.grade == null ? undefined : String(src.grade),
    semester: src.semester == null ? undefined : String(src.semester),
    createdAt: Number(src.createdAt) || Date.now(),
    standards: (Array.isArray(src.standards) ? src.standards : []).filter(isObj).map((s: Record<string, any>) => ({
      ...s,
      id: String(s.id || uid()),
      subject: String(s.subject || '기타'),
      code: String(s.code ?? ''),
      text: String(s.text ?? ''),
      criteria: four(s.criteria),
    })),
    creative: (Array.isArray(src.creative) ? src.creative : []).filter(isObj).map((c: Record<string, any>) => ({
      ...c,
      area: String(c.area ?? ''),
      elements: Array.isArray(c.elements) ? c.elements.map((x: unknown) => String(x ?? '')) : undefined,
    })),
    warnings: Array.isArray(src.warnings) ? src.warnings.map((w: unknown) => String(w ?? '')) : [],
  }
}

/** JSON으로 불러온 평가계획. 성취기준 id는 유지(성적·결과 연결)하고 계획 id는 항상 새로 만듭니다 */
export function sanitizePlan(p: any, fileName: string): EvalPlan {
  const r = repairPlan(p)
  return { ...r, id: uid(), title: r.title || fileName.replace(/\.json$/i, ''), createdAt: Date.now() }
}
