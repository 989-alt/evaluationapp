import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  BehaviorResult, BehaviorStudent, CreativeAssign, CreativeInput, CreativeResult, EvalPlan, GradeMap, Level, ModeAResult,
  ModelInfo, NeisPayload, Provider, Settings, StudentResult,
} from '@/lib/types'
import { repairPlan } from '@/lib/plan'

/** 크롬 확장(extension/)이 읽는 나이스 입력 데이터. API 키가 든 저장소 본체 대신 이 키만 읽게 합니다 */
export const NEIS_STORAGE_KEY = 'saenggibu-neis'
function mirrorNeis(payloads: NeisPayload[]) {
  try {
    localStorage.setItem(NEIS_STORAGE_KEY, JSON.stringify({ version: 1, payloads }))
  } catch {
    // 저장 공간이 없거나 막힌 경우 무시
  }
  // 같은 탭의 확장(app-bridge.js)이 바로 받아 가도록 알립니다. 같은 출처에만 보냅니다
  try {
    window.postMessage({ type: 'saenggibu-neis', payloads }, location.origin)
  } catch {
    // 무시
  }
}

interface State {
  settings: Settings
  setSettings: (p: Partial<Settings>) => void

  plans: EvalPlan[]
  activePlanId: string | null
  addPlan: (p: EvalPlan) => void
  updatePlan: (id: string, patch: Partial<EvalPlan>) => void
  removePlan: (id: string) => void
  setActivePlan: (id: string | null) => void

  // 방식 A
  modeASelected: string[]
  modeACounts: [number, number, number, number]
  modeAResults: ModeAResult[]
  setModeA: (p: Partial<Pick<State, 'modeASelected' | 'modeACounts' | 'modeAResults'>>) => void

  // 방식 B
  studentCount: number
  grades: GradeMap
  setStudentCount: (n: number) => void
  setGrade: (student: number, standardId: string, level: Level | null) => void
  setGradesBulk: (entries: Array<[number, string, Level | null]>) => void
  clearGrades: () => void
  results: StudentResult[]
  upsertResult: (r: StudentResult) => void
  updateSubjectText: (student: number, subject: string, text: string) => void
  clearResults: () => void

  // 행발
  behaviorStudents: BehaviorStudent[]
  setBehaviorStudents: (s: BehaviorStudent[]) => void
  behaviorResults: BehaviorResult[]
  setBehaviorResults: (r: BehaviorResult[]) => void

  // 창체
  creativeInputs: CreativeInput[]
  setCreativeInputs: (i: CreativeInput[]) => void
  creativeResults: CreativeResult[]
  setCreativeResults: (r: CreativeResult[]) => void
  /** 영역별 학생 배정 (학생 수는 studentCount 공유) */
  creativeAssign: CreativeAssign
  setCreativeAssign: (area: string, student: number, text: string) => void
  setCreativeAssignBulk: (area: string, entries: Array<[number, string]>) => void
  clearCreativeAssign: (area: string) => void

  // copied markers (not persisted)
  copied: Record<string, true>
  markCopied: (id: string) => void

  // NEIS handoff
  neisPayloads: NeisPayload[]
  setNeisPayloads: (p: NeisPayload[]) => void
  /** 지정한 종류의 기존 데이터를 지우고 새 데이터를 뒤에 붙입니다 */
  stageNeisPayloads: (kinds: NeisPayload['kind'][], payloads: NeisPayload[]) => void

  /** 개인정보 검사에서 "보내도 괜찮음"으로 확인한 표현(piiKey → 확인 시각) */
  piiConfirmed: Record<string, number>
  confirmPII: (keys: string[]) => void
  unconfirmPII: (keys: string[]) => void

  resetAll: () => void
}

