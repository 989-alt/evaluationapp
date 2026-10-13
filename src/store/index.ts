import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  BehaviorResult, BehaviorStudent, CreativeInput, CreativeResult, EvalPlan, GradeMap, Level, ModeAResult,
  ModelInfo, NeisPayload, Provider, Settings, StudentResult,
} from '@/lib/types'

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

  // copied markers (not persisted)
  copied: Record<string, true>
  markCopied: (id: string) => void

  // NEIS handoff
  neisPayloads: NeisPayload[]
  setNeisPayloads: (p: NeisPayload[]) => void

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

      copied: {},
      markCopied: (id) => set((s) => ({ copied: { ...s.copied, [id]: true } })),

      neisPayloads: [],
      setNeisPayloads: (neisPayloads) => set({ neisPayloads }),

      resetAll: () => {
        localStorage.removeItem('saenggibu-v2')
        location.reload()
      },
    }),
    {
      name: 'saenggibu-v2',
      partialize: (s) => {
        const { copied, ...rest } = s
        void copied
        if (!s.settings.persistResults) {
          return { ...rest, modeAResults: [], results: [], behaviorResults: [], creativeResults: [] } as any
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
