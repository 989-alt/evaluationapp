// 기본 제공 키 프록시. 키는 Worker secret(ANTHROPIC_API_KEY)에만 있고, 사용액은 Durable Object 하나가 셉니다.
import { DurableObject } from 'cloudflare:workers'
import { BUDGET_MESSAGE, budgetKeys, costOf, DEVICE_RE, sanitize, type BudgetKey, kstPeriods } from './logic'

export interface Env {
  ANTHROPIC_API_KEY: string
  BUDGET: DurableObjectNamespace<Budget>
  ALLOWED_ORIGINS: string // 쉼표로 구분
}

const MAX_BODY = 32 * 1024 * 1024

export class Budget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS spend (k TEXT PRIMARY KEY, usd REAL NOT NULL)')
  }

  /** 한도에 닿은 키가 있으면 true */
  blocked(keys: BudgetKey[]): boolean {
    for (const { key, limit } of keys) {
      const row = this.ctx.storage.sql.exec<{ usd: number }>('SELECT usd FROM spend WHERE k = ?', key).toArray()[0]
      if (row && row.usd >= limit) return true
    }
    return false
  }

  add(keys: BudgetKey[], usd: number, month: string): void {
    if (!(usd > 0)) return
    // 그 달의 첫 사용이면 지난 달 줄을 정리합니다
    if (!this.ctx.storage.sql.exec('SELECT 1 FROM spend WHERE k = ?', `m:${month}`).toArray().length) this.prune(month)
    for (const { key } of keys) {
      this.ctx.storage.sql.exec('INSERT INTO spend (k, usd) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET usd = usd + excluded.usd', key, usd)
    }
  }

  /** 지난 달 이전 줄은 지웁니다(키에 날짜·달이 들어 있어 문자열 비교로 충분) */
  prune(month: string): void {
    for (const row of this.ctx.storage.sql.exec<{ k: string }>('SELECT k FROM spend').toArray()) {
      const m = row.k.match(/(\d{4}-\d{2})(-\d{2})?$/)
      if (m && m[1] < month) this.ctx.storage.sql.exec('DELETE FROM spend WHERE k = ?', row.k)
    }
  }
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  const ok = origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))
  return ok
    ? { 'Access-Control-Allow-Origin': origin!, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-device-id', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : {}
}

function json(status: number, data: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

const apiError = (status: number, type: string, message: string, h: Record<string, string>) => json(status, { type: 'error', error: { type, message } }, h)

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const h = cors(req.headers.get('Origin'), env)
    if (req.method === 'OPTIONS') return new Response(null, { status: h['Access-Control-Allow-Origin'] ? 204 : 403, headers: h })
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') return apiError(404, 'not_found_error', '없는 경로입니다', h)
    // 브라우저 밖 호출은 Origin 을 속일 수 있어 완전한 차단은 아닙니다. 실제 벽은 아래 사용액 한도입니다
    if (!h['Access-Control-Allow-Origin']) return apiError(403, 'permission_error', '허용되지 않은 출처입니다', h)

    const device = req.headers.get('x-device-id') ?? ''
    if (!DEVICE_RE.test(device)) return apiError(400, 'invalid_request_error', '기기 식별값이 없습니다', h)
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return apiError(413, 'request_too_large', '파일이 너무 큽니다(32MB 이하)', h)

    const ipHash = await sha256(req.headers.get('CF-Connecting-IP') ?? 'unknown')
    const now = new Date()
    const keys = budgetKeys(device, ipHash, now)
    const budget = env.BUDGET.get(env.BUDGET.idFromName('global'))
    // shortcut: 확인과 차감 사이에 동시 요청이 몇 건 더 통과할 수 있음(건당 수 센트). 정확히 막아야 하면 예약 차감으로 바꿀 것
    if (await budget.blocked(keys)) return apiError(402, 'budget_exceeded', BUDGET_MESSAGE, h)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return apiError(400, 'invalid_request_error', '본문이 JSON 이 아닙니다', h)
    }
    const clean = sanitize(body)
    if (!clean.ok) return apiError(400, 'invalid_request_error', clean.error, h)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(clean.body),
    })
    const text = await res.text()
    let usd = 0
    try {
      usd = costOf(JSON.parse(text)?.usage)
    } catch {
      // 오류 응답 등 usage 가 없으면 0
    }
    if (usd > 0) {
      ctx.waitUntil(budget.add(keys, usd, kstPeriods(now).month))
    }
    return new Response(text, { status: res.status, headers: { ...h, 'Content-Type': 'application/json' } })
  },
} satisfies ExportedHandler<Env>