const defaultSettings: Settings = {
  apiKey: '',
  provider: null,
  model: '',
  models: [],
  ending: '함',
  sentencesPerStandard: 1,
  behaviorBytes: 700,
  persistResults: true,
  guideSeen: false,
  paidKeyConfirmed: false,
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      settings: defaultSettings,
      setSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),

      plans: [],
      activePlanId: null,
      addPlan: (p) => set((s) => ({ plans: [p, ...s.plans], activePlanId: p.id })),
      updatePlan: (id, patch) => set((s) => ({ plans: s.plans.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removePlan: (id) => set((s) => ({ plans: s.plans.filter((p) => p.id !== id), activePlanId: s.activePlanId === id ? (s.plans.find((p) => p.id !== id)?.id ?? null) : s.activePlanId })),
      setActivePlan: (id) => set({ activePlanId: id }),

      modeASelected: [],
      modeACounts: [3, 3, 3, 2],
      modeAResults: [],
      setModeA: (p) => set(p),

      studentCount: 24,
      grades: {},
      setStudentCount: (n) => set({ studentCount: Math.max(1, Math.min(60, n)) }),
      setGrade: (student, standardId, level) =>
        set((s) => {
          const row = { ...(s.grades[student] ?? {}) }
          if (level === null) delete row[standardId]
          else row[standardId] = level
          return { grades: { ...s.grades, [student]: row } }
        }),
      setGradesBulk: (entries) =>
        set((s) => {
          const g: GradeMap = { ...s.grades }
          for (const [student, standardId, level] of entries) {
            const row = { ...(g[student] ?? {}) }
            if (level === null) delete row[standardId]
            else row[standardId] = level
            g[student] = row
          }
          return { grades: g }
        }),
      clearGrades: () => set({ grades: {} }),
      results: [],
      upsertResult: (r) => set((s) => ({ results: [...s.results.filter((x) => x.student !== r.student), r].sort((a, b) => a.student - b.student) })),
      updateSubjectText: (student, subject, text) =>
        set((s) => ({
          results: s.results.map((r) => (r.student !== student ? r : { ...r, subjects: r.subjects.map((sc) => (sc.subject === subject ? { ...sc, text, edited: true } : sc)) })),
        })),
      clearResults: () => set({ results: [] }),

      behaviorStudents: [{ id: 1, checks: {} }],
      setBehaviorStudents: (behaviorStudents) => set({ behaviorStudents }),
      behaviorResults: [],
      setBehaviorResults: (behaviorResults) => set({ behaviorResults }),

      creativeInputs: [{ text: '', count: 3 }],
      setCreativeInputs: (creativeInputs) => set({ creativeInputs }),
      creativeResults: [],
      setCreativeResults: (creativeResults) => set({ creativeResults }),
      creativeAssign: {},
      setCreativeAssign: (area, student, text) =>
        set((s) => {
          const row = { ...(s.creativeAssign[area] ?? {}) }
          if (text) row[student] = text
          else delete row[student]
          return { creativeAssign: { ...s.creativeAssign, [area]: row } }
        }),
      setCreativeAssignBulk: (area, entries) =>
        set((s) => {
          const row = { ...(s.creativeAssign[area] ?? {}) }
          for (const [student, text] of entries) {
            if (text) row[student] = text
            else delete row[student]
          }
          return { creativeAssign: { ...s.creativeAssign, [area]: row } }
        }),
      clearCreativeAssign: (area) =>
        set((s) => {
          const next = { ...s.creativeAssign }
          delete next[area]
          return { creativeAssign: next }
        }),

      copied: {},
      markCopied: (id) => set((s) => ({ copied: { ...s.copied, [id]: true } })),

      neisPayloads: [],
      setNeisPayloads: (neisPayloads) => set({ neisPayloads }),
      stageNeisPayloads: (kinds, payloads) =>
        set((s) => ({ neisPayloads: [...s.neisPayloads.filter((p) => !kinds.includes(p.kind)), ...payloads] })),

      piiConfirmed: {},
      confirmPII: (keys) =>
        set((s) => {
          const now = Date.now()
          const next = { ...s.piiConfirmed }
          for (const k of keys) next[k] = now
          return { piiConfirmed: next }
        }),
      unconfirmPII: (keys) =>
        set((s) => {
          const next = { ...s.piiConfirmed }
          for (const k of keys) delete next[k]
          return { piiConfirmed: next }
        }),

      resetAll: () => {
        localStorage.removeItem('saenggibu-v2')
        localStorage.removeItem(NEIS_STORAGE_KEY)
        location.reload()
      },
    }),
    {
      name: 'saenggibu-v2',
      version: 1,
      // v0(버전 없음) → v1: 구조 변경 없음. migrate가 없으면 zustand가 저장된 상태를 버립니다
      migrate: (persisted) => persisted as State,
      // 기본 병합은 얕아서 나중에 추가한 settings 필드가 사라지므로 settings는 한 단계 더 병합합니다
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>
        const plans = Array.isArray(p.plans) ? p.plans.map(repairPlan) : current.plans
        return { ...current, ...p, plans, settings: { ...current.settings, ...(p.settings ?? {}) }, copied: {} }
      },
      partialize: (s) => {
        const { copied, ...rest } = s
        void copied
        if (!s.settings.persistResults) {
          return { ...rest, modeAResults: [], results: [], behaviorResults: [], creativeResults: [], creativeAssign: {} } as any
        }
        return rest as any
      },
    },
  ),
)

export function useActivePlan(): EvalPlan | null {
  return useStore((s) => s.plans.find((p) => p.id === s.activePlanId) ?? null)
}

export function useClient() {
  const { apiKey, provider, model } = useStore((s) => s.settings)
  if (!apiKey || !provider || !model) return null
  return { key: apiKey, provider: provider as Provider, model }
}

export function modelsByTier(models: ModelInfo[]) {
  const t = (k: ModelInfo['tier']) => models.filter((m) => m.tier === k)
  return { recommended: t('recommended'), fast: t('fast'), best: t('best'), other: t('other') }
}

// 나이스 데이터가 바뀔 때마다 별도 키에 복사합니다
useStore.subscribe((s, prev) => {
  if (s.neisPayloads !== prev.neisPayloads) mirrorNeis(s.neisPayloads)
})
if (useStore.getState().neisPayloads.length) mirrorNeis(useStore.getState().neisPayloads)
