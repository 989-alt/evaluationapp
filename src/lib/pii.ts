/**
 * AI로 보내기 전 개인정보 사전 검사(LLM 없이 코드로만).
 *
 * 너무 자주 울리면 교사가 확인 없이 넘기게 되므로, 실제 개인정보일 가능성이 높은 모양만 잡습니다.
 * - 이름: 성씨 + 1~2음절 + 호칭(학생·어린이·군·양) / 성씨 + 1~2음절 + "이가·이는"은 강하게,
 *         성씨 + 정확히 2음절 + 조사는 이름에 흔한 음절일 때만 잡습니다. 2음절 이름 단독은 잡지 않습니다.
 * - 전화번호·주민번호·이메일: 숫자·형식이 맞을 때만
 * - 생년월일: 앞 12자 안에 "생년월일·생일·출생"이 있을 때만 (평가 시기 같은 날짜는 넘김)
 * - 학교명: "○○초등학교·중학교·고등학교" 전체 형태만, "우리·해당·인근" 같은 일반 표현 제외
 * - 주소: 시·도 + 시·군·구 + 동·읍·면·로·길의 3단계만
 * - 교사 이름: 성씨로 시작하는 2~4음절 + 선생님·교사·담임 ("전담교사" 등 제외)
 * 대괄호 성취기준 코드([6국05-01]) 안은 검사하지 않습니다.
 */
import { NAME_STOP, SURNAMES } from './validate'

export type PIIKind = 'name' | 'phone' | 'rrn' | 'birth' | 'email' | 'school' | 'address' | 'teacher'

export interface PIIHit {
  kind: PIIKind
  start: number
  end: number
  text: string
  reason: string
}

export interface ScanOptions {
  /** 검사할 종류(기본 전부) */
  kinds?: PIIKind[]
}

export const PII_KIND_LABEL: Record<PIIKind, string> = {
  name: '이름 의심',
  phone: '전화번호',
  rrn: '주민번호',
  birth: '생년월일',
  email: '이메일',
  school: '학교명',
  address: '주소',
  teacher: '교사 이름',
}

const STOP = new Set(NAME_STOP)
const S = `[${SURNAMES}]`
const H = '[가-힣]'
const NOT_H = '(?![가-힣])'

/** 이름(뒤 1~2음절)에 흔한 음절. 일반 낱말이 이름 모양으로 잡히는 것을 줄입니다 */
const NAME_SYL = new Set(
  ('가건겸결경광규균근금나남늘다단담도동라람래려련령로루률율리린림만명미민범별보봄비빈빛' +
    '새서석선설섭성세소솔수숙순슬승시아안애언여연열영예옥온완요용우욱운웅원유윤은의이익인일' +
    '자재정제종주준중지진찬창채천철초춘충태택필하한해헌혁현형혜호화환효후훈휘희').split(''),
)
/** 낱말 끝이 이런 음절이면 일반 명사(조상들·정의적·이해력·전개도 …)로 봅니다 */
const NOUN_END = new Set('들적력법감점물회문량값님품표도시군구'.split(''))
/** 호칭 앞 낱말이 이런 음절로 끝나면 꾸미는 말(정직한 학생·신중한 학생)로 봅니다 */
const MOD_END = new Set('한는운던된할될들적의'.split(''))

const jong = (ch: string) => {
  const c = ch.charCodeAt(0)
  return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : -1
}
/** 받침에 맞는 조사인지(김민준이·김지아가). 맞지 않으면 낱말 일부일 가능성이 큽니다 */
function particleFits(word: string, p: string) {
  const j = jong(word[word.length - 1])
  if (p === '이' || p === '은' || p === '을' || p === '과') return j > 0
  if (p === '가' || p === '는' || p === '를' || p === '와') return j === 0
  return true
}

const NAME_HARD_TITLE = new RegExp(`(?<![가-힣])(${S}${H}{1,2})\\s?(학생|어린이|군|양)(?=[^가-힣]|[이은는가의을를과와에도]|$)`, 'g')
const NAME_HARD_NICK = new RegExp(`(?<![가-힣])(${S}${H}{1,2})(이가|이는|이도|이를|이랑|이와|이의)${NOT_H}`, 'g')
const NAME_MODERATE = new RegExp(`(?<![가-힣])(${S}${H}{2})(에게|이|가|은|는|을|를|의|와|과|도)${NOT_H}`, 'g')

const PHONE = /(?<![\d-])0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}(?![\d])/g
const RRN = /(?<!\d)(\d{2})(\d{2})(\d{2})[-\s]?[1-4]\d{6}(?!\d)/g
const BIRTH = /(?:19|20)\d{2}\s?[.\-/년]\s?\d{1,2}\s?[.\-/월]\s?\d{1,2}일?/g
const BIRTH_CUE = /생년월일|생일|출생/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SCHOOL = /(?<![가-힣])([가-힣]{2,10})(초등학교|중학교|고등학교)(?=[^가-힣]|[은는이가의을를에와과도]|$)/g
const SCHOOL_GENERIC = new Set([
  '우리', '본', '각', '타', '해당', '인근', '지역', '전국', '초등', '관내', '초중', '중고', '일반', '특수', '대안', '공립', '사립', '국립',
  '혁신', '연구', '시범', '예비', '상급', '인접', '진학', '희망', '신설', '기존', '국내', '해외', '다른', '같은', '모든', '여러', '근처', '주변',
])
const PROVINCES = '서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|충청북|충청남|전북|전남|전라북|전라남|경북|경남|경상북|경상남|제주'
const ADDRESS = new RegExp(
  `(?<![가-힣])(?:${PROVINCES})(?:특별시|광역시|특별자치시|특별자치도|도|시)?\\s?[가-힣]{1,6}(?:시|군|구)\\s?[가-힣0-9]{1,10}(?:동|읍|면|로|길|구)(?![가-힣])`,
  'g',
)
const TEACHER = new RegExp(`(?<![가-힣])(${S}${H}{1,3})\\s?(선생님|교사|담임)(?=[^가-힣]|[은는이가의을를에께와과도]|$)`, 'g')
const TEACHER_STOP = new Set([
  '담임', '교과', '전담', '지도', '임용', '신규', '협력', '강사', '보조', '전문', '전문상담', '정보', '한문', '한국어', '정규', '장학', '안전', '전임', '전직', '이전', '이번', '전체', '한국',
])
const CODE = /\[[^\]\n]{1,24}\]/g

