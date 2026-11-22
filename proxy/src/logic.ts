// 프록시의 순수 로직(한도·비용·요청 정리). Worker 런타임 없이 테스트할 수 있게 분리합니다.

export const MODEL = 'claude-sonnet-5-5'
/** Sonnet 5.5 표준 단가(USD / 1M tokens) */
export const PRICE = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
export const MAX_TOKENS = 16000

export const LIMITS = {
  month: 150, // 전체 한 달
  day: 11, // 전체 하루
  deviceDay: 1, // 기기 하루
  deviceMonth: 2.5, // 기기 한 달
  ipDay: 5, // IP 하루(학교는 한 IP를 여러 교사가 같이 쓰므로 기기보다 넉넉히)
} as const

export const BUDGET_MESSAGE = '사용량 초과로 개별 API 키 준비가 필요합니다.'

/** 한국 시간 기준 날짜·달. 한도는 매일 0시, 매달 1일 0시(KST)에 새로 시작합니다 */
export function kstPeriods(now: Date) {
  const k = new Date(now.getTime() + 9 * 3600_000).toISOString()
  return { day: k.slice(0, 10), month: k.slice(0, 7) }
}

export interface BudgetKey {
  key: string
  limit: number
}

export function budgetKeys(device: string, ipHash: string, now: Date): BudgetKey[] {
  const { day, month } = kstPeriods(now)
  return [
    { key: `m:${month}`, limit: LIMITS.month },
    { key: `d:${day}`, limit: LIMITS.day },
    { key: `dd:${device}:${day}`, limit: LIMITS.deviceDay },
    { key: `dm:${device}:${month}`, limit: LIMITS.deviceMonth },
    { key: `id:${ipHash}:${day}`, limit: LIMITS.ipDay },
  ]
}

export function costOf(usage: any): number {
  if (!usage) return 0
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0)
  return (
    n(usage.input_tokens) * PRICE.input +
    n(usage.output_tokens) * PRICE.output +
    n(usage.cache_read_input_tokens) * PRICE.cacheRead +
    n(usage.cache_creation_input_tokens) * PRICE.cacheWrite
  ) / 1e6
}

export const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/

/** 클라이언트가 보낸 본문에서 system·messages·max_tokens만 받고 모델·사고 설정은 서버가 정합니다 */
export function sanitize(body: any): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: '본문이 JSON 객체가 아닙니다' }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { ok: false, error: 'messages 가 없습니다' }
  if (body.stream) return { ok: false, error: 'stream 은 지원하지 않습니다' }
  const out: Record<string, unknown> = {
    model: MODEL,
    max_tokens: Math.max(1, Math.min(Number(body.max_tokens) || 8192, MAX_TOKENS)),
    messages: body.messages,
    thinking: { type: 'between_tools' },
  }
  if (typeof body.system === 'string') out.system = body.system
  return { ok: true, body: out }
}
