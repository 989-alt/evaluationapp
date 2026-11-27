// 일괄 생성 보조(순수 함수). 응답이 길이 제한에 잘리면 묶음을 반으로 나눠 다시 요청합니다.
// 노드 시험(tests/split.test.ts)이 직접 불러오므로 다른 모듈을 import하지 않습니다.

/** 공급자 출력 상한(Anthropic 16000)에 맞춘 최대값 */
export const MAX_OUT = 16000
const cap = (n: number) => Math.min(MAX_OUT, Math.round(n))

/**
 * 행발 묶음의 출력 상한. 한국어는 글자당 토큰이 많고(3으로 어림), 중계 서버는 사고(thinking)가
 * 같은 상한을 나눠 쓰므로 바닥 6000을 둡니다. 글자 수는 behaviorPrompt의 상한((목표+150)/3자)과 같습니다.
 */
export function behaviorTokens(count: number, targetBytes: number): number {
  const chars = Math.ceil((targetBytes + 150) / 3)
  return cap(6000 + count * (chars * 3 + 40))
}

/** 창체 요청의 출력 상한: 원문을 되풀이하고 변형 문장을 개수만큼 씁니다(변형은 원문의 1.5배 길이로 어림) */
export function creativeTokens(inputs: Array<{ text: string; count: number }>): number {
  return cap(6000 + inputs.reduce((a, x) => a + x.text.length * 3 + 30 + x.count * (x.text.length * 4.5 + 30), 0))
}

/** LLMError.truncated(길이 제한·JSON 잘림)인지 */
export const isTruncated = (e: unknown) => (e as { truncated?: boolean } | null)?.truncated === true

/** 목록을 반으로 가릅니다. 1개 이하는 더 못 나눕니다 */
export function halve<T>(items: T[]): [T[], T[]] | null {
  if (items.length < 2) return null
  const h = Math.ceil(items.length / 2)
  return [items.slice(0, h), items.slice(h)]
}

/** 창체용: 항목이 여러 개면 반으로, 하나면 그 항목의 개수를 반으로 나눕니다 */
export function splitByCount<T extends { count: number }>(items: T[]): [T[], T[]] | null {
  const parts = halve(items)
  if (parts) return parts
  const j = items[0]
  if (!j || j.count < 2) return null
  const a = Math.ceil(j.count / 2)
  return [[{ ...j, count: a }], [{ ...j, count: j.count - a }]]
}

/**
 * call(items)가 "잘림" 오류를 내면 items를 나눠 각각 다시 부르고 결과를 순서대로 합칩니다.
 * 더 못 나누면(1개) 오류를 그대로 던집니다. 잘림이 아닌 오류와 중지는 나누지 않고 그대로 던집니다.
 */
export async function runSplitting<T, R>(
  items: T[],
  call: (group: T[]) => Promise<R[]>,
  opts: { split?: (items: T[]) => [T[], T[]] | null; onSplit?: (group: T[]) => void | Promise<void> } = {},
): Promise<R[]> {
  try {
    return await call(items)
  } catch (e) {
    const parts = isTruncated(e) ? (opts.split ?? halve)(items) : null
    if (!parts) throw e
    await opts.onSplit?.(items)
    const first = await runSplitting(parts[0], call, opts)
    return [...first, ...(await runSplitting(parts[1], call, opts))]
  }
}
