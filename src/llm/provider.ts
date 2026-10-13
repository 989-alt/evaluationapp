import type { ModelInfo, Provider } from '@/lib/types'
import { delay } from '@/lib/text'

export interface GenerateOptions {
  system?: string
  prompt: string
  /** base64 PDF (no data: prefix). Google/Anthropic take it natively; OpenAI gets extracted text instead */
  pdfBase64?: string
  pdfText?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export class LLMError extends Error {
  constructor(message: string, public status?: number, public retryable = false) {
    super(message)
  }
}

export function detectProvider(key: string): Provider | null {
  const k = key.trim()
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (k.startsWith('AIza')) return 'google'
  if (k.startsWith('sk-')) return 'openai'
  return null
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google (Gemini)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
}

export const PROVIDER_PDF: Record<Provider, boolean> = { google: true, anthropic: true, openai: false }

// ---------- model listing ----------

export async function listModels(provider: Provider, key: string): Promise<ModelInfo[]> {
  switch (provider) {
    case 'google': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`)
      if (!res.ok) throw new LLMError(await errText(res, '모델 목록을 불러오지 못했습니다'), res.status)
      const data = await res.json()
      const models: ModelInfo[] = (data.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName ?? m.name, pdf: true }))
      return rankGoogle(models)
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      })
      if (!res.ok) throw new LLMError(await errText(res, '모델 목록을 불러오지 못했습니다'), res.status)
      const data = await res.json()
      const models: ModelInfo[] = (data.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name ?? m.id, pdf: true }))
      return rankAnthropic(models)
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } })
      if (!res.ok) throw new LLMError(await errText(res, '모델 목록을 불러오지 못했습니다'), res.status)
      const data = await res.json()
      const models: ModelInfo[] = (data.data ?? [])
        .map((m: any) => ({ id: String(m.id), name: String(m.id), pdf: false }))
        .filter((m: ModelInfo) => /^(gpt|o\d)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|embedding|moderation|search|instruct|dall)/.test(m.id))
      return rankOpenAI(models)
    }
  }
}

function rankGoogle(models: ModelInfo[]): ModelInfo[] {
  const ver = (id: string) => parseFloat((id.match(/(\d+\.\d+)/) ?? ['0', '0'])[1])
  const text = models.filter((m) => /gemini/.test(m.id) && !/(image|tts|audio|embedding|live|native-audio|computer)/.test(m.id))
  text.sort((a, b) => ver(b.id) - ver(a.id) || a.id.localeCompare(b.id))
  const top = ver(text[0]?.id ?? '0')
  const flash = text.find((m) => /flash/.test(m.id) && !/lite/.test(m.id) && ver(m.id) >= top - 0.6)
  const lite = text.find((m) => /lite/.test(m.id))
  const pro = text.find((m) => /pro/.test(m.id))
  return text.map((m) => ({
    ...m,
    tier: m.id === flash?.id ? 'recommended' : m.id === lite?.id ? 'fast' : m.id === pro?.id ? 'best' : 'other',
    note: m.id === flash?.id ? '빠르고 정확 · PDF 입력 가능' : m.id === lite?.id ? '가장 저렴 · 긴 평가계획 추출에는 비권장' : m.id === pro?.id ? '문장 품질 최고 · 분당 요청 제한이 낮아 대기가 깁니다' : undefined,
  }))
}

function rankAnthropic(models: ModelInfo[]): ModelInfo[] {
  const pick = (re: RegExp) => models.find((m) => re.test(m.id))
  const opus = pick(/opus-5-5/) ?? pick(/opus/)
  const sonnet = pick(/sonnet-5-5/) ?? pick(/sonnet/)
  const haiku = pick(/haiku-5-5/) ?? pick(/haiku/)
  return models.map((m) => ({
    ...m,
    tier: m.id === opus?.id ? 'recommended' : m.id === haiku?.id ? 'fast' : m.id === sonnet?.id ? 'best' : 'other',
    note: m.id === opus?.id ? '한국어 문장 품질 최고 · PDF 입력 가능' : m.id === sonnet?.id ? '빠르고 품질 좋음 · PDF 입력 가능' : m.id === haiku?.id ? '가장 저렴하고 빠름' : undefined,
  }))
}

function rankOpenAI(models: ModelInfo[]): ModelInfo[] {
  const sorted = [...models].sort((a, b) => b.id.localeCompare(a.id))
  const main = sorted.find((m) => /^gpt-\d+(\.\d+)?$/.test(m.id)) ?? sorted.find((m) => /^gpt-/.test(m.id))
  const mini = sorted.find((m) => /mini$/.test(m.id))
  return sorted.map((m) => ({
    ...m,
    tier: m.id === main?.id ? 'recommended' : m.id === mini?.id ? 'fast' : 'other',
    note: m.id === main?.id ? 'PDF는 앱이 텍스트로 변환해 전송' : m.id === mini?.id ? '저렴 · PDF는 텍스트로 변환' : undefined,
  }))
}

async function errText(res: Response, fallback: string) {
  try {
    const j = await res.json()
    return j?.error?.message ?? j?.message ?? fallback
  } catch {
    return `${fallback} (${res.status})`
  }
}

// ---------- generation ----------

export interface Client {
  provider: Provider
  key: string
  model: string
}

export async function generateJSON<T = unknown>(c: Client, o: GenerateOptions, retry = 0): Promise<T> {
  try {
    const raw = await generateText(c, o)
    return parseJSON<T>(raw)
  } catch (e: any) {
    if (o.signal?.aborted) throw e
    if (e instanceof LLMError && e.retryable && retry < 3) {
      const wait = e.status === 429 ? (/pro/.test(c.model) ? 35000 : 12000) + retry * 6000 : 3000 * (retry + 1)
      await delay(wait)
      return generateJSON<T>(c, o, retry + 1)
    }
    if (e instanceof SyntaxError) throw new LLMError('AI 응답이 올바른 JSON이 아니거나 중간에 잘렸습니다. 생성 개수를 줄이거나 다시 시도해 주세요.')
    throw e
  }
}

function parseJSON<T>(raw: string): T {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const first = s.search(/[\[{]/)
  if (first > 0) s = s.slice(first)
  const lastObj = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  if (lastObj > 0) s = s.slice(0, lastObj + 1)
  return JSON.parse(s) as T
}

export async function generateText(c: Client, o: GenerateOptions): Promise<string> {
  const temperature = o.temperature ?? 0.7
  const maxTokens = o.maxTokens ?? 8192
  switch (c.provider) {
    case 'google': {
      const parts: any[] = []
      if (o.pdfBase64) parts.push({ inline_data: { mime_type: 'application/pdf', data: o.pdfBase64 } })
      parts.push({ text: o.prompt })
      const body: any = {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }
      if (o.system) body.systemInstruction = { parts: [{ text: o.system }] }
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${c.model}:generateContent?key=${encodeURIComponent(c.key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: o.signal,
      })
      await check(res)
      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? ''
      if (!text) throw new LLMError(data?.promptFeedback?.blockReason ? `요청이 차단되었습니다: ${data.promptFeedback.blockReason}` : 'AI 응답이 비어 있습니다')
      return text
    }
    case 'anthropic': {
      const content: any[] = []
      if (o.pdfBase64) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: o.pdfBase64 } })
      content.push({ type: 'text', text: o.prompt })
      const body: any = { model: c.model, max_tokens: Math.min(maxTokens, 16000), messages: [{ role: 'user', content }] }
      if (o.system) body.system = o.system
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body), signal: o.signal,
      })
      await check(res)
      const data = await res.json()
      if (data.stop_reason === 'refusal') throw new LLMError('모델이 요청을 거절했습니다. 입력 내용을 확인해 주세요.')
      const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      if (!text) throw new LLMError('AI 응답이 비어 있습니다')
      return text
    }
    case 'openai': {
      const userText = (o.pdfText ? `[첨부 문서 텍스트]\n${o.pdfText}\n\n` : '') + o.prompt
      const messages: any[] = []
      if (o.system) messages.push({ role: 'system', content: o.system })
      messages.push({ role: 'user', content: userText })
      const body: any = { model: c.model, messages, response_format: { type: 'json_object' } }
      if (!/^o\d|gpt-5/.test(c.model)) body.temperature = temperature
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` }, body: JSON.stringify(body), signal: o.signal,
      })
      await check(res)
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content ?? ''
      if (!text) throw new LLMError('AI 응답이 비어 있습니다')
      return text
    }
  }
}

async function check(res: Response) {
  if (res.ok) return
  const msg = await errText(res, `서버 오류 (${res.status})`)
  if (res.status === 429) throw new LLMError(`사용량 제한(429): ${msg}`, 429, true)
  if (res.status >= 500) throw new LLMError(msg, res.status, true)
  if (res.status === 401 || res.status === 403) throw new LLMError(`API 키가 거부되었습니다: ${msg}`, res.status)
  if (res.status === 404) throw new LLMError(`모델을 사용할 수 없습니다: ${msg}`, res.status)
  throw new LLMError(msg, res.status)
}
