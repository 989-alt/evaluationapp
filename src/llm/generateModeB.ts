import { useSyncExternalStore } from 'react'
import type { Client } from './provider'
import { asArray, generateJSON } from './provider'
import { modeBPrompt, SYSTEM_TEACHER, type StudentSubjectInput } from './prompts'
import type { EvalPlan, GradeMap, StudentResult, SubjectComment } from '@/lib/types'
import { subjectsOf } from '@/lib/plan'
import { flatten, sleep, splitSentences } from '@/lib/text'
import { useStore } from '@/store'

// ---------- generation state (module-level external store) ----------

export interface GenSnapshot {
  running: boolean
  current: number | null // 지금 생성 중인 학생 번호
  done: number
  total: number
  message: string
}

let snapshot: GenSnapshot = { running: false, current: null, done: 0, total: 0, message: '' }
const listeners = new Set<() => void>()

function setSnapshot(patch: Partial<GenSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((fn) => fn())
}

export const genState = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  getSnapshot(): GenSnapshot {
    return snapshot
  },
}

export function useGenState(): GenSnapshot {
  return useSyncExternalStore(genState.subscribe, genState.getSnapshot)
}

let controller: AbortController | null = null

/** 진행 중인 생성을 중지합니다 */
export function abortGeneration() {
  controller?.abort()
}

// ---------- helpers ----------

const AVOID_CAP = 60

/** 학생 한 명의 성적을 교과별 입력으로 묶습니다. 수준이 없는 성취기준·교과는 건너뜁니다. */
export function buildStudentInput(plan: EvalPlan, grades: GradeMap, student: number): StudentSubjectInput[] {
  const row = grades[student] ?? {}
  const out: StudentSubjectInput[] = []
  for (const subject of subjectsOf(plan)) {
    const items: StudentSubjectInput['items'] = []
    for (const s of plan.standards) {
      if (s.subject !== subject) continue
      const level = row[s.id]
      if (level === undefined) continue
      items.push({ standardId: s.id, code: s.code, text: s.text, element: s.element, level, criterion: s.criteria[level] ?? '' })
    }
    if (items.length) out.push({ subject, items })
  }
  return out
}

function avoidFor(pool: Map<number, StudentResult>, student: number, subjects: string[]): string[] {
  const want = new Set(subjects)
  const others = [...pool.values()].filter((r) => r.student !== student && !r.error).sort((a, b) => b.generatedAt - a.generatedAt)
  const acc: string[] = []
  for (const r of others) {
    for (const sc of r.subjects) {
      if (!want.has(sc.subject)) continue
      for (const s of splitSentences(sc.text)) {
        if (acc.length >= AVOID_CAP) return acc
        if (!acc.includes(s)) acc.push(s)
      }
    }
  }
  return acc
}

interface RawOut {
  student?: number
  subjects?: Array<{ subject?: string; text?: string }>
}

function unwrap(out: unknown, student: number): RawOut {
  let o: unknown = out
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(o)) {
      o = o.find((x) => Number((x as RawOut)?.student) === student) ?? o[0]
      continue
    }
    if (o && typeof o === 'object' && !Array.isArray((o as RawOut).subjects)) {
      const w = o as Record<string, unknown>
      // { items|results|data|students: [...] } 처럼 배열을 감싼 경우
      const list = asArray(w)
      if (list.length && list[0] !== w) {
        o = list
        continue
      }
      const inner = w.result ?? w.data ?? w.students
      if (inner && typeof inner === 'object') {
        o = inner
        continue
      }
    }
    break
  }
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as RawOut) : {}
}

/** AI 응답을 결과로 바꿉니다. 빈 교과가 하나라도 있으면 오류를 던집니다. */
function toResult(student: number, input: StudentSubjectInput[], out: unknown, sentences: 1 | 2): StudentResult {
  const o = unwrap(out, student)
  const raw = Array.isArray(o.subjects) ? o.subjects : []
  const norm = (s: string) => s.replace(/\s+/g, '')
  const subjects: SubjectComment[] = input.map((inp, i) => {
    const hit = raw.find((r) => norm(String(r?.subject ?? '')) === norm(inp.subject)) ?? (raw.length === input.length ? raw[i] : undefined)
    return {
      subject: inp.subject,
      text: flatten(hit?.text),
      standardIds: inp.items.map((it) => it.standardId),
      levels: inp.items.map((it) => it.level),
    }
  })
  const missing = subjects.filter((sc) => !sc.text).map((sc) => sc.subject)
  if (missing.length) throw new Error(`AI 응답에서 ${missing.join(', ')} 평어를 찾지 못했습니다`)
  return { student, subjects, generatedAt: Date.now(), sentences }
}

