import { neisBytes, splitSentences } from './text'

export interface Issue {
  level: 'error' | 'warn'
  code: 'ending' | 'chars' | 'bytes' | 'name' | 'duplicate' | 'empty' | 'subject'
  message: string
}

export interface ValidateOptions {
  maxBytes?: number
  /** 바이트 초과를 오류로 볼지 경고로 볼지 (기본 오류) */
  maxBytesLevel?: 'error' | 'warn'
  /** other students' texts, used for cross-student duplicate check */
  others?: string[]
}

/** 명사형 종결: 마지막 음절의 받침이 ㅁ(함·음·됨·뛰어남) 또는 ㄻ(앎) */
function endsNominal(sentence: string) {
  const t = sentence.replace(/[.\s]+$/, '')
  const c = t.charCodeAt(t.length - 1)
  if (!(c >= 0xac00 && c <= 0xd7a3)) return false
  const jong = (c - 0xac00) % 28
  return jong === 16 /* ㅁ */ || jong === 10 /* ㄻ */
}
// 허용: 한글, 영문, 숫자, 공백(스페이스만), 온점, 반점, 가운뎃점, 괄호(일부 학교 허용). 줄바꿈·탭은 나이스에서 바이트를 먹으므로 금지
const FORBIDDEN = /[^가-힣a-zA-Z0-9 .,()·]/g
const showChar = (c: string) => (c === '\n' || c === '\r' ? '줄바꿈' : c === '\t' ? '탭' : /\s/.test(c) ? '특수 공백' : c)

// 사람 이름 의심: 상위 성씨 + 1~2음절 + 호칭(학생·어린이·군·양)은 오류, 성씨 + 2음절 + 조사는 경고
// 개인정보 검사(pii.ts)도 같은 성씨·제외 목록을 씁니다
export const SURNAMES = '김이박최정강조윤장임한오서신권황안송전홍'
export const NAME_STOP = [
  '전체', '이번', '고학년', '신입', '한국', '전학', '오늘', '한결같', '이야기', '정확성', '전체적', '안정감', '이해력', '장단점', '한글', '홍보', '장애', '이웃', '한국어', '한국인', '한글날', '오늘날', '홍보물',
  // 교과에 자주 나오는 3음절 낱말
  '한반도', '강수량', '최솟값', '최댓값', '전자석', '전동기', '전라도', '장애물', '신호등', '오각형', '이등변', '강아지', '한라산', '안내문', '서술형', '전통적', '정다면',
  // 평가계획·행발·창체에 자주 나오는 말
  '성취기준', '수행평가', '자기평가', '동료평가', '학습지', '보고서', '발표회', '체험학습', '모둠활동', '협동학습', '문제해결', '의사소통', '자기주도', '배려심', '책임감', '적극성', '창의성',
  '이해도', '전개도', '전시회', '정의적', '정보화', '이주민', '이민자', '안정성', '정지선', '한살이', '한살', '강낭콩', '서식지', '신문지', '황무지', '강우량', '정치가', '임금님', '한자어', '장애인', '조선', '조상들',
  '전교', '전입', '전출', '이주', '한부모', '신규', '신청', '임원', '이들', '이러한', '이런', '이와', '이후', '이전', '이상', '이하', '오대', '정해진', '한가지', '서로', '조금', '전혀', '정말', '이미',
  '안전', '한마음', '한마당', '한가위', '전래', '신체',
  // 교과서에 나오는 역사 인물(학생 이름이 아님)
  '이순신', '정약용', '안중근', '장영실', '김정호', '홍길동', '김유신', '강감찬', '윤동주', '한용운', '안창호', '김홍도', '신윤복', '최무선', '장보고', '정몽주',
  '이성계', '이방원', '김대건', '신채호', '안용복', '윤봉길', '이봉창', '최치원', '정도전', '김만덕', '김옥균', '전봉준', '최제우', '홍대용', '박지원', '박제가',
  '김정희', '신숙주', '장수왕', '한석봉', '송시열', '김시민', '권율', '이황', '이이', '김구', '세종', '정조', '김수로', '최영', '이육사', '김소월', '정지용', '윤선도',
]
// "김민수 학생", "이지은 어린이", "홍길동군"
export const NAME_HARD = new RegExp(`(?:^|[\\s,.(])([${SURNAMES}][가-힣]{1,2})\\s?(?:학생|어린이|군|양)(?=[\\s,.)이은는가의을를과와에]|$)`, 'g')
// "박지민은", "최서연이는" (3음절 + 조사)
const NAME_SOFT = new RegExp(`(?:^|[\\s,.(])([${SURNAMES}][가-힣]{2})(?:이가|이는|이의|이를|이와|이|은|는|가)(?=[\\s,.]|$)`, 'g')
const names = (re: RegExp, t: string) =>
  [...t.matchAll(re)].map((m) => m[1]).filter((w) => !NAME_STOP.includes(w))
const SUBJECT_RE = /(^|\s)(그는|그녀는|학생은|본인은|이 학생은)(\s|$)/

export function validateComment(text: string, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = []
  const t = text.trim()
  if (!t) return [{ level: 'error', code: 'empty', message: '내용이 없습니다' }]

  const sentences = splitSentences(t)
  const bad = sentences.filter((s) => !endsNominal(s))
  if (bad.length) issues.push({ level: 'warn', code: 'ending', message: `명사형 종결이 아닌 문장 ${bad.length}개 ("-함." / "-임.")` })

  const forb = t.match(FORBIDDEN)
  if (forb) {
    const uniq = Array.from(new Set(forb.map(showChar))).join(' ')
    issues.push({ level: 'error', code: 'chars', message: `허용되지 않는 문자: ${uniq}` })
  }

  const bytes = neisBytes(t)
  if (opts.maxBytes && bytes > opts.maxBytes) issues.push({ level: opts.maxBytesLevel ?? 'error', code: 'bytes', message: `${bytes} Bytes · 상한 ${opts.maxBytes} 초과` })

  const hard = names(NAME_HARD, t)
  if (hard.length) issues.push({ level: 'error', code: 'name', message: `사람 이름으로 보이는 표현: ${[...new Set(hard)].join(', ')}` })
  else {
    const soft = names(NAME_SOFT, t)
    if (soft.length) issues.push({ level: 'warn', code: 'name', message: `이름일 수 있는 표현: ${[...new Set(soft)].join(', ')} (확인)` })
  }

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
