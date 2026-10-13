import type { Level, Standard } from '@/lib/types'
import { LEVEL_NAMES } from '@/lib/types'

export const SYSTEM_TEACHER = `당신은 한국 초등학교 담임 교사의 학교생활기록부 작성을 돕는 보조자입니다. 반드시 요청된 JSON만 출력합니다. 설명, 머리말, 코드펜스를 붙이지 않습니다.`

export function endingRule(ending: '함' | '하였음') {
  return ending === '함'
    ? '문장 끝은 반드시 "-함." 또는 "-임." 명사형으로 끝냅니다.'
    : '문장 끝은 반드시 "-하였음." 또는 "-이었음." 명사형으로 끝냅니다.'
}

export const COMMON_RULES = `- 주어(학생 이름, "학생은" 등)는 쓰지 않습니다.
- 특수문자는 온점(.)과 반점(,)만 씁니다(가운뎃점(·)은 허용). 따옴표, 괄호, 느낌표, 물음표, 물결표, 퍼센트 기호, 이모지, 줄바꿈을 쓰지 않습니다.
- 과장된 수식이나 평가 기준에 없는 내용을 지어내지 않습니다.
- 사람 이름, 학교 이름, 지역 이름을 쓰지 않습니다.`

export const PLAN_EXTRACT_PROMPT = `첨부된 "교수학습 및 평가 계획" 문서에서 평가 항목을 빠짐없이 추출하여 아래 JSON 하나로만 출력하세요.

규칙:
- subjects: 문서의 교과 순서를 유지합니다. 교과명은 "국어", "도덕", "사회", "수학", "과학", "실과", "체육", "음악", "미술", "영어" 등 문서 표기 그대로.
- 각 성취기준(standards)마다 다음을 채웁니다. code는 "[6국05-01]" 같은 대괄호 코드. 한 칸에 코드가 두 개 이상이면 하나의 항목으로 묶고 code에 모두 적고 warnings에 그 사실을 적습니다.
- criteria는 반드시 4개 문자열 배열, 순서는 [매우잘함, 잘함, 보통, 노력요함]. 문서가 3단계뿐이면 빈 문자열로 두지 말고 가장 가까운 수준의 문장을 복사하고 warnings에 적습니다.
- 문장은 문서 그대로 옮기되 줄바꿈으로 끊긴 단어는 이어 붙입니다.
- creative(창의적 체험활동): 영역(자율/동아리/진로)별 목표, 평가 요소 목록, 평가 방법, 시기.

출력 형식:
{
  "school": "학교명 또는 빈 문자열",
  "grade": "6학년",
  "semester": "2학기",
  "year": "2025",
  "subjects": [
    {
      "name": "국어",
      "standards": [
        {
          "code": "[6국05-01]",
          "text": "성취기준 본문",
          "unit": "단원명",
          "area": "평가 영역",
          "element": "평가 요소",
          "method": "수업·평가 방법 (대괄호 안의 평가 방법만, 예: 정의적 능력 평가, 논술형)",
          "period": "9월",
          "criteria": ["매우잘함 기준", "잘함 기준", "보통 기준", "노력요함 기준"]
        }
      ]
    }
  ],
  "creative": [
    { "area": "자율", "goal": "목표", "elements": ["평가 요소1", "평가 요소2"], "method": "실기, 포트폴리오", "period": "9월" }
  ],
  "warnings": ["검토가 필요한 항목 설명"]
}`

export function modeAPrompt(stds: Standard[], counts: [number, number, number, number], sentences: 1 | 2, ending: '함' | '하였음') {
  const items = stds.map((s) => ({
    standardId: s.id, code: s.code, text: s.text, element: s.element,
    criteria: { veryGood: s.criteria[0], good: s.criteria[1], average: s.criteria[2], needsEffort: s.criteria[3] },
  }))
  return `다음 성취기준들에 대해 수준별 예시 평어(교과학습발달상황 세부능력 및 특기사항 문장)를 생성하세요.

[입력]
${JSON.stringify(items, null, 1)}

[규칙]
- 각 성취기준마다 수준별 개수: 매우잘함 ${counts[0]}개, 잘함 ${counts[1]}개, 보통 ${counts[2]}개, 노력요함 ${counts[3]}개. 개수를 정확히 지킵니다.
- 각 평어는 ${sentences === 1 ? '1문장' : '2문장'}입니다. 해당 수준의 criteria 문장을 근거로 하고, 그 수준의 핵심 어휘(예: 매우잘함 "매우 정확하게, 구체적으로, 논리적으로", 잘함 "정확하게, 바르게, 적절하게", 보통 "대체로, 대략적으로, 어느 정도", 노력요함 "일부, 교사의 도움을 받아, 안내가 필요함")를 유지합니다.
- 같은 수준 안의 문장끼리 표현과 어순이 서로 달라야 합니다. 평가 요소(element)에 드러난 구체적 활동을 활용합니다.
- ${endingRule(ending)}
${COMMON_RULES}

[출력(JSON만)]
{ "items": [{ "standardId": "...", "levels": { "veryGood": ["..."], "good": ["..."], "average": ["..."], "needsEffort": ["..."] } }] }`
}

