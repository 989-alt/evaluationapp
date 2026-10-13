export type Level = 0 | 1 | 2 | 3
export const LEVEL_NAMES = ['매우 잘함', '잘함', '보통', '노력 요함'] as const
export const LEVEL_SHORT = ['매우잘함', '잘함', '보통', '노력요함'] as const
export const LEVEL_KEYS = ['veryGood', 'good', 'average', 'needsEffort'] as const
export type LevelKey = (typeof LEVEL_KEYS)[number]

export interface Standard {
  id: string
  subject: string
  code: string // e.g. [6국05-01]
  text: string // 성취기준 본문
  unit?: string
  area?: string
  element?: string // 평가 요소
  method?: string // 평가 방법
  period?: string // 시기
  criteria: [string, string, string, string] // 매우잘함, 잘함, 보통, 노력요함
}

export interface CreativeArea {
  area: string // 자율 / 동아리 / 진로
  goal?: string
  elements?: string[]
  method?: string
  period?: string
}

export interface EvalPlan {
  id: string
  title: string
  /** 예전 버전에서 추출한 학교명. 지금은 추출하지 않고 화면에도 보이지 않습니다 */
  school?: string
  grade?: string
  semester?: string
  createdAt: number
  standards: Standard[]
  creative: CreativeArea[]
  warnings?: string[]
}

export type Provider = 'google' | 'anthropic' | 'openai'

export interface ModelInfo {
  id: string
  name: string
  tier?: 'recommended' | 'fast' | 'best' | 'other'
  note?: string
  pdf?: boolean
}

export interface Settings {
  apiKey: string
  provider: Provider | null
  model: string
  models: ModelInfo[]
  ending: '함' | '하였음'
  sentencesPerStandard: 1 | 2
  behaviorBytes: number
  /** 교과 평어 한 교과 문단의 목표 바이트(한 번 생성 기준) */
  /** 예전 설정 호환용. 교과 평어는 분량 목표 없이 성취기준당 문장 수로만 씁니다 */
  subjectBytes?: number
  persistResults: boolean
  guideSeen: boolean
  /** Google 키가 결제 계정이 연결된(유료) Cloud 프로젝트의 키임을 사용자가 확인함 */
  paidKeyConfirmed?: boolean
}

// 방식 A 결과
export interface ModeAResult {
  standardId: string
  code: string
  text: string
  levels: Record<LevelKey, string[]>
}

// 방식 B
export type GradeMap = Record<number, Record<string, Level>> // student -> standardId -> level

export interface SubjectComment {
  subject: string
  text: string
  standardIds: string[]
  levels: Level[]
  edited?: boolean
}

export interface StudentResult {
  student: number
  subjects: SubjectComment[]
  generatedAt: number
  /** 생성할 때의 성취기준당 문장 수 */
  sentences?: 1 | 2
  error?: string
}

export interface BehaviorStudent {
  id: number
  checks: Record<string, 1 | 2> // trait -> 1 긍정, 2 지도필요
}

export interface BehaviorResult {
  student: number
  text: string
}

export interface CreativeInput {
  text: string
  count: number
  /** 자율 / 동아리 / 진로 / 기타 */
  area?: string
}

/** 영역 -> 학생 번호 -> 배정한 문장 */
export type CreativeAssign = Record<string, Record<number, string>>

export interface CreativeResult {
  original: string
  variations: string[]
}

export interface NeisPayload {
  version: 1
  createdAt: number
  kind: 'subject' | 'behavior' | 'creative'
  subject?: string
  rows: Array<{
    student: number
    text: string
    /** text·area는 나이스 성취기준 행을 찾는 데 씁니다(코드가 본문에 없을 때 본문·영역으로 대응) */
    standards?: Array<{ code: string; level: string; criterion: string; text?: string; area?: string }>
  }>
}