// ---------- main ----------

export interface GenerateStudentsOptions {
  client: Client
  plan: EvalPlan
  grades: GradeMap
  students: number[]
  sentences: 1 | 2
  ending: '함' | '하였음'
  /** 이미 생성된 결과(다른 학생 문장 중복 회피용) */
  existing: StudentResult[]
  onProgress?: (s: GenSnapshot) => void
  signal?: AbortSignal
}

/**
 * 학생마다 요청 1회로 교과별 평어를 생성하고, 한 명이 끝날 때마다 store.upsertResult로 저장합니다.
 * 한 학생이 실패해도 error를 기록하고 다음 학생으로 넘어갑니다.
 */
export async function generateStudents(opts: GenerateStudentsOptions): Promise<void> {
  if (snapshot.running) throw new Error('이미 평어를 생성하고 있습니다. 끝난 뒤 다시 시도하세요.')
  const { client, plan, grades, sentences, ending, onProgress } = opts

  const ctrl = new AbortController()
  controller = ctrl
  const signal = ctrl.signal
  const onOuterAbort = () => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onOuterAbort)
  }

  const jobs = [...new Set(opts.students)]
    .sort((a, b) => a - b)
    .map((student) => ({ student, input: buildStudentInput(plan, grades, student) }))
    .filter((j) => j.input.length > 0)

  const runSet = new Set(jobs.map((j) => j.student))
  const pool = new Map<number, StudentResult>()
  for (const r of opts.existing) if (!runSet.has(r.student)) pool.set(r.student, r)

  const update = (patch: Partial<GenSnapshot>) => {
    setSnapshot(patch)
    onProgress?.(snapshot)
  }

  update({ running: true, current: null, done: 0, total: jobs.length, message: jobs.length ? '평어 생성을 시작합니다' : '생성할 학생이 없습니다' })

  const wait = /pro/i.test(client.model) ? 20000 : 2500
  let errors = 0
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (signal.aborted) break
      const { student, input } = jobs[i]
      if (i > 0) {
        update({ current: student, message: `${student}번 생성 대기 중…` })
        await sleep(wait, signal)
        if (signal.aborted) break
      }
      update({ current: student, message: `${student}번 평어 생성 중… (${i + 1}/${jobs.length})` })
      try {
        const avoid = avoidFor(pool, student, input.map((s) => s.subject))
        const out = await generateJSON<unknown>(client, {
          system: SYSTEM_TEACHER,
          prompt: modeBPrompt(student, input, sentences, ending, avoid),
          temperature: 0.8,
          signal,
        })
        const result = toResult(student, input, out, sentences)
        pool.set(student, result)
        useStore.getState().upsertResult(result)
      } catch (e: unknown) {
        if (signal.aborted) break
        errors++
        // 다시 생성하다 실패한 경우에만 이전 문장을 남기고(오류 표시와 함께), 그 외에는 비웁니다
        const st = useStore.getState()
        const prev = st.results.find((r) => r.student === student)
        const keep = prev && prev.subjects.some((sc) => sc.text.trim()) ? prev.subjects : []
        st.upsertResult({
          student,
          subjects: keep,
          generatedAt: Date.now(),
          error: e instanceof Error ? e.message : String(e),
        })
      }
      update({ done: i + 1 })
    }
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort)
    if (controller === ctrl) controller = null
    const done = snapshot.done
    const message = !jobs.length
      ? '생성할 학생이 없습니다'
      : signal.aborted
        ? `중지했습니다 · ${done} / ${jobs.length}명 완료`
        : `생성 완료 · ${done - errors}명 성공${errors ? ` · ${errors}명 실패` : ''}`
    update({ running: false, current: null, message })
  }
}