export interface StudentSubjectInput {
  subject: string
  items: Array<{ standardId: string; code: string; text: string; element?: string; level: Level; criterion: string }>
}

export function modeBPrompt(student: number, subjects: StudentSubjectInput[], sentences: 1 | 2, ending: '함' | '하였음', avoid: string[], targetBytes = 700) {
  const targetChars = Math.round(targetBytes / 3)
  const data = subjects.map((s) => ({
    subject: s.subject,
    standards: s.items.map((it) => ({ code: it.code, standard: it.text, element: it.element, level: LEVEL_NAMES[it.level], criterion: it.criterion })),
  }))
  return `학생 ${student}번의 교과별 "학기말 종합의견(교과학습발달상황)"을 작성하세요.

[학생 성적 데이터]
${JSON.stringify(data, null, 1)}

[작성 규칙]
1. 교과마다 하나의 문단을 씁니다. 그 교과의 성취기준마다 ${sentences === 1 ? '정확히 1문장' : '정확히 2문장'}을 쓰고, 성취기준 순서대로 이어 붙여 한 문단(줄바꿈 없음)으로 만듭니다. 교과 문단 하나의 분량은 공백 포함 약 ${targetChars}자(한글 1자 = 3Byte 기준 약 ${targetBytes}Byte) 내외로 맞춥니다. 성취기준이 적은 교과는 문장을 조금 더 구체적으로, 많은 교과는 간결하게 써서 분량을 맞춥니다.
2. 각 문장은 해당 성취기준의 level(성취 수준)과 criterion(평가 기준 문장)을 근거로 합니다. 수준의 핵심 어휘를 유지하되 criterion을 그대로 베끼지 말고 자연스럽게 바꿔 씁니다.
   - 매우 잘함: "매우 정확하게", "구체적으로", "논리적으로", "탁월하게", "주도적으로" 등 최상위 표현. 적용·창의적 사고를 드러냄.
   - 잘함: "정확하게", "바르게", "적절하게", "알맞게". 오류 없이 무난하게 수행. "매우" 같은 최상급은 쓰지 않음.
   - 보통: "대체로", "대략적으로", "어느 정도", "부분적으로", "노력함". 핵심은 이해했으나 정확도가 다소 낮음.
   - 노력 요함: "일부", "교사의 도움을 받아", "안내가 필요함", "하려고 노력함". 격려하는 어조.
3. ${endingRule(ending)}
${COMMON_RULES}
${avoid.length ? `4. 다음 문장들은 다른 학생에게 이미 쓴 문장입니다. 같은 문장이나 어순만 바꾼 문장을 쓰지 말고 표현을 달리하세요:\n${avoid.map((a) => '- ' + a).join('\n')}` : ''}

[출력(JSON만)]
{ "student": ${student}, "subjects": [ { "subject": "국어", "text": "문장1. 문장2." } ] }`
}

export function behaviorPrompt(students: Array<{ id: number; traits: Array<{ name: string; status: string }> }>, targetBytes: number, ending: '함' | '하였음') {
  const minChars = Math.floor((targetBytes - 60) / 3)
  const maxChars = Math.floor((targetBytes + 90) / 3)
  return `담임 교사로서 학생별 "행동특성 및 종합의견"을 작성하세요. 학생은 출석번호로만 구분합니다.

[데이터]
${JSON.stringify(students, null, 1)}

[규칙]
1. 분량: 공백 포함 ${minChars}~${maxChars}자 (한글 1자 = 3Byte 기준 약 ${targetBytes}Byte).
2. 긍정(status "긍정") 특성은 구체적 행동 사례와 함께 서술하고, 지도필요(status "지도필요") 특성은 성장 가능성을 담아 완곡하게 서술합니다. 학습·인성·예체능 순으로 자연스럽게 잇습니다.
3. ${endingRule(ending)}
${COMMON_RULES}
4. 학생마다 서로 다른 표현을 사용합니다. 같은 문장을 반복하지 않습니다.
5. 특성 이름을 그대로 옮겨 적지 말고 행동으로 풀어 씁니다.

[출력(JSON만)]
{ "items": [{ "id": 1, "text": "..." }] }`
}

export function creativePrompt(inputs: Array<{ text: string; count: number }>, ending: '함' | '하였음') {
  return `입력된 창의적 체험활동 특기사항 문장과 뜻이 같되 표현이 다른 문장을 생성하세요.

[입력]
${JSON.stringify(inputs, null, 1)}

[규칙]
1. 항목마다 count 개수만큼 정확히 생성합니다.
2. 원문의 활동과 긍정적 맥락을 유지하되 어휘, 어순, 강조점을 서로 다르게 합니다.
3. ${endingRule(ending)}
${COMMON_RULES}

[출력(JSON만)]
{ "items": [{ "original": "...", "variations": ["...", "..."] }] }`
}
