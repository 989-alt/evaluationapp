// NEIS counts Korean as 3 bytes, ASCII as 1
export function neisBytes(str: string): number {
  let n = 0
  for (const ch of str) n += ch.charCodeAt(0) > 127 ? 3 : 1
  return n
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.。])\s+|(?<=[.。])$/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

/** 클립보드에 복사합니다. 실패하면 false */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  }
}

/** djb2. CopyText id에 붙여 문장이 바뀌면 "복사됨" 표시도 새로 시작하게 합니다 */
export function hash(t: string) {
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 줄바꿈과 연속 공백을 공백 하나로 합칩니다 */
export const flatten = (t: unknown) => String(t ?? '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()

/** signal이 중지되면 (reject 없이) 바로 끝납니다 */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}