function nameHits(t: string): PIIHit[] {
  const out: PIIHit[] = []
  for (const m of t.matchAll(NAME_HARD_TITLE)) {
    const w = m[1]
    if (STOP.has(w) || MOD_END.has(w[w.length - 1])) continue
    out.push({ kind: 'name', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: `사람 이름 + 호칭("${m[2]}")으로 보입니다` })
  }
  for (const m of t.matchAll(NAME_HARD_NICK)) {
    const w = m[1]
    if (STOP.has(w)) continue
    out.push({ kind: 'name', start: m.index!, end: m.index! + w.length + 1, text: w + '이', reason: `이름 뒤에 붙는 "이"("${m[2]}")가 있어 사람 이름으로 보입니다` })
  }
  for (const m of t.matchAll(NAME_MODERATE)) {
    const w = m[1]
    const p = m[2]
    if (STOP.has(w)) continue
    const [, a, b] = w
    if (!NAME_SYL.has(a) || !NAME_SYL.has(b) || NOUN_END.has(b)) continue
    if (b === '하' && (p === '는' || p === '도')) continue // 정리하는·이해하는
    if (w.endsWith('해지')) continue // 강해지는
    if (!particleFits(w, p)) continue
    out.push({ kind: 'name', start: m.index!, end: m.index! + w.length, text: w, reason: '성씨로 시작하는 세 글자 + 조사라 이름일 수 있습니다' })
  }
  return out
}

function digitCount(s: string) {
  return s.replace(/\D/g, '').length
}

/** 텍스트에서 개인정보로 보이는 표현을 찾습니다. 겹치는 결과는 앞선(긴) 것 하나만 남깁니다 */
export function scanPII(text: string, opts: ScanOptions = {}): PIIHit[] {
  const t = String(text ?? '')
  if (!t.trim()) return []
  const want = (k: PIIKind) => !opts.kinds || opts.kinds.includes(k)
  const hits: PIIHit[] = []

  if (want('name')) hits.push(...nameHits(t))

  if (want('phone'))
    for (const m of t.matchAll(PHONE)) {
      const d = digitCount(m[0])
      if (d < 9 || d > 11) continue
      if (/^01/.test(m[0]) && !/^01[016789]/.test(m[0])) continue
      hits.push({ kind: 'phone', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '전화번호 형식입니다' })
    }

  if (want('rrn'))
    for (const m of t.matchAll(RRN)) {
      const mo = Number(m[2])
      const da = Number(m[3])
      if (mo < 1 || mo > 12 || da < 1 || da > 31) continue
      hits.push({ kind: 'rrn', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '주민등록번호 형식입니다' })
    }

  if (want('birth'))
    for (const m of t.matchAll(BIRTH)) {
      const before = t.slice(Math.max(0, m.index! - 12), m.index!)
      if (!BIRTH_CUE.test(before)) continue
      hits.push({ kind: 'birth', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '생년월일로 적힌 날짜입니다' })
    }

  if (want('email'))
    for (const m of t.matchAll(EMAIL)) hits.push({ kind: 'email', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '이메일 주소입니다' })

  if (want('school'))
    for (const m of t.matchAll(SCHOOL)) {
      if (SCHOOL_GENERIC.has(m[1])) continue
      hits.push({ kind: 'school', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '특정 학교 이름입니다(학교명도 보호 대상)' })
    }

  if (want('address'))
    for (const m of t.matchAll(ADDRESS)) hits.push({ kind: 'address', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: '시·군·구와 동·도로명까지 있는 주소입니다' })

  if (want('teacher'))
    for (const m of t.matchAll(TEACHER)) {
      const w = m[1]
      if (TEACHER_STOP.has(w) || STOP.has(w) || MOD_END.has(w[w.length - 1])) continue
      hits.push({ kind: 'teacher', start: m.index!, end: m.index! + m[0].length, text: m[0], reason: `교사 이름 + "${m[2]}"으로 보입니다` })
    }

  // 대괄호 성취기준 코드 안은 제외
  const codes = [...t.matchAll(CODE)].filter((m) => /\d/.test(m[0])).map((m) => [m.index!, m.index! + m[0].length] as const)
  const outside = hits.filter((h) => !codes.some(([a, b]) => h.start < b && h.end > a))

  // 겹침 제거: 시작이 빠른 것, 같으면 긴 것
  outside.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const res: PIIHit[] = []
  for (const h of outside) if (!res.length || h.start >= res[res.length - 1].end) res.push(h)
  return res
}

/** 같은 표현을 다시 묻지 않도록 쓰는 키(종류 + 표현) */
export function piiKey(h: Pick<PIIHit, 'kind' | 'text'>): string {
  const s = `${h.kind}|${h.text.replace(/\s+/g, ' ').trim()}`
  let x = 5381
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0
  return (x >>> 0).toString(36)
}
