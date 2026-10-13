import { neisBytes, splitSentences } from './text'

export interface Issue {
  level: 'error' | 'warn'
  code: 'ending' | 'chars' | 'bytes' | 'name' | 'duplicate' | 'empty' | 'subject'
  message: string
}

export interface ValidateOptions {
  maxBytes?: number
  /** other students' texts, used for cross-student duplicate check */
  others?: string[]
}

const ALLOWED_ENDINGS = /(함|임|음|됨|짐|함\.|임\.|음\.|됨\.|짐\.)$/
// 허용: 한글, 영문, 숫자, 공백, 온점, 반점, 가운뎃점, 괄호(일부 학교 허용)… 보수적으로 온점/반점/괄호만 허용
const FORBIDDEN = /[^가-힣a-zA-Z0-9\s.,()·~%]/g
// 성(姓) + 2~3글자 + 조사 패턴 → 사람 이름 의심 (보수적)
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민류나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용'
const NAME_RE = new RegExp(`(^|[\\s,.(])([${SURNAMES}][가-힣]{1,2})(이|가|은|는|의|을|를|과|와|에게|학생)(?=[\\s,.)]|$)`, 'g')
const SUBJECT_RE = /(^|\s)(그는|그녀는|학생은|본인은|이 학생은)(\s|$)/

export function validateComment(text: string, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = []
  const t = text.trim()
  if (!t) return [{ level: 'error', code: 'empty', message: '내용이 없습니다' }]

  const sentences = splitSentences(t)
  const bad = sentences.filter((s) => !ALLOWED_ENDINGS.test(s.replace(/\s+$/, '')))
  if (bad.length) issues.push({ level: 'warn', code: 'ending', message: `명사형 종결이 아닌 문장 ${bad.length}개 ("-함." / "-임.")` })

  const forb = t.match(FORBIDDEN)
  if (forb) {
    const uniq = Array.from(new Set(forb)).join(' ')
    issues.push({ level: 'error', code: 'chars', message: `허용되지 않는 문자: ${uniq}` })
  }

  const bytes = neisBytes(t)
  if (opts.maxBytes && bytes > opts.maxBytes) issues.push({ level: 'error', code: 'bytes', message: `${bytes} Bytes · 상한 ${opts.maxBytes} 초과` })

  NAME_RE.lastIndex = 0
  const nm = t.match(NAME_RE)
  if (nm) issues.push({ level: 'error', code: 'name', message: `사람 이름으로 보이는 표현: ${Array.from(new Set(nm.map((m) => m.trim()))).join(', ')}` })

  if (SUBJECT_RE.test(t)) issues.push({ level: 'warn', code: 'subject', message: '주어("학생은" 등)는 생략합니다' })

  if (opts.others && opts.others.length) {
    const mine = new Set(sentences.map(norm))
    let dup = 0
    for (const o of opts.others) for (const s of splitSentences(o)) if (mine.has(norm(s))) dup++
    if (dup) issues.push({ level: 'warn', code: 'duplicate', message: `다른 학생과 같은 문장 ${dup}개 → 다시 생성 권장` })
  }
  return issues
}

function norm(s: string) {
  return s.replace(/\s+/g, '').replace(/[.,]/g, '')
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === 'error')
